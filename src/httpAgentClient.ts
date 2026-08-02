import { WebSocket } from "ws";
import { AgentClient, AgentJobAccepted, AgentJobRequest, AgentLogFrame, DeleteCheckoutJobPayload, DeployJobPayload, DetectTraefikJobPayload, DiagnoseTraefikJobPayload, InspectCheckoutBindMountsJobPayload, InspectComposeJobPayload, InspectStatusJobPayload, RuntimeActionJobPayload, RuntimeLogsJobPayload, ValidateComposeJobPayload } from "./agentTypes.js";
import { openEnvelope, sealEnvelope, SecureEnvelope } from "./agentCrypto.js";
import { CheckoutCleanupResult } from "./checkoutCleanup.js";
import { ImportedCompose } from "./composeImport.js";
import { DeploymentHooks, RuntimeLogHooks, RuntimeLogStream } from "./deploy.js";
import { ControllerKeyState } from "./keyStore.js";
import { GlobalSettings, ProjectSettings, RuntimeServiceAction, ServerRecord } from "./types.js";

/**
 * Controller-side client for a remote Deploy agent.
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
        hooks.onAccepted?.({ jobId: accepted.jobId, streamToken: accepted.streamToken });
        return this.connectLogStream(accepted, hooks);
    }

    /**
     * Reattaches to a previously accepted remote deployment job after the
     * controller restarted.
     */
    reconnectDeploymentLog(jobId: string, streamToken: string, hooks: DeploymentHooks = {}) {
        return this.connectLogStream({ jobId, streamToken, status: "accepted" }, hooks);
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
     * Inspects normalized Compose configuration through a remote agent.
     */
    async inspectCompose(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings) {
        const accepted = await this.postJob<{ result: Awaited<ReturnType<AgentClient["inspectCompose"]>> }>({
            jobType: "inspectCompose",
            payload: { projectName, appSettings, globalSettings } satisfies InspectComposeJobPayload
        });
        return accepted.result;
    }

    /**
     * Validates effective Compose YAML through a remote agent.
     */
    async validateCompose(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings) {
        const accepted = await this.postJob<{ result: Awaited<ReturnType<AgentClient["validateCompose"]>> }>({
            jobType: "validateCompose",
            payload: { projectName, appSettings, globalSettings } satisfies ValidateComposeJobPayload
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
     * Checks whether running containers still bind mount a checkout path.
     */
    async inspectCheckoutBindMounts(checkoutPath: string) {
        const accepted = await this.postJob<{ result: Awaited<ReturnType<AgentClient["inspectCheckoutBindMounts"]>> }>({
            jobType: "inspectCheckoutBindMounts",
            payload: { checkoutPath } satisfies InspectCheckoutBindMountsJobPayload
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
     * Exports Traefik config files through a remote target server.
     */
    async backupTraefik(serverId: string, globalSettings: GlobalSettings) {
        const accepted = await this.postJob<{ result: Awaited<ReturnType<AgentClient["backupTraefik"]>> }>({
            jobType: "backupTraefik",
            payload: { serverId, globalSettings } satisfies DetectTraefikJobPayload
        });
        return accepted.result;
    }

    /**
     * Validates Traefik config files through a remote target server.
     */
    async validateTraefik(serverId: string, globalSettings: GlobalSettings) {
        const accepted = await this.postJob<{ result: Awaited<ReturnType<AgentClient["validateTraefik"]>> }>({
            jobType: "validateTraefik",
            payload: { serverId, globalSettings } satisfies DetectTraefikJobPayload
        });
        return accepted.result;
    }

    /**
     * Diagnoses Traefik routing through a remote target server.
     */
    async diagnoseTraefik(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings) {
        const accepted = await this.postJob<{ result: Awaited<ReturnType<AgentClient["diagnoseTraefik"]>> }>({
            jobType: "diagnoseTraefik",
            payload: { projectName, appSettings, globalSettings } satisfies DiagnoseTraefikJobPayload
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
     * Runs one runtime action through a remote target server.
     */
    async runtimeAction(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings, service: string, action: RuntimeServiceAction) {
        const accepted = await this.postJob<{ result: Awaited<ReturnType<AgentClient["runtimeAction"]>> }>({
            jobType: "runtimeAction",
            payload: { projectName, appSettings, globalSettings, service, action } satisfies RuntimeActionJobPayload
        });
        return accepted.result;
    }

    /**
     * Streams one runtime action through a remote target server until it ends.
     */
    async followRuntimeAction(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings, service: string, action: RuntimeServiceAction, hooks: RuntimeLogHooks = {}): Promise<RuntimeLogStream> {
        const accepted = await this.postJob({
            jobType: "runtimeActionFollow",
            payload: { projectName, appSettings, globalSettings, service, action } satisfies RuntimeActionJobPayload
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
            throw new Error(this.normalizeAgentError(await response.text()));
        }

        const body = await response.json() as { envelope?: SecureEnvelope };
        return this.openAgentEnvelope<AgentJobAccepted & T>(body.envelope);
    }

    /**
     * Opens the short-lived log stream for a deployment job.
     */
    private connectLogStream(accepted: AgentJobAccepted, hooks: DeploymentHooks): RuntimeLogStream {
        const streamUrl = new URL(`${this.requireBaseUrl()}/agent/jobs/${accepted.jobId}/logs`);
        streamUrl.protocol = streamUrl.protocol === "https:" ? "wss:" : "ws:";
        streamUrl.searchParams.set("streamToken", accepted.streamToken);

        let socket: WebSocket | undefined;
        let finished = false;
        let stopped = false;
        let socketOpen = false;
        let pollOffset = 0;
        let reconnects = 0;
        let missingPolls = 0;
        let unavailablePolls = 0;
        let reportedUnavailable = false;
        let pollTimer: NodeJS.Timeout | undefined;
        const reportLostJob = (message: string) => {
            const failure = new Error(message) as Error & { code?: string };
            failure.code = "remote-agent-job-lost";
            hooks.onFailure?.(failure);
            stopped = true;
            socket?.close();
        };
        const handleFrame = (frame: AgentLogFrame) => {
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
                socket?.close();
            }
        };
        const pollLogs = async () => {
            if (finished || stopped) {
                return;
            }

            try {
                if (socketOpen) {
                    return;
                }
                const pollUrl = new URL(`${this.requireBaseUrl()}/agent/jobs/${accepted.jobId}/logs`);
                pollUrl.searchParams.set("streamToken", accepted.streamToken);
                pollUrl.searchParams.set("after", String(pollOffset));
                const response = await fetch(pollUrl);
                if (!response.ok) {
                    if (response.status === 404 && pollOffset > 0) {
                        missingPolls += 1;
                        if (missingPolls >= 3) {
                            reportLostJob("Remote agent restarted and forgot the deployment log stream.");
                            return;
                        }
                        return;
                    }
                    throw new Error(await response.text());
                }
                missingPolls = 0;
                unavailablePolls = 0;
                reportedUnavailable = false;
                const body = await response.json() as { next?: number; frames?: SecureEnvelope[] };
                for (const envelope of body.frames ?? []) {
                    handleFrame(this.openAgentEnvelope<AgentLogFrame>(envelope));
                }
                pollOffset = typeof body.next === "number" ? body.next : pollOffset + (body.frames?.length ?? 0);
            } catch (error) {
                if (pollOffset > 0) {
                    unavailablePolls += 1;
                    if (!reportedUnavailable) {
                        hooks.onOutput?.("stdout", "--> Remote agent is temporarily unavailable; waiting for it to come back.\n");
                        reportedUnavailable = true;
                    }
                    if (unavailablePolls >= 30) {
                        reportLostJob("Remote agent stayed unavailable while deployment log stream was reconnecting.");
                        return;
                    }
                } else {
                    hooks.onOutput?.("stderr", `--> Remote agent log polling failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
                }
            } finally {
                if (!finished && !stopped) {
                    pollTimer = setTimeout(pollLogs, 2000);
                }
            }
        };
        const connect = () => {
            if (finished || stopped) {
                return;
            }

            streamUrl.searchParams.set("after", String(pollOffset));
            const nextSocket = new WebSocket(streamUrl);
            socket = nextSocket;
            nextSocket.on("open", () => {
                socketOpen = true;
            });
            nextSocket.on("message", (raw) => {
                try {
                    handleFrame(this.openAgentEnvelope<AgentLogFrame>(JSON.parse(String(raw)) as SecureEnvelope));
                    pollOffset += 1;
                } catch (error) {
                    hooks.onOutput?.("stderr", `--> Remote agent log frame failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
                    nextSocket.close();
                }
            });
            nextSocket.on("error", (error) => {
                if (!reportedUnavailable) {
                    hooks.onOutput?.("stdout", `--> Remote agent log stream interrupted; reconnecting.\n`);
                    reportedUnavailable = true;
                }
            });
            nextSocket.on("close", () => {
                socketOpen = false;
                if (!finished && !stopped && reconnects < 5) {
                    reconnects += 1;
                    setTimeout(connect, 1000 * reconnects);
                }
            });
        };
        connect();
        pollTimer = setTimeout(pollLogs, 2000);

        return {
            stop() {
                stopped = true;
                if (pollTimer) {
                    clearTimeout(pollTimer);
                }
                finished = true;
                socket?.close();
            }
        };
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
        if (this.server.status === "unpaired") {
            throw new Error(`Remote agent ${this.server.name || this.server.id} is unpaired. Pair this agent before deploying.`);
        }

        if (!this.server.agentPublicEncryptionKey) {
            throw new Error("Remote agent encryption key is missing.");
        }

        return sealEnvelope(payload, {
            senderId: this.controllerKeys.controllerId,
            recipientId: this.server.agentServerId || this.server.id,
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

    private normalizeAgentError(message: string) {
        if (/oaep decoding error|decrypt|decryption|not paired|pair/i.test(message)) {
            return `Remote agent ${this.server.name || this.server.id} pairing is invalid. Pair this agent again before deploying.`;
        }

        return `Agent rejected job: ${message}`;
    }
}
