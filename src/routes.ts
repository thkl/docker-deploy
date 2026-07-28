import { existsSync } from "node:fs";
import { join } from "node:path";
import express, { Express, NextFunction, Request, Response } from "express";
import { AdminAuth } from "./auth.js";
import { assertSafeDeletePath, removeCheckoutPath } from "./checkoutCleanup.js";
import { importProjectCompose } from "./composeImport.js";
import { ConfigStore, maskToken } from "./configStore.js";
import { DeploymentStore } from "./deploymentStore.js";
import { DeploymentService } from "./deploymentService.js";
import { stopProjectContainers } from "./deploy.js";
import { defaultProjectPath, GlobalSettingsStore } from "./globalSettingsStore.js";
import { verifySignature } from "./signature.js";
import { DeleteProjectPayload, GlobalSettingsPayload, ProjectPayload } from "./types.js";
import { normalizeProjectName, normalizeRepositoryUrl, normalizeTraefikSettings } from "./validation.js";
import { resolveWebhookProject } from "./webhookResolver.js";

/**
 * Dependencies required by the HTTP route layer.
 */
export interface RouteDependencies {
    adminAuth: AdminAuth;
    configStore: ConfigStore;
    deploymentService: DeploymentService;
    deploymentStore: DeploymentStore;
    globalSettingsStore: GlobalSettingsStore;
}

/**
 * Registers all HTTP routes for the controller API and Angular frontend.
 */
export function registerRoutes(app: Express, dependencies: RouteDependencies) {
    const { adminAuth, configStore, deploymentService, deploymentStore, globalSettingsStore } = dependencies;

    app.get("/health", (req: Request, res: Response) => {
        res.status(200).send("I am alive");
    });

    app.get("/api/auth/status", (req: Request, res: Response) => {
        res.json(adminAuth.status());
    });

    app.post("/api/auth/login", (req: Request, res: Response) => {
        const token = typeof req.body.token === "string" ? req.body.token : "";
        if (!adminAuth.login(token)) {
            res.status(401).json({ error: "Invalid admin token." });
            return;
        }

        res.json({ authenticated: true, token: adminAuth.required ? token : "" });
    });

    app.use("/api/settings", adminAuth.requireAuth);
    app.use("/api/projects", adminAuth.requireAuth);

    registerSettingsRoutes(app, globalSettingsStore);
    registerProjectRoutes(app, { configStore, deploymentService, deploymentStore, globalSettingsStore });
    registerWebhookRoute(app, { configStore, deploymentService });
    registerCiDeployRoute(app, { configStore, deploymentService });
    registerFrontendRoutes(app);
}

/**
 * Registers global settings read/write endpoints.
 */
function registerSettingsRoutes(app: Express, globalSettingsStore: GlobalSettingsStore) {
    app.get("/api/settings", (req: Request, res: Response) => {
        res.json(globalSettingsStore.readSettings());
    });

    app.put("/api/settings", (req: Request, res: Response) => {
        try {
            const settings = globalSettingsStore.writeSettings(req.body as GlobalSettingsPayload);
            res.json(settings);
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "Could not save global settings." });
        }
    });
}

/**
 * Registers project CRUD, manual deploy, compose import, and deployment history
 * endpoints.
 */
function registerProjectRoutes(app: Express, dependencies: Pick<RouteDependencies, "configStore" | "deploymentService" | "deploymentStore" | "globalSettingsStore">) {
    const { configStore, deploymentService, deploymentStore, globalSettingsStore } = dependencies;

    app.get("/api/projects", (req: Request, res: Response, next: NextFunction) => {
        try {
            const globalSettings = globalSettingsStore.readSettings();
            // Shape the storage record into the UI-facing project summary.
            const projects = Object.entries(configStore.readConfig())
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
                    lastDeployment: deploymentStore.latest(name)
                }));

            res.json(projects);
        } catch (error) {
            next(error);
        }
    });

    app.post("/api/projects", (req: Request, res: Response) => {
        try {
            const payload = req.body as ProjectPayload;
            const repoName = normalizeProjectName(payload.name);
            const repoToken = payload.token?.trim();
            const repositoryUrl = normalizeRepositoryUrl(payload.repositoryUrl);
            const deployToken = payload.deployToken?.trim();
            const repoPath = payload.path?.trim();
            const composeOverride = payload.composeOverride?.trim();
            const globalSettings = globalSettingsStore.readSettings();
            const traefik = normalizeTraefikSettings(payload, globalSettings);

            const config = configStore.readConfig();
            config[repoName] = {
                ...(repoToken ? { token: repoToken } : {}),
                ...(repositoryUrl ? { repositoryUrl } : {}),
                ...(deployToken ? { deployToken } : {}),
                ...(repoPath ? { path: repoPath } : {}),
                ...(composeOverride ? { composeOverride } : {}),
                ...(traefik ? { traefik } : {})
            };
            configStore.writeConfig(config);

            res.status(201).json({ name: repoName });
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "Could not save project." });
        }
    });

    app.put("/api/projects/:name", (req: Request, res: Response) => {
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
            const globalSettings = globalSettingsStore.readSettings();
            const traefik = normalizeTraefikSettings(payload, globalSettings);
            const config = configStore.readConfig();
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
            configStore.writeConfig(config);

            res.json({ name: nextName });
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "Could not update project." });
        }
    });

    app.delete("/api/projects/:name", async (req: Request, res: Response) => {
        try {
            const rawProjectName = req.params.name;
            const projectName = normalizeProjectName(Array.isArray(rawProjectName) ? rawProjectName[0] : rawProjectName);
            const payload = req.body as DeleteProjectPayload;
            const config = configStore.readConfig();
            const appSettings = config[projectName];

            if (!appSettings) {
                res.status(404).json({ error: "Project does not exist." });
                return;
            }

            if (payload.confirmationName !== projectName) {
                res.status(400).json({ error: "Confirmation name does not match the project name." });
                return;
            }

            const globalSettings = globalSettingsStore.readSettings();
            const actions: string[] = [];

            if (payload.stopContainers) {
                await stopProjectContainers(projectName, appSettings, globalSettings);
                actions.push("containers stopped");
            }

            if (payload.deleteCheckout) {
                const checkoutPath = assertSafeDeletePath(appSettings.path ?? defaultProjectPath(globalSettings, projectName), globalSettings.dataRoot);
                const cleanup = await removeCheckoutPath(checkoutPath);
                actions.push(...cleanup.steps);
                actions.push("checkout deleted");
            }

            if (payload.deleteDeploymentHistory) {
                deploymentStore.deleteProject(projectName);
                actions.push("deployment history deleted");
            }

            delete config[projectName];
            configStore.writeConfig(config);
            actions.push("project config deleted");

            res.json({ deleted: true, actions });
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "Could not delete project." });
        }
    });

    app.post("/api/projects/:name/deploy", (req: Request, res: Response) => {
        const rawProjectName = req.params.name;
        const projectName = normalizeProjectName(Array.isArray(rawProjectName) ? rawProjectName[0] : rawProjectName);
        const appSettings = configStore.fetchProfile(projectName);

        if (!appSettings) {
            res.status(404).json({ error: "Project does not exist." });
            return;
        }

        const deployment = deploymentService.startDeployment(projectName, appSettings, "manual");
        res.status(200).json({ status: "Build worker dispatched", deploymentId: deployment.id });
    });

    app.post("/api/projects/:name/compose/import", async (req: Request, res: Response) => {
        try {
            const rawProjectName = req.params.name;
            const projectName = normalizeProjectName(Array.isArray(rawProjectName) ? rawProjectName[0] : rawProjectName);
            const appSettings = configStore.fetchProfile(projectName);

            if (!appSettings) {
                res.status(404).json({ error: "Project does not exist." });
                return;
            }

            const importedCompose = await importProjectCompose(projectName, appSettings, globalSettingsStore.readSettings());
            res.json(importedCompose);
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "Could not import Docker Compose file." });
        }
    });

    app.get("/api/projects/:name/deployments", (req: Request, res: Response) => {
        const rawProjectName = req.params.name;
        const projectName = normalizeProjectName(Array.isArray(rawProjectName) ? rawProjectName[0] : rawProjectName);

        if (!configStore.fetchProfile(projectName)) {
            res.status(404).json({ error: "Project does not exist." });
            return;
        }

        res.json(deploymentStore.list(projectName));
    });

    app.get("/api/projects/:name/deployments/latest", (req: Request, res: Response) => {
        const rawProjectName = req.params.name;
        const projectName = normalizeProjectName(Array.isArray(rawProjectName) ? rawProjectName[0] : rawProjectName);

        if (!configStore.fetchProfile(projectName)) {
            res.status(404).json({ error: "Project does not exist." });
            return;
        }

        res.json(deploymentStore.latest(projectName));
    });
}

/**
 * Registers the GitLab webhook endpoint.
 */
function registerWebhookRoute(app: Express, dependencies: Pick<RouteDependencies, "configStore" | "deploymentService">) {
    const { configStore, deploymentService } = dependencies;

    app.post("/webhook", (req: Request, res: Response) => {
        const event = req.headers["x-gitlab-event"];

        if (event !== "Push Hook") {
            res.status(202).send("Ignored event");
            return;
        }

        // GitLab payload names can differ from the UI project key, so map the
        // payload back to the configured project before recording logs.
        const webhookProject = resolveWebhookProject(req.body, configStore.readConfig());
        if (!webhookProject) {
            throw new Error("No config for this repository");
        }

        const { projectName, appSettings } = webhookProject;
        if (!appSettings.token) {
            res.status(403).send("Webhook secret token is not configured for this project.");
            return;
        }

        if (verifySignature(appSettings.token, req, res)) {
            const deployment = deploymentService.startDeployment(projectName, appSettings, "webhook");
            console.log(`Webhook deployment dispatched for ${projectName} (${deployment.id}).`);
            res.status(200).send("Build worker dispatched");
        }
    });
}

/**
 * Registers the token-protected CI deploy trigger endpoint.
 */
function registerCiDeployRoute(app: Express, dependencies: Pick<RouteDependencies, "configStore" | "deploymentService">) {
    const { configStore, deploymentService } = dependencies;

    app.post("/api/deploy/:name", (req: Request, res: Response) => {
        const rawProjectName = req.params.name;
        const projectName = normalizeProjectName(Array.isArray(rawProjectName) ? rawProjectName[0] : rawProjectName);
        const appSettings = configStore.fetchProfile(projectName);

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

        const deployment = deploymentService.startDeployment(projectName, appSettings, "ci");
        res.status(200).json({ status: "Build worker dispatched", deploymentId: deployment.id });
    });
}

/**
 * Serves the built Angular app when it is available.
 */
function registerFrontendRoutes(app: Express) {
    const frontendPath = join(process.cwd(), "frontend", "dist", "frontend", "browser");
    const indexPath = join(frontendPath, "index.html");

    if (!existsSync(indexPath)) {
        app.get("/", (req: Request, res: Response) => {
            res.status(503).type("text").send("Angular frontend build missing. Run `pnpm run build:frontend`.");
        });
        return;
    }

    app.use(express.static(frontendPath));
    app.get(/.*/, (req: Request, res: Response) => {
        res.sendFile(indexPath);
    });
}
