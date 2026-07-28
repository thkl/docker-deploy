import { existsSync } from "node:fs";
import { join } from "node:path";
import express, { NextFunction, Request, Response } from "express";
import { ConfigStore, maskToken } from "./configStore.js";
import { dispatchBuildWorker } from "./deploy.js";
import { verifySignature } from "./signature.js";
import { AuthenticatedRequest, ProjectPayload } from "./types.js";
import { normalizeProjectName, normalizeTraefikSettings } from "./validation.js";

class App {
    app = express();
    port = parseInt(process.env.PORT || "3999");
    configStore = new ConfigStore();

    init() {
        this.configureBodyParsing();
        this.registerRoutes();
        this.registerErrorHandler();

        this.app.listen(this.port, () => console.log("Build-First Webhook Factory active."));
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
                        traefik: settings.traefik ?? { enabled: false }
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
                dispatchBuildWorker(repoName, appSettings);
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

            dispatchBuildWorker(projectName, appSettings);
            res.status(200).json({ status: "Build worker dispatched" });
        });

        this.app.post("/api/projects/:name/deploy", (req: Request, res: Response) => {
            const rawProjectName = req.params.name;
            const projectName = normalizeProjectName(Array.isArray(rawProjectName) ? rawProjectName[0] : rawProjectName);
            const appSettings = this.configStore.fetchProfile(projectName);

            if (!appSettings) {
                res.status(404).json({ error: "Project does not exist." });
                return;
            }

            dispatchBuildWorker(projectName, appSettings);
            res.status(200).json({ status: "Build worker dispatched" });
        });

        this.registerFrontendRoutes();
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
