import { existsSync } from "node:fs";
import { createServer, Server } from "node:http";
import { join } from "node:path";
import express, { NextFunction, Request, Response } from "express";
import { WebSocket, WebSocketServer } from "ws";
import { ConfigStore, maskToken } from "./configStore.js";
import { DeploymentStore, DeploymentTrigger } from "./deploymentStore.js";
import { dispatchBuildWorker } from "./deploy.js";
import { verifySignature } from "./signature.js";
import { AuthenticatedRequest, ProjectPayload, ProjectSettings } from "./types.js";
import { normalizeProjectName, normalizeTraefikSettings } from "./validation.js";

class App {
    app = express();
    port = parseInt(process.env.PORT || "3999");
    configStore = new ConfigStore();
    deploymentStore = new DeploymentStore();
    deploymentClients = new Map<string, Set<WebSocket>>();

    init() {
        this.configureBodyParsing();
        this.registerRoutes();
        this.registerErrorHandler();

        const server = createServer(this.app);
        this.registerDeploymentStreams(server);
        server.listen(this.port, () => console.log("Build-First Webhook Factory active."));
    }

    private configureBodyParsing() {
        const captureRawBody = (req: Request, res: Response, buf: Buffer) => {
            if (buf && buf.length) {
                (req as AuthenticatedRequest).rawBody = buf;
            }
        };

        this.app.use(express.json({ verify: captureRawBody }));
        this.app.use(express.urlencoded({ extended: true, verify: captureRawBody }));
    }

    private registerRoutes() {
        this.app.get("/health", (req: Request, res: Response) => {
            res.status(200).send("I am alive");
        });

        this.app.get("/api/projects", (req: Request, res: Response, next: NextFunction) => {
            try {
                const projects = Object.entries(this.configStore.readConfig())
                    .sort(([left], [right]) => left.localeCompare(right))
                    .map(([name, settings]) => ({
                        name,
                        path: settings.path ?? "",
                        token: maskToken(settings.token ?? ""),
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
                const deployToken = payload.deployToken?.trim();
                const repoPath = payload.path?.trim();
                const composeOverride = payload.composeOverride?.trim();
                const traefik = normalizeTraefikSettings(payload);

                if (!repoToken) {
                    res.status(400).json({ error: "Webhook secret token is required." });
                    return;
                }

                const config = this.configStore.readConfig();
                config[repoName] = {
                    token: repoToken,
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
                const nextDeployToken = payload.deployToken?.trim();
                const nextPath = payload.path?.trim();
                const composeOverride = payload.composeOverride?.trim();
                const traefik = normalizeTraefikSettings(payload);
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

        this.app.post("/webhook", (req: Request, res: Response) => {
            const event = req.headers["x-gitlab-event"];

            if (event !== "Push Hook") {
                res.status(202).send("Ignored event");
                return;
            }

            const repoName = req.body.repository.name;
            const appSettings = this.configStore.fetchProfile(repoName);
            if (!appSettings) {
                throw new Error("No config for this repository");
            }

            if (verifySignature(appSettings.token, req, res)) {
                this.startDeployment(repoName, appSettings, "webhook");
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

    private startDeployment(projectName: string, appSettings: ProjectSettings, trigger: DeploymentTrigger) {
        const deployment = this.deploymentStore.start(projectName, trigger);
        this.broadcastDeployment(projectName);

        dispatchBuildWorker(projectName, appSettings, {
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

            webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
                this.registerDeploymentClient(projectName, webSocket);
            });
        });
    }

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

    private registerErrorHandler() {
        this.app.use((error: Error, req: Request, res: Response, next: NextFunction) => {
            console.error(error);
            res.status(500).json({ error: error.message || "Internal server error." });
        });
    }
}

new App().init();
