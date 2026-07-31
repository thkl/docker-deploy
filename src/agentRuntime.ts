import { createServer, Server } from "node:http";
import express, { Express, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { AgentJobAccepted, AgentJobRequest, AgentLogFrame, DeleteCheckoutJobPayload, DeployJobPayload, DetectTraefikJobPayload, DiagnoseTraefikJobPayload, InspectComposeJobPayload, InspectStatusJobPayload, RuntimeActionJobPayload, RuntimeLogsJobPayload, ValidateComposeJobPayload } from "./agentTypes.js";
import { openEnvelope, sealEnvelope, SecureEnvelope } from "./agentCrypto.js";
import { rememberNonce, ensureAgentState, removeAgentPairingFile, writeAgentPairingFile, writeAgentState, AgentState } from "./keyStore.js";
import { LocalAgent } from "./localAgent.js";
import { RuntimeLogStream } from "./deploy.js";

interface AgentJobState {
    id: string;
    streamToken: string;
    frames: AgentLogFrame[];
    sockets: Set<WebSocket>;
    cancel?: () => void;
}

/**
 * Standalone HTTP/WebSocket runtime for `UPDATER_ROLE=agent`.
 */
export class AgentRuntime {
    private readonly app: Express = express();
    private readonly port = parseInt(process.env.UPDATER_AGENT_PORT || process.env.PORT || "3998");
    private readonly host = process.env.UPDATER_AGENT_HOST || "0.0.0.0";
    private readonly localAgent = new LocalAgent();
    private readonly jobs = new Map<string, AgentJobState>();
    private state: AgentState = ensureAgentState();

    /**
     * Starts the agent HTTP API and log WebSocket endpoint.
     */
    start() {
        writeAgentPairingFile(this.state);
        this.app.use(express.json({ limit: "12mb" }));
        this.registerRoutes();
        const server = createServer(this.app);
        this.registerLogStreams(server);
        server.listen(this.port, this.host, () => {
            console.log(`Updater agent listening on ${this.host}:${this.port}.`);
            console.log(`Agent server ID: ${this.state.serverId}`);
            if (this.state.controllerPublicEncryptionKey && this.state.controllerPublicSigningKey) {
                console.log("Agent is already paired. Pairing file removed.");
            } else {
                console.log("Agent pairing data written to /app/data/agent-pairing.json.");
            }
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

            res.json({
                serverId: this.state.serverId,
                paired: Boolean(this.state.controllerPublicEncryptionKey && this.state.controllerPublicSigningKey),
                encryptionPublicKey: this.state.encryptionPublicKey,
                signingPublicKey: this.state.signingPublicKey,
                pairedAt: this.state.pairedAt,
                capabilities: {
                    traefik: await this.localAgent.detectTraefik({
                        dataRoot: "/root/docker-apps",
                        defaultTraefikNetwork,
                        defaultTraefikEntryPoints: "websecure",
                        defaultTraefikCertResolver: "letsencrypt",
                        sshKeyPath: "~/.ssh",
                        cleanupAfterDeploy: false
                    })
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
                const accepted = this.createJob();
                const response = await this.startJob(request, accepted);
                res.json({ envelope: this.sealControllerEnvelope({ ...accepted, ...response }, "job.accepted") });
            } catch (error) {
                res.status(400).json({ error: error instanceof Error ? error.message : "Job failed." });
            }
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
                for (const frame of job.frames) {
                    ws.send(JSON.stringify(this.sealControllerEnvelope(frame, "job.log")));
                }
                ws.on("close", () => {
                    job.sockets.delete(ws);
                    if (job.cancel && job.sockets.size === 0) {
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

        if (request.jobType === "detectTraefik") {
            const payload = request.payload as DetectTraefikJobPayload;
            return { result: await this.localAgent.detectTraefik(payload.globalSettings) };
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
    private createJob(): AgentJobAccepted {
        const job: AgentJobState = {
            id: randomUUID(),
            streamToken: randomUUID(),
            frames: [],
            sockets: new Set()
        };
        this.jobs.set(job.id, job);
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
        const serialized = JSON.stringify(this.sealControllerEnvelope(frame, "job.log"));
        for (const socket of job.sockets) {
            if (socket.readyState === WebSocket.OPEN) {
                socket.send(serialized);
            }
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
