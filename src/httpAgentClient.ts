import { WebSocket } from "ws";
import { AgentClient, AgentJobAccepted, AgentJobRequest, AgentLogFrame, DeleteCheckoutJobPayload, DeployJobPayload, DetectTraefikJobPayload, InspectStatusJobPayload, RuntimeLogsJobPayload } from "./agentTypes.js";
import { openEnvelope, sealEnvelope, SecureEnvelope } from "./agentCrypto.js";
import { CheckoutCleanupResult } from "./checkoutCleanup.js";
import { ImportedCompose } from "./composeImport.js";
import { DeploymentHooks, RuntimeLogHooks, RuntimeLogStream } from "./deploy.js";
import { ControllerKeyState } from "./keyStore.js";
import { GlobalSettings, ProjectSettings, ServerRecord } from "./types.js";

/**
 * Controller-side client for a remote updater agent.
 */
export class HttpAgentClient implements AgentClient {
    private readonly seenNonces = new Set<string>();

    constructor(
        private readonly server: ServerRecord,
        private readonly controllerKeys: ControllerKeyState
    ) {}

    /**
     * Starts a remote deployment and forwards streamed logs into hooks.
     */
    async deployProject(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings, hooks: DeploymentHooks = {}) {
        const accepted = await this.postJob({
            jobType: "deploy",
            payload: { projectName, appSettings, globalSettings }
        });
        this.connectLogStream(accepted, hooks);
    }

    /**
     * Stops a remote project.
     */
    async stopProject(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings) {
        const accepted = await this.postJob<{ result: string }>({
            jobType: "stop",
            payload: { projectName, appSettings, globalSettings }
        });
        return accepted.result || "";
    }

    /**
     * Imports compose content from a remote agent.
     */
    async importCompose(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings): Promise<ImportedCompose> {
        const accepted = await this.postJob<{ result: ImportedCompose }>({
            jobType: "importCompose",
            payload: { projectName, appSettings, globalSettings } satisfies DeployJobPayload
        });
        return accepted.result;
    }

    /**
     * Deletes a checkout path on a remote agent.
     */
    async deleteCheckout(checkoutPath: string): Promise<CheckoutCleanupResult> {
        const accepted = await this.postJob<{ result: CheckoutCleanupResult }>({
            jobType: "deleteCheckout",
            payload: { checkoutPath } satisfies DeleteCheckoutJobPayload
        });
        return accepted.result;
    }

    /**
     * Detects Traefik on a remote target server.
     */
    async detectTraefik(globalSettings: GlobalSettings) {
        const accepted = await this.postJob<{ result: Awaited<ReturnType<AgentClient["detectTraefik"]>> }>({
            jobType: "detectTraefik",
            payload: { globalSettings } satisfies DetectTraefikJobPayload
        });
        return accepted.result;
    }

    /**
     * Inspects runtime status through a remote target server.
     */
    async inspectStatus(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings) {
        const accepted = await this.postJob<{ result: Awaited<ReturnType<AgentClient["inspectStatus"]>> }>({
            jobType: "inspectStatus",
            payload: { projectName, appSettings, globalSettings } satisfies InspectStatusJobPayload
        });
        return accepted.result;
    }

    /**
     * Reads recent runtime logs through a remote target server.
     */
    async runtimeLogs(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings, service: string, tail: number) {
        const accepted = await this.postJob<{ result: Awaited<ReturnType<AgentClient["runtimeLogs"]>> }>({
            jobType: "runtimeLogs",
            payload: { projectName, appSettings, globalSettings, service, tail } satisfies RuntimeLogsJobPayload
        });
        return accepted.result;
    }

    /**
     * Follows runtime logs through a remote target server until stopped.
     */
    async followRuntimeLogs(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings, service: string, tail: number, hooks: RuntimeLogHooks = {}): Promise<RuntimeLogStream> {
        const accepted = await this.postJob({
            jobType: "runtimeLogsFollow",
            payload: { projectName, appSettings, globalSettings, service, tail } satisfies RuntimeLogsJobPayload
        });
        return this.connectRuntimeLogStream(accepted, hooks);
    }

    /**
     * Sends one encrypted job command to the agent.
     */
    private async postJob<T extends object = object>(request: AgentJobRequest) {
        const response = await fetch(`${this.requireBaseUrl()}/agent/jobs`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                envelope: this.sealAgentEnvelope(request, "job.request")
            })
        });

        if (!response.ok) {
            throw new Error(`Agent rejected job: ${await response.text()}`);
        }

        const body = await response.json() as { envelope?: SecureEnvelope };
        return this.openAgentEnvelope<AgentJobAccepted & T>(body.envelope);
    }

    /**
     * Opens the short-lived log stream for a deployment job.
     */
    private connectLogStream(accepted: AgentJobAccepted, hooks: DeploymentHooks) {
        const streamUrl = new URL(`${this.requireBaseUrl()}/agent/jobs/${accepted.jobId}/logs`);
        streamUrl.protocol = streamUrl.protocol === "https:" ? "wss:" : "ws:";
        streamUrl.searchParams.set("streamToken", accepted.streamToken);

        const socket = new WebSocket(streamUrl);
        let finished = false;
        let failed = false;
        socket.on("message", (raw) => {
            try {
                const frame = this.openAgentEnvelope<AgentLogFrame>(JSON.parse(String(raw)) as SecureEnvelope);
                if (frame.stream === "stdout" || frame.stream === "stderr") {
                    hooks.onOutput?.(frame.stream, frame.chunk);
                }

                if (frame.done) {
                    finished = true;
                    if (frame.success) {
                        hooks.onSuccess?.();
                    } else {
                        const error = new Error(frame.error || frame.chunk) as Error & { code?: string };
                        error.code = "remote-agent";
                        hooks.onFailure?.(error);
                    }
                    socket.close();
                }
            } catch (error) {
                const failure = new Error(error instanceof Error ? error.message : "Could not read remote agent log frame.") as Error & { code?: string };
                failure.code = "remote-agent-stream";
                hooks.onFailure?.(failure);
                socket.close();
            }
        });
        socket.on("error", (error) => {
            failed = true;
            const failure = new Error(error.message) as Error & { code?: string };
            failure.code = "remote-agent-stream";
            hooks.onFailure?.(failure);
        });
        socket.on("close", () => {
            if (!finished && !failed) {
                const failure = new Error("Remote agent log stream closed before the job finished.") as Error & { code?: string };
                failure.code = "remote-agent-stream";
                hooks.onFailure?.(failure);
            }
        });
    }

    /**
     * Opens a remote runtime log stream and returns a cancellation handle.
     */
    private connectRuntimeLogStream(accepted: AgentJobAccepted, hooks: RuntimeLogHooks): RuntimeLogStream {
        const streamUrl = new URL(`${this.requireBaseUrl()}/agent/jobs/${accepted.jobId}/logs`);
        streamUrl.protocol = streamUrl.protocol === "https:" ? "wss:" : "ws:";
        streamUrl.searchParams.set("streamToken", accepted.streamToken);

        const socket = new WebSocket(streamUrl);
        let stopped = false;
        let completed = false;
        socket.on("message", (raw) => {
            try {
                const frame = this.openAgentEnvelope<AgentLogFrame>(JSON.parse(String(raw)) as SecureEnvelope);
                if (frame.stream === "stdout" || frame.stream === "stderr") {
                    hooks.onOutput?.(frame.stream, frame.chunk);
                }

                if (frame.done) {
                    completed = true;
                    if (!frame.success) {
                        hooks.onFailure?.(new Error(frame.error || frame.chunk));
                    }
                    hooks.onClose?.();
                    socket.close();
                }
            } catch (error) {
                hooks.onFailure?.(new Error(error instanceof Error ? error.message : "Could not read remote runtime log frame."));
                socket.close();
            }
        });
        socket.on("error", (error) => {
            if (!stopped) {
                hooks.onFailure?.(error);
            }
        });
        socket.on("close", () => {
            if (!stopped && !completed) {
                hooks.onClose?.();
            }
        });

        return {
            stop() {
                stopped = true;
                socket.close();
            }
        };
    }

    /**
     * Encrypts and signs a payload for this remote agent.
     */
    private sealAgentEnvelope(payload: unknown, messageType: string) {
        if (!this.server.agentPublicEncryptionKey) {
            throw new Error("Remote agent encryption key is missing.");
        }

        return sealEnvelope(payload, {
            senderId: this.controllerKeys.controllerId,
            recipientId: this.server.id,
            messageType
        }, {
            senderSigningPrivateKey: this.controllerKeys.signingPrivateKey,
            recipientEncryptionPublicKey: this.server.agentPublicEncryptionKey
        });
    }

    /**
     * Verifies and decrypts a remote agent response.
     */
    private openAgentEnvelope<T>(envelope: SecureEnvelope | undefined): T {
        if (!envelope || !this.server.agentPublicSigningKey) {
            throw new Error("Remote agent response is missing.");
        }

        if (this.seenNonces.has(envelope.nonce)) {
            throw new Error("Remote agent response nonce was already used.");
        }

        this.seenNonces.add(envelope.nonce);
        return openEnvelope<T>(envelope, this.controllerKeys.controllerId, {
            senderSigningPublicKey: this.server.agentPublicSigningKey,
            recipientEncryptionPrivateKey: this.controllerKeys.encryptionPrivateKey
        });
    }

    /**
     * Returns a configured base URL or throws a readable setup error.
     */
    private requireBaseUrl() {
        if (!this.server.baseUrl) {
            throw new Error("Remote agent base URL is missing.");
        }

        return this.server.baseUrl.replace(/\/+$/, "");
    }
}
