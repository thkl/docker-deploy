import { createServer } from "node:http";
import express, { NextFunction, Request, Response } from "express";
import { AgentManager } from "./agentManager.js";
import { AgentHealthService } from "./agentHealth.js";
import { AgentRuntime } from "./agentRuntime.js";
import { apiEnvelopeMiddleware, apiError } from "./apiEnvelope.js";
import { AdminAuth } from "./auth.js";
import { AppDatabase } from "./database.js";
import { ConfigStore } from "./configStore.js";
import { DeploymentService } from "./deploymentService.js";
import { DeploymentStreamHub } from "./deploymentStreams.js";
import { DeploymentRecord, DeploymentStore } from "./deploymentStore.js";
import { EventBus } from "./eventBus.js";
import { GlobalSettingsStore } from "./globalSettingsStore.js";
import { ensureControllerKeys } from "./keyStore.js";
import { LocalAgent } from "./localAgent.js";
import { registerRoutes } from "./routes.js";
import { RuntimeLogStreamHub } from "./runtimeLogStreams.js";
import { RuntimeOperationStore } from "./runtimeOperationStore.js";
import { RuntimeOperationStreamHub } from "./runtimeOperationStreams.js";
import { RuntimeStatusStreamHub } from "./runtimeStatusStreams.js";
import { ServerStore } from "./serverStore.js";
import { AuthenticatedRequest, RuntimeStatus } from "./types.js";
import { WebhookStore } from "./webhookStore.js";

/**
 * Express controller bootstrap.
 *
 * Runtime behavior lives in focused modules:
 * routes own HTTP endpoints, DeploymentService owns deployment orchestration,
 * DeploymentStreamHub owns WebSocket clients, and stores own persistence.
 */
class App {
    private readonly app = express();
    private readonly port = parseInt(process.env.PORT || "3999");
    private readonly database = new AppDatabase();
    private readonly adminAuth = new AdminAuth();
    private readonly configStore = new ConfigStore(this.database.connection);
    private readonly deploymentStore = new DeploymentStore(this.database.connection);
    private readonly webhookStore = new WebhookStore(this.database.connection);
    private readonly runtimeOperationStore = new RuntimeOperationStore(this.database.connection);
    private readonly globalSettingsStore = new GlobalSettingsStore(this.database.connection);
    private readonly serverStore = new ServerStore(this.database.connection);
    private readonly controllerKeys = ensureControllerKeys();
    private readonly localAgent = new LocalAgent();
    private readonly agentManager = new AgentManager(this.localAgent, this.serverStore, this.controllerKeys);
    private readonly eventBus = new EventBus(this.adminAuth, () => this.buildEventSnapshot());
    private readonly agentHealth = new AgentHealthService(
        this.serverStore,
        this.deploymentStore,
        this.globalSettingsStore,
        this.agentManager,
        (server) => this.eventBus.publish({ type: "server.health", server })
    );
    private readonly deploymentStreams = new DeploymentStreamHub(this.configStore, this.deploymentStore, this.adminAuth);
    private readonly runtimeLogStreams = new RuntimeLogStreamHub(this.configStore, this.globalSettingsStore, this.agentManager, this.adminAuth);
    private readonly runtimeStatusStreams = new RuntimeStatusStreamHub(
        this.configStore,
        this.globalSettingsStore,
        this.agentManager,
        this.adminAuth,
        (projectId, projectName, status) => this.eventBus.publish({ type: "runtime.status", projectId, projectName, status })
    );
    private readonly runtimeOperationStreams = new RuntimeOperationStreamHub(
        this.configStore,
        this.globalSettingsStore,
        this.agentManager,
        this.runtimeOperationStore,
        this.adminAuth,
        (projectName) => this.runtimeStatusStreams.refreshProject(projectName),
        (projectName, operation) => this.eventBus.publish({
            type: "runtime.operation.updated",
            projectId: operation.projectId,
            projectName,
            operation
        })
    );
    private readonly deploymentService = new DeploymentService(
        this.deploymentStore,
        this.globalSettingsStore,
        this.agentManager,
        (projectName) => this.deploymentStreams.broadcast(projectName),
        (projectName) => this.runtimeStatusStreams.refreshProject(projectName),
        (projectName, deployment) => this.eventBus.publish({
            type: "deployment.updated",
            projectId: deployment?.projectId,
            projectName,
            deployment: stripInternalDeploymentFields(deployment)
        }),
        async (serverId) => {
            await this.agentHealth.refreshServer(serverId);
        }
    );

    /**
     * Configures middleware/routes, attaches WebSocket handling, and starts the
     * HTTP server.
     */
    init() {
        void this.start();
    }

    /**
     * Warms local target metadata, configures Express, and starts listening.
     */
    private async start() {
        await this.warmLocalCapabilities();
        const config = this.configStore.readConfig();
        await this.deploymentService.reconcileRunningDeployments(config);
        this.configureBodyParsing();
        this.app.use(apiEnvelopeMiddleware);
        registerRoutes(this.app, {
            adminAuth: this.adminAuth,
            database: this.database,
            configStore: this.configStore,
            deploymentService: this.deploymentService,
            deploymentStore: this.deploymentStore,
            webhookStore: this.webhookStore,
            runtimeOperationStore: this.runtimeOperationStore,
            globalSettingsStore: this.globalSettingsStore,
            agentManager: this.agentManager,
            controllerKeys: this.controllerKeys,
            serverStore: this.serverStore,
            runtimeStatusStreams: this.runtimeStatusStreams,
            agentHealth: this.agentHealth,
            eventBus: this.eventBus
        });
        this.registerErrorHandler();

        const server = createServer(this.app);
        this.deploymentStreams.register(server);
        this.runtimeLogStreams.register(server);
        this.runtimeOperationStreams.register(server);
        this.runtimeStatusStreams.register(server);
        this.eventBus.register(server);
        server.listen(this.port, () => console.log("Build-First Webhook Factory active."));
        this.agentHealth.startHeartbeat();
    }

    /**
     * Caches local server capabilities so the UI can render settings instantly.
     */
    private async warmLocalCapabilities() {
        const traefik = await this.localAgent.detectTraefik(this.globalSettingsStore.readSettings());
        await this.agentHealth.refreshLocalCapabilities(traefik);
    }

    /**
     * Sends initial state over the global browser event stream.
     */
    private async buildEventSnapshot() {
        const config = this.configStore.readConfig();
        const globalSettings = this.globalSettingsStore.readSettings();
        const serverEvents = this.serverStore.list().map((server) => ({ type: "server.health" as const, server }));
        const runtimeEvents = await Promise.all(
            Object.entries(config).map(async ([projectName, appSettings]) => {
                try {
                    const status = await this.agentManager.getClient(appSettings.serverId ?? "local").inspectStatus(projectName, appSettings, globalSettings);
                    return {
                        type: "runtime.status" as const,
                        projectId: appSettings.id,
                        projectName,
                        status
                    };
                } catch (error) {
                    const status = {
                        status: "error",
                        checkedAt: new Date().toISOString(),
                        services: [],
                        error: error instanceof Error ? error.message : "Could not inspect runtime status."
                    } satisfies RuntimeStatus;
                    return {
                        type: "runtime.status" as const,
                        projectId: appSettings.id,
                        projectName,
                        status
                    };
                }
            })
        );

        return [...serverEvents, ...runtimeEvents];
    }

    /**
     * Registers body parsers and preserves the raw request body for webhook
     * signature verification.
     */
    private configureBodyParsing() {
        const captureRawBody = (req: Request, res: Response, buf: Buffer) => {
            if (buf && buf.length) {
                (req as AuthenticatedRequest).rawBody = buf;
            }
        };

        this.app.use(express.json({ verify: captureRawBody }));
        this.app.use(express.urlencoded({ extended: true, verify: captureRawBody }));
    }

    /**
     * Converts uncaught Express errors into JSON responses.
     */
    private registerErrorHandler() {
        this.app.use((error: Error, req: Request, res: Response, next: NextFunction) => {
            console.error(error);
            res.status(500).json(apiError(error.message || "Internal server error.", 500));
        });
    }
}

function stripInternalDeploymentFields<T extends DeploymentRecord | null>(deployment: T): T {
    if (!deployment) {
        return deployment;
    }

    return {
        ...deployment,
        agentJobId: undefined,
        agentStreamToken: undefined,
        ...(deployment.targets ? { targets: deployment.targets.map((target) => stripInternalDeploymentFields(target)) } : {})
    };
}

const role = process.env.DEPLOY_ROLE || process.env.UPDATER_ROLE || "standalone";
if (role === "agent") {
    new AgentRuntime().start();
} else if (role === "standalone" || role === "controller") {
    new App().init();
} else {
    throw new Error(`Unsupported DEPLOY_ROLE: ${role}`);
}
