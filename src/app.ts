import { createServer } from "node:http";
import express, { NextFunction, Request, Response } from "express";
import { AgentManager } from "./agentManager.js";
import { AgentRuntime } from "./agentRuntime.js";
import { AdminAuth } from "./auth.js";
import { AppDatabase } from "./database.js";
import { ConfigStore } from "./configStore.js";
import { DeploymentService } from "./deploymentService.js";
import { DeploymentStreamHub } from "./deploymentStreams.js";
import { DeploymentStore } from "./deploymentStore.js";
import { GlobalSettingsStore } from "./globalSettingsStore.js";
import { ensureControllerKeys } from "./keyStore.js";
import { LocalAgent } from "./localAgent.js";
import { registerRoutes } from "./routes.js";
import { RuntimeLogStreamHub } from "./runtimeLogStreams.js";
import { ServerStore } from "./serverStore.js";
import { AuthenticatedRequest } from "./types.js";

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
    private readonly globalSettingsStore = new GlobalSettingsStore(this.database.connection);
    private readonly serverStore = new ServerStore(this.database.connection);
    private readonly controllerKeys = ensureControllerKeys();
    private readonly localAgent = new LocalAgent();
    private readonly agentManager = new AgentManager(this.localAgent, this.serverStore, this.controllerKeys);
    private readonly deploymentStreams = new DeploymentStreamHub(this.configStore, this.deploymentStore, this.adminAuth);
    private readonly runtimeLogStreams = new RuntimeLogStreamHub(this.configStore, this.globalSettingsStore, this.agentManager, this.adminAuth);
    private readonly deploymentService = new DeploymentService(
        this.deploymentStore,
        this.globalSettingsStore,
        this.agentManager,
        (projectName) => this.deploymentStreams.broadcast(projectName)
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
        await this.deploymentService.reconcileRunningDeployments(this.configStore.readConfig());
        this.configureBodyParsing();
        registerRoutes(this.app, {
            adminAuth: this.adminAuth,
            configStore: this.configStore,
            deploymentService: this.deploymentService,
            deploymentStore: this.deploymentStore,
            globalSettingsStore: this.globalSettingsStore,
            agentManager: this.agentManager,
            controllerKeys: this.controllerKeys,
            serverStore: this.serverStore
        });
        this.registerErrorHandler();

        const server = createServer(this.app);
        this.deploymentStreams.register(server);
        this.runtimeLogStreams.register(server);
        server.listen(this.port, () => console.log("Build-First Webhook Factory active."));
    }

    /**
     * Caches local server capabilities so the UI can render settings instantly.
     */
    private async warmLocalCapabilities() {
        const traefik = await this.localAgent.detectTraefik(this.globalSettingsStore.readSettings());
        this.serverStore.updateCapabilities("local", { traefik });
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
            res.status(500).json({ error: error.message || "Internal server error." });
        });
    }
}

const role = process.env.UPDATER_ROLE || "standalone";
if (role === "agent") {
    new AgentRuntime().start();
} else if (role === "standalone" || role === "controller") {
    new App().init();
} else {
    throw new Error(`Unsupported UPDATER_ROLE: ${role}`);
}
