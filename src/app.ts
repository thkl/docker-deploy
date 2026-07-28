import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer, Server } from "node:http";
import { isAbsolute, join, resolve } from "node:path";
import express, { NextFunction, Request, Response } from "express";
import { WebSocket, WebSocketServer } from "ws";
import { AdminAuth } from "./auth.js";
import { importProjectCompose } from "./composeImport.js";
import { ConfigStore, maskToken } from "./configStore.js";
import { DeploymentStore, DeploymentTrigger } from "./deploymentStore.js";
import { deleteCheckoutPath, dispatchBuildWorker, stopProjectContainers } from "./deploy.js";
import { defaultProjectPath, GlobalSettingsStore } from "./globalSettingsStore.js";
import { verifySignature } from "./signature.js";
import { AuthenticatedRequest, DeleteProjectPayload, GlobalSettingsPayload, ProjectPayload, ProjectSettings } from "./types.js";
import { normalizeProjectName, normalizeRepositoryUrl, normalizeTraefikSettings } from "./validation.js";

/**
 * Express controller application.
 *
 * This class currently owns HTTP routes, WebSocket deployment streams, JSON
 * stores, and deployment dispatch. The planned controller/agent split should
 * move deployment execution behind an agent interface and keep this class as
 * the API/controller surface.
 */
class App {
    app = express();
    port = parseInt(process.env.PORT || "3999");
    configStore = new ConfigStore();
    globalSettingsStore = new GlobalSettingsStore();
    deploymentStore = new DeploymentStore();
    adminAuth = new AdminAuth();
    deploymentClients = new Map<string, Set<WebSocket>>();

    /**
     * Configures middleware/routes, attaches WebSocket upgrade handling, and
     * starts the HTTP server.
     */
    init() {
        this.configureBodyParsing();
        this.registerRoutes();
        this.registerErrorHandler();

        const server = createServer(this.app);
        this.registerDeploymentStreams(server);
        server.listen(this.port, () => console.log("Build-First Webhook Factory active."));
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
     * Registers health, auth, settings, project, webhook, deployment, compose
     * import, and frontend fallback routes.
     */
    private registerRoutes() {
        this.app.get("/health", (req: Request, res: Response) => {
            res.status(200).send("I am alive");
        });

        this.app.get("/api/auth/status", (req: Request, res: Response) => {
            res.json(this.adminAuth.status());
        });

        this.app.post("/api/auth/login", (req: Request, res: Response) => {
            const token = typeof req.body.token === "string" ? req.body.token : "";
            if (!this.adminAuth.login(token)) {
                res.status(401).json({ error: "Invalid admin token." });
                return;
            }

            res.json({ authenticated: true, token: this.adminAuth.required ? token : "" });
        });

        this.app.use("/api/settings", this.adminAuth.requireAuth);
        this.app.use("/api/projects", this.adminAuth.requireAuth);

        this.app.get("/api/settings", (req: Request, res: Response) => {
            res.json(this.globalSettingsStore.readSettings());
        });

        this.app.put("/api/settings", (req: Request, res: Response) => {
            try {
                const settings = this.globalSettingsStore.writeSettings(req.body as GlobalSettingsPayload);
                res.json(settings);
            } catch (error) {
                res.status(400).json({ error: error instanceof Error ? error.message : "Could not save global settings." });
            }
        });

        this.app.get("/api/projects", (req: Request, res: Response, next: NextFunction) => {
            try {
                const globalSettings = this.globalSettingsStore.readSettings();
                // Shape the storage record into the UI-facing project summary.
                const projects = Object.entries(this.configStore.readConfig())
                    .sort(([left], [right]) => left.localeCompare(right))
                    .map(([name, settings]) => ({
                        name,
                        repositoryUrl: settings.repositoryUrl ?? "",
                        path: settings.path ?? defaultProjectPath(globalSettings, name),
                        token: settings.token ? maskToken(settings.token) : "",
                        deployToken: settings.deployToken ? maskToken(settings.deployToken) : "",
                        composeOverride: settings.composeOverride ?? "",
                        hasComposeOverride: Boolean(settings.composeOverride),
                        traefik: settings.traefik ?? { enabled: false },
                        lastDeployment: this.deploymentStore.latest(name)
                    }));

                res.json(projects);
            } catch (error) {
                next(error);
            }
        });

        this.app.post("/api/projects", (req: Request, res: Response) => {
            try {
                const payload = req.body as ProjectPayload;
                const repoName = normalizeProjectName(payload.name);
                const repoToken = payload.token?.trim();
                const repositoryUrl = normalizeRepositoryUrl(payload.repositoryUrl);
                const deployToken = payload.deployToken?.trim();
                const repoPath = payload.path?.trim();
                const composeOverride = payload.composeOverride?.trim();
                const globalSettings = this.globalSettingsStore.readSettings();
                const traefik = normalizeTraefikSettings(payload, globalSettings);

                const config = this.configStore.readConfig();
                config[repoName] = {
                    ...(repoToken ? { token: repoToken } : {}),
                    ...(repositoryUrl ? { repositoryUrl } : {}),
                    ...(deployToken ? { deployToken } : {}),
                    ...(repoPath ? { path: repoPath } : {}),
                    ...(composeOverride ? { composeOverride } : {}),
                    ...(traefik ? { traefik } : {})
                };
                this.configStore.writeConfig(config);

                res.status(201).json({ name: repoName });
            } catch (error) {
                res.status(400).json({ error: error instanceof Error ? error.message : "Could not save project." });
            }
        });

        this.app.put("/api/projects/:name", (req: Request, res: Response) => {
            try {
                const rawCurrentName = req.params.name;
                const currentName = normalizeProjectName(Array.isArray(rawCurrentName) ? rawCurrentName[0] : rawCurrentName);
                const payload = req.body as ProjectPayload;
                const nextName = normalizeProjectName(payload.name);
                const nextToken = payload.token?.trim();
                const nextRepositoryUrl = normalizeRepositoryUrl(payload.repositoryUrl);
                const nextDeployToken = payload.deployToken?.trim();
                const nextPath = payload.path?.trim();
                const composeOverride = payload.composeOverride?.trim();
                const globalSettings = this.globalSettingsStore.readSettings();
                const traefik = normalizeTraefikSettings(payload, globalSettings);
                const config = this.configStore.readConfig();
                const existing = config[currentName];

                if (!existing) {
                    res.status(404).json({ error: "Project does not exist." });
                    return;
                }

                if (nextName !== currentName && config[nextName]) {
                    res.status(409).json({ error: "A project with that repository name already exists." });
                    return;
                }

                if (nextName !== currentName) {
                    delete config[currentName];
                }

                config[nextName] = {
                    token: nextToken || existing.token,
                    ...(nextRepositoryUrl ? { repositoryUrl: nextRepositoryUrl } : {}),
                    ...(nextDeployToken || existing.deployToken ? { deployToken: nextDeployToken || existing.deployToken } : {}),
                    ...(nextPath ? { path: nextPath } : {}),
                    ...(composeOverride ? { composeOverride } : {}),
                    ...(traefik ? { traefik } : {})
                };
                this.configStore.writeConfig(config);

                res.json({ name: nextName });
            } catch (error) {
                res.status(400).json({ error: error instanceof Error ? error.message : "Could not update project." });
            }
        });

        this.app.delete("/api/projects/:name", async (req: Request, res: Response) => {
            try {
                const rawProjectName = req.params.name;
                const projectName = normalizeProjectName(Array.isArray(rawProjectName) ? rawProjectName[0] : rawProjectName);
                const payload = req.body as DeleteProjectPayload;
                const config = this.configStore.readConfig();
                const appSettings = config[projectName];

                if (!appSettings) {
                    res.status(404).json({ error: "Project does not exist." });
                    return;
                }

                if (payload.confirmationName !== projectName) {
                    res.status(400).json({ error: "Confirmation name does not match the project name." });
                    return;
                }

                const globalSettings = this.globalSettingsStore.readSettings();
                const actions: string[] = [];

                if (payload.stopContainers) {
                    await stopProjectContainers(projectName, appSettings, globalSettings);
                    actions.push("containers stopped");
                }

                if (payload.deleteCheckout) {
                    const checkoutPath = assertSafeDeletePath(appSettings.path ?? defaultProjectPath(globalSettings, projectName), globalSettings.dataRoot);
                    await removeCheckoutPath(checkoutPath);
                    actions.push("checkout deleted");
                }

                if (payload.deleteDeploymentHistory) {
                    this.deploymentStore.deleteProject(projectName);
                    actions.push("deployment history deleted");
                }

                delete config[projectName];
                this.configStore.writeConfig(config);
                actions.push("project config deleted");

                res.json({ deleted: true, actions });
            } catch (error) {
                res.status(400).json({ error: error instanceof Error ? error.message : "Could not delete project." });
            }
        });

        this.app.post("/webhook", (req: Request, res: Response) => {
            const event = req.headers["x-gitlab-event"];

            if (event !== "Push Hook") {
                res.status(202).send("Ignored event");
                return;
            }

            // GitLab payload names can differ from the UI project key, so map
            // the payload back to the configured project before recording logs.
            const webhookProject = resolveWebhookProject(req.body, this.configStore.readConfig());
            if (!webhookProject) {
                throw new Error("No config for this repository");
            }

            const { projectName, appSettings } = webhookProject;
            if (!appSettings.token) {
                res.status(403).send("Webhook secret token is not configured for this project.");
                return;
            }

            if (verifySignature(appSettings.token, req, res)) {
                const deployment = this.startDeployment(projectName, appSettings, "webhook");
                console.log(`Webhook deployment dispatched for ${projectName} (${deployment.id}).`);
                res.status(200).send("Build worker dispatched");
            }
        });

        this.app.post("/api/deploy/:name", (req: Request, res: Response) => {
            const rawProjectName = req.params.name;
            const projectName = normalizeProjectName(Array.isArray(rawProjectName) ? rawProjectName[0] : rawProjectName);
            const appSettings = this.configStore.fetchProfile(projectName);

            if (!appSettings) {
                res.status(404).json({ error: "Project does not exist." });
                return;
            }

            if (!appSettings.deployToken) {
                res.status(403).json({ error: "CI deploy token is not configured for this project." });
                return;
            }

            const authHeader = req.headers.authorization || "";
            const expectedHeader = `Bearer ${appSettings.deployToken}`;
            if (authHeader !== expectedHeader) {
                res.status(401).json({ error: "Invalid CI deploy token." });
                return;
            }

            const deployment = this.startDeployment(projectName, appSettings, "ci");
            res.status(200).json({ status: "Build worker dispatched", deploymentId: deployment.id });
        });

        this.app.post("/api/projects/:name/deploy", (req: Request, res: Response) => {
            const rawProjectName = req.params.name;
            const projectName = normalizeProjectName(Array.isArray(rawProjectName) ? rawProjectName[0] : rawProjectName);
            const appSettings = this.configStore.fetchProfile(projectName);

            if (!appSettings) {
                res.status(404).json({ error: "Project does not exist." });
                return;
            }

            const deployment = this.startDeployment(projectName, appSettings, "manual");
            res.status(200).json({ status: "Build worker dispatched", deploymentId: deployment.id });
        });

        this.app.post("/api/projects/:name/compose/import", async (req: Request, res: Response) => {
            try {
                const rawProjectName = req.params.name;
                const projectName = normalizeProjectName(Array.isArray(rawProjectName) ? rawProjectName[0] : rawProjectName);
                const appSettings = this.configStore.fetchProfile(projectName);

                if (!appSettings) {
                    res.status(404).json({ error: "Project does not exist." });
                    return;
                }

                const importedCompose = await importProjectCompose(projectName, appSettings, this.globalSettingsStore.readSettings());
                res.json(importedCompose);
            } catch (error) {
                res.status(400).json({ error: error instanceof Error ? error.message : "Could not import Docker Compose file." });
            }
        });

        this.app.get("/api/projects/:name/deployments", (req: Request, res: Response) => {
            const rawProjectName = req.params.name;
            const projectName = normalizeProjectName(Array.isArray(rawProjectName) ? rawProjectName[0] : rawProjectName);

            if (!this.configStore.fetchProfile(projectName)) {
                res.status(404).json({ error: "Project does not exist." });
                return;
            }

            res.json(this.deploymentStore.list(projectName));
        });

        this.app.get("/api/projects/:name/deployments/latest", (req: Request, res: Response) => {
            const rawProjectName = req.params.name;
            const projectName = normalizeProjectName(Array.isArray(rawProjectName) ? rawProjectName[0] : rawProjectName);

            if (!this.configStore.fetchProfile(projectName)) {
                res.status(404).json({ error: "Project does not exist." });
                return;
            }

            res.json(this.deploymentStore.latest(projectName));
        });

        this.registerFrontendRoutes();
    }

    /**
     * Creates a deployment record, starts the worker, and wires worker callbacks
     * into persisted deployment history plus WebSocket broadcasts.
     */
    private startDeployment(projectName: string, appSettings: ProjectSettings, trigger: DeploymentTrigger) {
        const deployment = this.deploymentStore.start(projectName, trigger);
        const globalSettings = this.globalSettingsStore.readSettings();
        this.broadcastDeployment(projectName);

        dispatchBuildWorker(projectName, appSettings, globalSettings, {
            onOutput: (stream, chunk) => {
                this.deploymentStore.append(projectName, deployment.id, stream, chunk);
                this.broadcastDeployment(projectName);
            },
            onSuccess: () => {
                this.deploymentStore.finish(projectName, deployment.id, "succeeded");
                this.broadcastDeployment(projectName);
            },
            onFailure: (error) => {
                this.deploymentStore.finish(projectName, deployment.id, "failed", {
                    error: error.message,
                    exitCode: error.code
                });
                this.broadcastDeployment(projectName);
            }
        });

        return deployment;
    }

    /**
     * Handles WebSocket upgrade requests for live deployment log streams.
     */
    private registerDeploymentStreams(server: Server) {
        const webSocketServer = new WebSocketServer({ noServer: true });

        server.on("upgrade", (request, socket, head) => {
            const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
            const match = url.pathname.match(/^\/api\/projects\/([^/]+)\/deployments\/stream$/);

            if (!match) {
                socket.destroy();
                return;
            }

            let projectName = "";
            try {
                projectName = normalizeProjectName(decodeURIComponent(match[1]));
            } catch (error) {
                socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
                socket.destroy();
                return;
            }

            if (!this.configStore.fetchProfile(projectName)) {
                socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
                socket.destroy();
                return;
            }

            if (!this.adminAuth.isValidToken(url.searchParams.get("token") ?? "")) {
                socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
                socket.destroy();
                return;
            }

            webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
                this.registerDeploymentClient(projectName, webSocket);
            });
        });
    }

    /**
     * Registers one browser WebSocket as a subscriber for a project's latest
     * deployment state.
     */
    private registerDeploymentClient(projectName: string, webSocket: WebSocket) {
        const clients = this.deploymentClients.get(projectName) ?? new Set<WebSocket>();
        clients.add(webSocket);
        this.deploymentClients.set(projectName, clients);

        this.sendDeploymentSnapshot(projectName, webSocket);

        webSocket.on("close", () => {
            clients.delete(webSocket);
            if (clients.size === 0) {
                this.deploymentClients.delete(projectName);
            }
        });
    }

    /**
     * Sends the newest deployment record to all connected clients for a project.
     */
    private broadcastDeployment(projectName: string) {
        const clients = this.deploymentClients.get(projectName);
        if (!clients?.size) {
            return;
        }

        const payload = JSON.stringify({
            type: "deployment",
            deployment: this.deploymentStore.latest(projectName)
        });

        for (const client of clients) {
            if (client.readyState === WebSocket.OPEN) {
                client.send(payload);
            }
        }
    }

    /**
     * Sends the current deployment state immediately after a WebSocket connects.
     */
    private sendDeploymentSnapshot(projectName: string, webSocket: WebSocket) {
        if (webSocket.readyState !== WebSocket.OPEN) {
            return;
        }

        webSocket.send(
            JSON.stringify({
                type: "snapshot",
                deployment: this.deploymentStore.latest(projectName)
            })
        );
    }

    /**
     * Serves the built Angular app when it is available.
     */
    private registerFrontendRoutes() {
        const frontendPath = join(process.cwd(), "frontend", "dist", "frontend", "browser");
        const indexPath = join(frontendPath, "index.html");

        if (!existsSync(indexPath)) {
            this.app.get("/", (req: Request, res: Response) => {
                res.status(503).type("text").send("Angular frontend build missing. Run `pnpm run build:frontend`.");
            });
            return;
        }

        this.app.use(express.static(frontendPath));
        this.app.get(/.*/, (req: Request, res: Response) => {
            res.sendFile(indexPath);
        });
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

new App().init();

/**
 * Validates that a configured checkout path is safe to delete automatically.
 *
 * The guard allows custom absolute checkout paths but refuses root, the data
 * root itself, and very shallow paths that are too risky for recursive removal.
 */
function assertSafeDeletePath(path: string, dataRoot: string) {
    if (!isAbsolute(path)) {
        throw new Error("Checkout path must be absolute before it can be deleted.");
    }

    const resolvedPath = resolve(path);
    const resolvedDataRoot = resolve(dataRoot);
    const pathParts = resolvedPath.split("/").filter(Boolean);

    if (
        resolvedPath === "/" ||
        resolvedPath === resolvedDataRoot ||
        pathParts.length < 3
    ) {
        throw new Error(`Refusing to delete unsafe checkout path: ${resolvedPath}`);
    }

    return resolvedPath;
}

/**
 * Removes a project checkout and verifies the path is gone.
 *
 * The local removal is fast when permissions allow it. The Docker fallback
 * handles root-owned files created by deployment worker containers.
 */
async function removeCheckoutPath(checkoutPath: string) {
    try {
        await rm(checkoutPath, { recursive: true, force: true });
    } catch (error) {
        await deleteCheckoutPath(checkoutPath);
    }

    if (existsSync(checkoutPath)) {
        await deleteCheckoutPath(checkoutPath);
    }

    if (existsSync(checkoutPath)) {
        throw new Error(`Checkout path still exists after deletion attempt: ${checkoutPath}`);
    }
}

/**
 * Resolves a GitLab webhook payload to the configured project record.
 *
 * Matching first tries direct project-name candidates, then falls back to
 * normalized repository URL identity so display names do not break UI status.
 */
function resolveWebhookProject(body: unknown, config: Record<string, ProjectSettings>) {
    const candidates = webhookProjectCandidates(body);
    for (const candidate of candidates) {
        const exactMatch = config[candidate];
        if (exactMatch) {
            return { projectName: candidate, appSettings: exactMatch };
        }
    }

    const normalizedRepositoryCandidates = new Set(candidates.map(normalizeGitRepositoryIdentity).filter(Boolean));
    for (const [projectName, appSettings] of Object.entries(config)) {
        if (appSettings.repositoryUrl && normalizedRepositoryCandidates.has(normalizeGitRepositoryIdentity(appSettings.repositoryUrl))) {
            return { projectName, appSettings };
        }
    }

    return null;
}

/**
 * Extracts all useful project identifiers from a GitLab push payload.
 */
function webhookProjectCandidates(body: unknown) {
    if (!body || typeof body !== "object") {
        return [];
    }

    const payload = body as Record<string, unknown>;
    const repository = readRecord(payload.repository);
    const project = readRecord(payload.project);
    const candidates = [
        readString(repository?.name),
        readString(repository?.path),
        readString(project?.name),
        readString(project?.path),
        readString(project?.path_with_namespace),
        readString(repository?.git_http_url),
        readString(repository?.git_ssh_url),
        readString(repository?.url),
        readString(payload.repository_url)
    ];

    return [...new Set(candidates.map((candidate) => candidate.trim()).filter(Boolean))];
}

/**
 * Safely narrows an unknown value to a record-like object.
 */
function readRecord(value: unknown) {
    return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

/**
 * Safely reads string fields from unknown webhook payload values.
 */
function readString(value: unknown) {
    return typeof value === "string" ? value : "";
}

/**
 * Converts Git repository URLs into comparable `host/path` identities.
 *
 * This makes `git@gitlab.example.com:group/repo.git` and
 * `https://gitlab.example.com/group/repo.git` match the same configured repo.
 */
function normalizeGitRepositoryIdentity(value: string) {
    const trimmed = value.trim();
    if (!trimmed) {
        return "";
    }

    const urlValue = trimmed.replace(/^git@([^:]+):/i, "ssh://git@$1/");
    try {
        const url = new URL(urlValue);
        return `${url.hostname}${url.pathname}`
            .replace(/\.git$/i, "")
            .replace(/\/+$/g, "")
            .toLowerCase();
    } catch (error) {
        return trimmed
            .replace(/\.git$/i, "")
            .replace(/\/+$/g, "")
            .toLowerCase();
    }
}
