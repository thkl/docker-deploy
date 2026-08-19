import { createServer, Server } from "node:http";
import express, { Express, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { AgentJobAccepted, AgentJobRequest, AgentLogFrame, ApplyTraefikDefaultsJobPayload, DeleteCheckoutJobPayload, DeployJobPayload, DetectTraefikJobPayload, DiagnoseTraefikJobPayload, InspectComposeJobPayload, InspectStatusJobPayload, RuntimeActionJobPayload, RuntimeLogsJobPayload, ValidateComposeJobPayload } from "./agentTypes.js";
import { openEnvelope, sealEnvelope, SecureEnvelope } from "./agentCrypto.js";
import { rememberNonce, ensureAgentState, removeAgentPairingFile, resetAgentPairing, writeAgentPairingFile, writeAgentState, AgentState } from "./keyStore.js";
import { LocalAgent } from "./localAgent.js";
import { RuntimeLogStream } from "./deploy.js";
import { collectSystemMetrics } from "./systemMetrics.js";
import { appVersion } from "./version.js";
import { defaultProjectPath } from "./globalSettingsStore.js";
import { assertSafeDeletePath } from "./checkoutCleanup.js";

const deployRecoveryCleanupDelayMs = 10 * 60 * 1000;

interface AgentJobState {
    id: string;
    type: string;
    startedAt: string;
    active: boolean;
    cancelOnDisconnect: boolean;
    streamToken: string;
    frames: AgentLogFrame[];
    sockets: Set<WebSocket>;
    request?: AgentJobRequest;
    cancel?: () => void;
}

interface PersistedAgentJobState {
    id: string;
    type: string;
    startedAt: string;
    active: boolean;
    cancelOnDisconnect: boolean;
    streamToken: string;
    frames: AgentLogFrame[];
    request?: AgentJobRequest;
}

/**
 * Standalone HTTP/WebSocket runtime for `DEPLOY_ROLE=agent`.
 */
export class AgentRuntime {
    private readonly app: Express = express();
    private readonly port = parseInt(process.env.DEPLOY_AGENT_PORT || process.env.UPDATER_AGENT_PORT || process.env.PORT || "3998");
    private readonly host = process.env.DEPLOY_AGENT_HOST || process.env.UPDATER_AGENT_HOST || "0.0.0.0";
    private readonly localAgent = new LocalAgent();
    private readonly jobs = new Map<string, AgentJobState>();
    private readonly jobsPath = join("./data", "agent-jobs.json");
    private state: AgentState = ensureAgentState();

    /**
     * Starts the agent HTTP API and log WebSocket endpoint.
     */
    start() {
        if (isPairingResetRequested()) {
            this.state = resetAgentPairing(this.state);
            writeAgentState(this.state);
            console.log("Agent pairing reset requested. New pairing data will be written to /app/data/agent-pairing.json.");
        }
        writeAgentPairingFile(this.state);
        this.loadPersistedJobs();
        this.app.use(express.json({ limit: "12mb" }));
        this.registerRoutes();
        const server = createServer(this.app);
        this.registerLogStreams(server);
        server.listen(this.port, this.host, () => {
            console.log(`Deploy agent listening on ${this.host}:${this.port}.`);
            console.log(`Agent server ID: ${this.state.serverId}`);
            if (this.state.controllerPublicEncryptionKey && this.state.controllerPublicSigningKey) {
                console.log("Agent is already paired. Pairing file removed.");
            } else {
                console.log("Agent pairing data written to /app/data/agent-pairing.json.");
            }
            void this.recoverActiveDeployJobs();
        });
    }

    /**
     * Registers health, pairing, and encrypted job endpoints.
     */
    private registerRoutes() {
        this.app.get("/agent/health", async (req: Request, res: Response) => {
            const defaultTraefikNetwork = typeof req.query.traefikNetwork === "string" && req.query.traefikNetwork.trim()
                ? req.query.traefikNetwork.trim()
                : "proxy";
            const paired = Boolean(this.state.controllerPublicEncryptionKey && this.state.controllerPublicSigningKey);
            if (!paired) {
                writeAgentPairingFile(this.state);
            }

            res.json({
                serverId: this.state.serverId,
                paired,
                version: appVersion(),
                activeJobs: [...this.jobs.values()]
                    .filter((job) => job.active)
                    .map((job) => ({ id: job.id, type: job.type, startedAt: job.startedAt })),
                encryptionPublicKey: this.state.encryptionPublicKey,
                signingPublicKey: this.state.signingPublicKey,
                pairedControllerId: this.state.controllerId,
                pairedAt: this.state.pairedAt,
                capabilities: {
                    docker: await this.localAgent.inspectDocker(),
                    traefik: await this.localAgent.detectTraefik({
                        dataRoot: "/root/docker-apps",
                        defaultTraefikNetwork,
                        defaultTraefikEntryPoints: "websecure",
                        defaultTraefikCertResolver: "letsencrypt",
                        sshKeyPath: "~/.ssh",
                        cleanupAfterDeploy: false,
                        autoBackupEnabled: false,
                        autoBackupCron: "0 3 * * *",
                        autoBackupPath: "/root/docker-apps/.updater/backups",
                        registryAddress: "",
                        registryUsername: "",
                        registryPassword: ""
                    }),
                    system: await collectSystemMetrics()
                }
            });
        });

        this.app.post("/agent/pair", (req: Request, res: Response) => {
            try {
                const body = req.body as {
                    controllerId?: string;
                    controllerPublicEncryptionKey?: string;
                    controllerPublicSigningKey?: string;
                    envelope?: SecureEnvelope;
                };

                if (!body.controllerId || !body.controllerPublicEncryptionKey || !body.controllerPublicSigningKey || !body.envelope) {
                    res.status(400).json({ error: "Pairing request is incomplete." });
                    return;
                }

                const payload = openEnvelope<{ pairingToken: string }>(body.envelope, this.state.serverId, {
                    senderSigningPublicKey: body.controllerPublicSigningKey,
                    recipientEncryptionPrivateKey: this.state.encryptionPrivateKey
                });

                if (payload.pairingToken !== this.state.pairingToken) {
                    res.status(403).json({ error: "Pairing token is invalid." });
                    return;
                }

                this.state = {
                    ...this.state,
                    controllerId: body.controllerId,
                    controllerPublicEncryptionKey: body.controllerPublicEncryptionKey,
                    controllerPublicSigningKey: body.controllerPublicSigningKey,
                    pairingToken: randomUUID(),
                    pairedAt: new Date().toISOString()
                };
                writeAgentState(this.state);
                removeAgentPairingFile();
                res.json({ paired: true, serverId: this.state.serverId, pairedAt: this.state.pairedAt });
            } catch (error) {
                res.status(400).json({ error: error instanceof Error ? error.message : "Pairing failed." });
            }
        });

        this.app.post("/agent/jobs", async (req: Request, res: Response) => {
            try {
                const request = this.openControllerEnvelope<AgentJobRequest>((req.body as { envelope?: SecureEnvelope }).envelope);
                const accepted = this.createJob(request);
                const response = await this.startJob(request, accepted);
                if (!isStreamingJob(request.jobType)) {
                    const job = this.jobs.get(accepted.jobId);
                    if (job) {
                        job.active = false;
                    }
                }
                res.json({ envelope: this.sealControllerEnvelope({ ...accepted, ...response }, "job.accepted") });
            } catch (error) {
                res.status(400).json({ error: error instanceof Error ? error.message : "Job failed." });
            }
        });

        this.app.get("/agent/jobs/:id/logs", (req: Request, res: Response) => {
            const jobId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
            const job = this.jobs.get(jobId);
            if (!job || req.query.streamToken !== job.streamToken) {
                res.status(404).json({ error: "Job log stream was not found." });
                return;
            }

            const after = Math.max(0, parseInt(String(req.query.after ?? "0"), 10) || 0);
            res.json({
                active: job.active,
                next: job.frames.length,
                frames: job.frames.slice(after).map((frame) => this.sealControllerEnvelope(frame, "job.log"))
            });
        });
    }

    /**
     * Registers short-lived job log WebSocket streams.
     */
    private registerLogStreams(server: Server) {
        const wss = new WebSocketServer({ noServer: true });
        server.on("upgrade", (request, socket, head) => {
            const url = new URL(request.url || "", `http://${request.headers.host}`);
            const match = url.pathname.match(/^\/agent\/jobs\/([^/]+)\/logs$/);
            if (!match) {
                return;
            }

            const job = this.jobs.get(match[1]);
            if (!job || url.searchParams.get("streamToken") !== job.streamToken) {
                socket.destroy();
                return;
            }

            wss.handleUpgrade(request, socket, head, (ws) => {
                job.sockets.add(ws);
                const after = Math.max(0, parseInt(String(url.searchParams.get("after") ?? "0"), 10) || 0);
                for (const frame of job.frames.slice(after)) {
                    ws.send(JSON.stringify(this.sealControllerEnvelope(frame, "job.log")));
                }
                ws.on("close", () => {
                    job.sockets.delete(ws);
                    if (job.cancelOnDisconnect && job.cancel && job.sockets.size === 0) {
                        job.active = false;
                        job.cancel();
                    }
                });
            });
        });
    }

    /**
     * Starts a local operation for an accepted encrypted job.
     */
    private async startJob(request: AgentJobRequest, accepted: AgentJobAccepted): Promise<{ result?: unknown }> {
        if (request.jobType === "deploy") {
            const payload = request.payload as DeployJobPayload;
            const stream = this.localAgent.deployProject(payload.projectName, payload.appSettings, payload.globalSettings, {
                onOutput: (stream, chunk) => this.emitFrame(accepted.jobId, { stream, chunk }),
                onSuccess: () => this.emitFrame(accepted.jobId, { stream: "status", chunk: "Deployment successful.", done: true, success: true }),
                onFailure: (error) => this.emitFrame(accepted.jobId, { stream: "status", chunk: error.message, done: true, success: false, error: error.message })
            });
            const job = this.jobs.get(accepted.jobId);
            if (job && stream && typeof stream === "object" && "stop" in stream && typeof stream.stop === "function") {
                job.cancel = () => stream.stop();
            }
            return {};
        }

        if (request.jobType === "importCompose") {
            const payload = request.payload as DeployJobPayload;
            return { result: await this.localAgent.importCompose(payload.projectName, payload.appSettings, payload.globalSettings) };
        }

        if (request.jobType === "captureReleaseSnapshot") {
            const payload = request.payload as DeployJobPayload;
            return { result: await this.localAgent.captureReleaseSnapshot(payload.projectName, payload.appSettings, payload.globalSettings) };
        }

        if (request.jobType === "deployReleaseSnapshot") {
            const payload = request.payload as { release: Parameters<LocalAgent["deployReleaseSnapshot"]>[0]; globalSettings: Parameters<LocalAgent["deployReleaseSnapshot"]>[1] };
            const stream = this.localAgent.deployReleaseSnapshot(payload.release, payload.globalSettings, {
                onOutput: (stream, chunk) => this.emitFrame(accepted.jobId, { stream, chunk }),
                onSuccess: () => this.emitFrame(accepted.jobId, { stream: "status", chunk: "Release rollback completed.", done: true, success: true }),
                onFailure: (error) => this.emitFrame(accepted.jobId, { stream: "status", chunk: error.message, done: true, success: false, error: error.message })
            }) as RuntimeLogStream;
            const job = this.jobs.get(accepted.jobId);
            if (job) {
                job.cancel = () => stream.stop();
            }
            return {};
        }

        if (request.jobType === "inspectCompose") {
            const payload = request.payload as InspectComposeJobPayload;
            return { result: await this.localAgent.inspectCompose(payload.projectName, payload.appSettings, payload.globalSettings) };
        }

        if (request.jobType === "validateCompose") {
            const payload = request.payload as ValidateComposeJobPayload;
            return { result: await this.localAgent.validateCompose(payload.projectName, payload.appSettings, payload.globalSettings) };
        }

        if (request.jobType === "stop") {
            const payload = request.payload as DeployJobPayload;
            return { result: await this.localAgent.stopProject(payload.projectName, payload.appSettings, payload.globalSettings) };
        }

        if (request.jobType === "inspectCheckoutBindMounts") {
            const payload = request.payload as DeleteCheckoutJobPayload;
            return { result: await this.localAgent.inspectCheckoutBindMounts(payload.checkoutPath) };
        }

        if (request.jobType === "inspectDocker") {
            return { result: await this.localAgent.inspectDocker() };
        }

        if (request.jobType === "browsePath") {
            const payload = request.payload as { path: string };
            return { result: await this.localAgent.browsePath(payload.path) };
        }

        if (request.jobType === "detectTraefik") {
            const payload = request.payload as DetectTraefikJobPayload;
            return { result: await this.localAgent.detectTraefik(payload.globalSettings) };
        }

        if (request.jobType === "backupTraefik") {
            const payload = request.payload as DetectTraefikJobPayload;
            return { result: await this.localAgent.backupTraefik(payload.serverId || this.state.serverId, payload.globalSettings) };
        }

        if (request.jobType === "validateTraefik") {
            const payload = request.payload as DetectTraefikJobPayload;
            return { result: await this.localAgent.validateTraefik(payload.serverId || this.state.serverId, payload.globalSettings) };
        }

        if (request.jobType === "applyTraefikDefaults") {
            const payload = request.payload as ApplyTraefikDefaultsJobPayload;
            return { result: await this.localAgent.applyTraefikDefaults(payload.serverId || this.state.serverId, payload.globalSettings, payload.defaults) };
        }

        if (request.jobType === "diagnoseTraefik") {
            const payload = request.payload as DiagnoseTraefikJobPayload;
            return { result: await this.localAgent.diagnoseTraefik(payload.projectName, payload.appSettings, payload.globalSettings) };
        }

        if (request.jobType === "inspectStatus") {
            const payload = request.payload as InspectStatusJobPayload;
            return { result: await this.localAgent.inspectStatus(payload.projectName, payload.appSettings, payload.globalSettings) };
        }

        if (request.jobType === "runtimeLogs") {
            const payload = request.payload as RuntimeLogsJobPayload;
            return { result: await this.localAgent.runtimeLogs(payload.projectName, payload.appSettings, payload.globalSettings, payload.service, payload.tail) };
        }

        if (request.jobType === "runtimeLogsFollow") {
            const payload = request.payload as RuntimeLogsJobPayload;
            const stream = await this.localAgent.followRuntimeLogs(payload.projectName, payload.appSettings, payload.globalSettings, payload.service, payload.tail, {
                onOutput: (stream, chunk) => this.emitFrame(accepted.jobId, { stream, chunk }),
                onClose: () => this.emitFrame(accepted.jobId, { stream: "status", chunk: "Runtime log stream closed.", done: true, success: true }),
                onFailure: (error) => this.emitFrame(accepted.jobId, { stream: "status", chunk: error.message, done: true, success: false, error: error.message })
            }) as RuntimeLogStream;
            const job = this.jobs.get(accepted.jobId);
            if (job) {
                job.cancel = () => stream.stop();
            }
            return {};
        }

        if (request.jobType === "runtimeAction") {
            const payload = request.payload as RuntimeActionJobPayload;
            return { result: await this.localAgent.runtimeAction(payload.projectName, payload.appSettings, payload.globalSettings, payload.service, payload.action) };
        }

        if (request.jobType === "runtimeActionFollow") {
            const payload = request.payload as RuntimeActionJobPayload;
            const stream = await this.localAgent.followRuntimeAction(payload.projectName, payload.appSettings, payload.globalSettings, payload.service, payload.action, {
                onOutput: (stream, chunk) => this.emitFrame(accepted.jobId, { stream, chunk }),
                onClose: () => this.emitFrame(accepted.jobId, { stream: "status", chunk: "Runtime action finished.", done: true, success: true }),
                onFailure: (error) => this.emitFrame(accepted.jobId, { stream: "status", chunk: error.message, done: true, success: false, error: error.message })
            }) as RuntimeLogStream;
            const job = this.jobs.get(accepted.jobId);
            if (job) {
                job.cancel = () => stream.stop();
            }
            return {};
        }

        const payload = request.payload as DeleteCheckoutJobPayload;
        return { result: await this.localAgent.deleteCheckout(payload.checkoutPath) };
    }

    /**
     * Creates an in-memory job stream.
     */
    private createJob(request: AgentJobRequest): AgentJobAccepted {
        const job: AgentJobState = {
            id: randomUUID(),
            type: request.jobType,
            startedAt: new Date().toISOString(),
            active: true,
            cancelOnDisconnect: request.jobType !== "deploy",
            streamToken: randomUUID(),
            frames: [],
            sockets: new Set(),
            ...(request.jobType === "deploy" ? { request } : {})
        };
        this.jobs.set(job.id, job);
        this.persistDeployJobs();
        return { jobId: job.id, streamToken: job.streamToken, status: "accepted" };
    }

    /**
     * Emits one log/status frame to connected stream clients.
     */
    private emitFrame(jobId: string, frame: AgentLogFrame) {
        const job = this.jobs.get(jobId);
        if (!job) {
            return;
        }

        job.frames.push(frame);
        job.frames = trimFrames(job.frames);
        if (frame.done) {
            job.active = false;
        }
        this.persistDeployJobs();
        const serialized = JSON.stringify(this.sealControllerEnvelope(frame, "job.log"));
        for (const socket of job.sockets) {
            if (socket.readyState === WebSocket.OPEN) {
                socket.send(serialized);
            }
        }
    }

    /**
     * Reloads persisted deployment jobs so controller log polling can survive
     * an agent self-update.
     */
    private loadPersistedJobs() {
        if (!existsSync(this.jobsPath)) {
            return;
        }

        try {
            const persisted = JSON.parse(readFileSync(this.jobsPath, "utf8")) as PersistedAgentJobState[];
            for (const job of persisted) {
                if (job.type !== "deploy") {
                    continue;
                }
                this.jobs.set(job.id, {
                    id: job.id,
                    type: job.type,
                    startedAt: job.startedAt,
                    active: job.active,
                    cancelOnDisconnect: false,
                    streamToken: job.streamToken,
                    frames: trimFrames(job.frames ?? []),
                    sockets: new Set(),
                    request: job.request
                });
            }
        } catch (error) {
            console.error(`Could not load persisted agent jobs: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Persists deploy job metadata and buffered frames in the agent data volume.
     */
    private persistDeployJobs() {
        const jobs = [...this.jobs.values()]
            .filter((job) => job.type === "deploy")
            .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
            .slice(-20)
            .map((job): PersistedAgentJobState => ({
                id: job.id,
                type: job.type,
                startedAt: job.startedAt,
                active: job.active,
                cancelOnDisconnect: false,
                streamToken: job.streamToken,
                frames: trimFrames(job.frames),
                request: job.request
            }));

        try {
            mkdirSync(dirname(this.jobsPath), { recursive: true });
            writeFileSync(this.jobsPath, `${JSON.stringify(jobs, null, 2)}\n`, { mode: 0o600 });
        } catch (error) {
            console.error(`Could not persist agent jobs: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Completes active deployment jobs that were interrupted by an agent
     * restart. The build worker usually survives long enough to finish the
     * compose replacement; this reconciles by inspecting Docker runtime state.
     */
    private async recoverActiveDeployJobs() {
        for (const job of [...this.jobs.values()].filter((candidate) => candidate.type === "deploy" && candidate.active && candidate.request?.jobType === "deploy")) {
            const payload = job.request?.payload as DeployJobPayload | undefined;
            if (!payload) {
                continue;
            }

            this.emitFrame(job.id, {
                stream: "stdout",
                chunk: "--> Agent restarted before deployment completion was recorded. Rechecking runtime status.\n"
            });

            await delay(8000);
            const status = await this.inspectRecoveredDeployment(payload);
            if (status === "running" || status === "partial") {
                if (Date.now() - Date.parse(job.startedAt) >= deployRecoveryCleanupDelayMs) {
                    await this.cleanupRecoveredDeployment(payload, job.id);
                } else {
                    this.emitFrame(job.id, {
                        stream: "stdout",
                        chunk: "--> Recovery cleanup skipped because the deployment job is recent and may still be finishing build or push steps.\n"
                    });
                }
                this.emitFrame(job.id, {
                    stream: "status",
                    chunk: `Agent recovered deployment after restart. Runtime status is ${status}.`,
                    done: true,
                    success: true
                });
            } else {
                this.emitFrame(job.id, {
                    stream: "status",
                    chunk: `Agent recovered deployment after restart, but runtime status is ${status}.`,
                    done: true,
                    success: false,
                    error: `Runtime status is ${status}.`
                });
            }
        }
    }

    private async inspectRecoveredDeployment(payload: DeployJobPayload) {
        for (let attempt = 0; attempt < 4; attempt += 1) {
            const status = await this.localAgent.inspectStatus(payload.projectName, payload.appSettings, payload.globalSettings);
            if (status.status === "running" || status.status === "partial") {
                return status.status;
            }
            if (attempt < 3) {
                await delay(5000);
            }
        }

        return (await this.localAgent.inspectStatus(payload.projectName, payload.appSettings, payload.globalSettings)).status;
    }

    private async cleanupRecoveredDeployment(payload: DeployJobPayload, jobId: string) {
        if (!payload.globalSettings.cleanupAfterDeploy) {
            this.emitFrame(jobId, { stream: "stdout", chunk: "--> Cleanup after deploy disabled in global settings.\n" });
            return;
        }

        try {
            const projectRoot = payload.appSettings.path ?? defaultProjectPath(payload.globalSettings, payload.projectName);
            const checkoutPath = assertSafeDeletePath(`${projectRoot.replace(/\/+$/, "")}/.updater/tmpdeploy`, payload.globalSettings.dataRoot);
            const releasePath = assertSafeDeletePath(`${projectRoot.replace(/\/+$/, "")}/.updater/release`, payload.globalSettings.dataRoot);
            const inspection = await this.localAgent.inspectCheckoutBindMounts(checkoutPath);
            if (inspection.references.length > 0) {
                this.emitFrame(jobId, {
                    stream: "stdout",
                    chunk: `--> Cleanup skipped: ${inspection.references.length} running bind mount(s) still reference the temporary checkout.\n`
                });
                return;
            }

            const cleanup = await this.localAgent.deleteCheckout(checkoutPath);
            for (const step of cleanup.steps) {
                this.emitFrame(jobId, { stream: "stdout", chunk: `--> ${step}\n` });
            }
            const releaseInspection = await this.localAgent.inspectCheckoutBindMounts(releasePath);
            if (releaseInspection.references.length === 0) {
                const releaseCleanup = await this.localAgent.deleteCheckout(releasePath);
                for (const step of releaseCleanup.steps) {
                    this.emitFrame(jobId, { stream: "stdout", chunk: `--> ${step}\n` });
                }
            } else {
                this.emitFrame(jobId, {
                    stream: "stdout",
                    chunk: `--> Release cleanup skipped: ${releaseInspection.references.length} running bind mount(s) still reference the stable release checkout.\n`
                });
            }
            this.emitFrame(jobId, { stream: "stdout", chunk: "--> Cleanup after deploy completed.\n" });
        } catch (error) {
            this.emitFrame(jobId, {
                stream: "stderr",
                chunk: `--> Cleanup after deploy skipped: ${error instanceof Error ? error.message : String(error)}\n`
            });
        }
    }

    /**
     * Opens and validates a controller-signed envelope.
     */
    private openControllerEnvelope<T>(envelope: SecureEnvelope | undefined): T {
        if (!envelope || !this.state.controllerPublicSigningKey) {
            throw new Error("Agent is not paired with a controller.");
        }

        const payload = openEnvelope<T>(envelope, this.state.serverId, {
            senderSigningPublicKey: this.state.controllerPublicSigningKey,
            recipientEncryptionPrivateKey: this.state.encryptionPrivateKey
        });
        rememberNonce(this.state, envelope.nonce, envelope.timestamp);
        writeAgentState(this.state);
        return payload;
    }

    /**
     * Encrypts and signs a response for the paired controller.
     */
    private sealControllerEnvelope(payload: unknown, messageType: string) {
        if (!this.state.controllerId || !this.state.controllerPublicEncryptionKey) {
            throw new Error("Agent is not paired with a controller.");
        }

        return sealEnvelope(payload, {
            senderId: this.state.serverId,
            recipientId: this.state.controllerId,
            messageType
        }, {
            senderSigningPrivateKey: this.state.signingPrivateKey,
            recipientEncryptionPublicKey: this.state.controllerPublicEncryptionKey
        });
    }
}

function isStreamingJob(jobType: AgentJobRequest["jobType"]) {
    return jobType === "deploy" || jobType === "runtimeLogsFollow" || jobType === "runtimeActionFollow";
}

function isPairingResetRequested() {
    return ["1", "true", "yes"].includes(String(process.env.DEPLOY_AGENT_RESET_PAIRING || process.env.UPDATER_AGENT_RESET_PAIRING || "").trim().toLowerCase());
}

function trimFrames(frames: AgentLogFrame[]) {
    return frames.slice(-5000);
}

function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
