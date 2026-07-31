import { existsSync } from "node:fs";
import { join } from "node:path";
import express, { Express, NextFunction, Request, Response } from "express";
import { AgentManager } from "./agentManager.js";
import { sealEnvelope } from "./agentCrypto.js";
import { AdminAuth } from "./auth.js";
import { assertSafeDeletePath } from "./checkoutCleanup.js";
import { hasUnsafeRelativeBindMounts } from "./composeInspection.js";
import { ConfigStore, maskToken } from "./configStore.js";
import { DeploymentStore } from "./deploymentStore.js";
import { DeploymentService } from "./deploymentService.js";
import { defaultProjectPath, GlobalSettingsStore } from "./globalSettingsStore.js";
import { ControllerKeyState } from "./keyStore.js";
import { RuntimeOperationStore } from "./runtimeOperationStore.js";
import { ServerStore } from "./serverStore.js";
import { verifySignature } from "./signature.js";
import { DeleteProjectPayload, GlobalSettings, GlobalSettingsPayload, ProjectPayload, ProjectSettings, RuntimeServiceAction, ServerCapabilities, ServerPayload } from "./types.js";
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
    runtimeOperationStore: RuntimeOperationStore;
    globalSettingsStore: GlobalSettingsStore;
    agentManager: AgentManager;
    controllerKeys: ControllerKeyState;
    serverStore: ServerStore;
}

/**
 * Registers all HTTP routes for the controller API and Angular frontend.
 */
export function registerRoutes(app: Express, dependencies: RouteDependencies) {
    const { adminAuth, configStore, deploymentService, deploymentStore, runtimeOperationStore, globalSettingsStore, agentManager, controllerKeys, serverStore } = dependencies;

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
    app.use("/api/servers", adminAuth.requireAuth);

    registerSettingsRoutes(app, globalSettingsStore);
    registerServerRoutes(app, { serverStore, controllerKeys, agentManager, globalSettingsStore });
    registerProjectRoutes(app, { configStore, deploymentService, deploymentStore, runtimeOperationStore, globalSettingsStore, agentManager });
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
 * Registers target-server read endpoints.
 */
function registerServerRoutes(app: Express, dependencies: Pick<RouteDependencies, "serverStore" | "controllerKeys" | "agentManager" | "globalSettingsStore">) {
    const { serverStore, controllerKeys, agentManager, globalSettingsStore } = dependencies;

    app.get("/api/servers", (req: Request, res: Response) => {
        res.json(serverStore.list());
    });

    app.get("/api/servers/:id/capabilities", async (req: Request, res: Response) => {
        try {
            const serverId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
            const server = serverStore.get(serverId);
            if (!server) {
                res.status(404).json({ error: "Server does not exist." });
                return;
            }

            if (req.query.refresh !== "true" && server.capabilities) {
                res.json(server.capabilities);
                return;
            }

            const capabilities = { traefik: await agentManager.getClient(serverId).detectTraefik(globalSettingsStore.readSettings()) };
            serverStore.updateCapabilities(serverId, capabilities);
            res.json(capabilities);
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "Could not inspect server capabilities." });
        }
    });

    app.post("/api/servers", (req: Request, res: Response) => {
        try {
            void createRemoteServer(req.body as ServerPayload, serverStore, globalSettingsStore, res);
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "Could not create server." });
        }
    });

    app.put("/api/servers/:id", (req: Request, res: Response) => {
        try {
            const serverId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
            res.json(serverStore.updateRemote(serverId, req.body as ServerPayload));
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "Could not update server." });
        }
    });

    app.delete("/api/servers/:id", (req: Request, res: Response) => {
        try {
            const serverId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
            serverStore.deleteRemote(serverId);
            res.json({ deleted: true });
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "Could not remove server." });
        }
    });

    app.post("/api/servers/:id/pair", async (req: Request, res: Response) => {
        try {
            const serverId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
            const server = serverStore.requireRemote(serverId);
            const pairingToken = String((req.body as ServerPayload).pairingToken || "").trim();
            if (!pairingToken) {
                res.status(400).json({ error: "Pairing token is required." });
                return;
            }

            if (!server.baseUrl || !server.agentPublicEncryptionKey || !server.agentPublicSigningKey) {
                res.status(400).json({ error: "Server URL and agent public keys are required before pairing." });
                return;
            }

            const agentBaseUrl = server.baseUrl.replace(/\/+$/, "");
            const health = await fetchAgentHealth(agentBaseUrl, globalSettingsStore.readSettings());
            if (!health.ok) {
                res.status(400).json({
                    error: `Agent URL is not reaching an updater agent. ${health.message}`
                });
                return;
            }

            const pairResponse = await fetch(`${agentBaseUrl}/agent/pair`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    controllerId: controllerKeys.controllerId,
                    controllerPublicEncryptionKey: controllerKeys.encryptionPublicKey,
                    controllerPublicSigningKey: controllerKeys.signingPublicKey,
                    envelope: sealEnvelope({ pairingToken }, {
                        senderId: controllerKeys.controllerId,
                        recipientId: server.id,
                        messageType: "pair.request"
                    }, {
                        senderSigningPrivateKey: controllerKeys.signingPrivateKey,
                        recipientEncryptionPublicKey: server.agentPublicEncryptionKey
                    })
                })
            });

            if (!pairResponse.ok) {
                res.status(400).json({ error: `Agent pairing failed: ${await readResponseError(pairResponse)}` });
                return;
            }

            const paired = serverStore.markPaired(server.id, controllerKeys.encryptionPublicKey, controllerKeys.signingPublicKey);
            if (health.body?.capabilities) {
                res.json(serverStore.updateCapabilities(server.id, health.body.capabilities));
                return;
            }

            res.json(paired);
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "Could not pair server." });
        }
    });
}

/**
 * Creates a remote server and discovers public agent keys from `/agent/health`
 * when the UI only submits a base URL.
 */
async function createRemoteServer(payload: ServerPayload, serverStore: ServerStore, globalSettingsStore: GlobalSettingsStore, res: Response) {
    try {
        const baseUrl = String(payload.baseUrl || "").trim().replace(/\/+$/, "");
        const health = await fetchAgentHealth(baseUrl, globalSettingsStore.readSettings());
        if (!health.ok || !health.body) {
            res.status(400).json({ error: `Agent URL is not reaching an updater agent. ${health.message}` });
            return;
        }

        res.status(201).json(serverStore.createRemote({
            ...payload,
            id: payload.id || health.body.serverId,
            name: payload.name || health.body.serverId,
            baseUrl,
            agentPublicEncryptionKey: health.body.encryptionPublicKey,
            agentPublicSigningKey: health.body.signingPublicKey,
            capabilities: health.body.capabilities
        }));
    } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : "Could not create server." });
    }
}

/**
 * Checks that the configured URL points to the updater agent API, not a proxy
 * default site or another application.
 */
async function fetchAgentHealth(agentBaseUrl: string, globalSettings: GlobalSettings) {
    if (!agentBaseUrl) {
        return { ok: false, message: "Agent URL is required." };
    }

    const healthUrl = `${agentBaseUrl}/agent/health?traefikNetwork=${encodeURIComponent(globalSettings.defaultTraefikNetwork)}`;
    try {
        const response = await fetch(healthUrl);
        if (!response.ok) {
            return {
                ok: false,
                message: `${healthUrl} returned HTTP ${response.status}. Configure the proxy/port so this URL reaches the agent container.`
            };
        }

        const body = await response.json() as { serverId?: string; encryptionPublicKey?: string; signingPublicKey?: string; capabilities?: ServerCapabilities };
        if (!body.serverId || !body.encryptionPublicKey || !body.signingPublicKey) {
            return {
                ok: false,
                message: `${healthUrl} answered, but it did not look like an updater agent.`
            };
        }

        return { ok: true, message: "", body };
    } catch (error) {
        return {
            ok: false,
            message: `${healthUrl} could not be reached: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}

/**
 * Reads a concise error from a failed agent response.
 */
async function readResponseError(response: globalThis.Response) {
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
        const body = await response.json() as { error?: string };
        return body.error || `HTTP ${response.status}`;
    }

    const text = await response.text();
    return text.replace(/\s+/g, " ").trim().slice(0, 240) || `HTTP ${response.status}`;
}

/**
 * Registers project CRUD, manual deploy, compose import, and deployment history
 * endpoints.
 */
function registerProjectRoutes(app: Express, dependencies: Pick<RouteDependencies, "configStore" | "deploymentService" | "deploymentStore" | "runtimeOperationStore" | "globalSettingsStore" | "agentManager">) {
    const { configStore, deploymentService, deploymentStore, runtimeOperationStore, globalSettingsStore, agentManager } = dependencies;

    app.get("/api/projects", async (req: Request, res: Response, next: NextFunction) => {
        try {
            const globalSettings = globalSettingsStore.readSettings();
            const config = configStore.readConfig();
            await deploymentService.reconcileRunningDeployments(config);
            // Shape the storage record into the UI-facing project summary.
            const projects = Object.entries(config)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([name, settings]) => ({
                    id: settings.id,
                    name,
                    serverId: settings.serverId ?? "local",
                    repositoryUrl: settings.repositoryUrl ?? "",
                    path: settings.path ?? defaultProjectPath(globalSettings, name),
                    token: settings.token ? maskToken(settings.token) : "",
                    deployToken: settings.deployToken ? maskToken(settings.deployToken) : "",
                    composeOverride: settings.composeOverride ?? "",
                    hasComposeOverride: Boolean(settings.composeOverride),
                    traefik: settings.traefik ?? { enabled: false },
                    lastDeployment: deploymentStore.latest(settings.id ?? name)
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
            if (config[repoName]) {
                res.status(409).json({ error: "A project with that repository name already exists." });
                return;
            }

            config[repoName] = {
                serverId: payload.serverId?.trim() || "local",
                ...(repoToken ? { token: repoToken } : {}),
                ...(repositoryUrl ? { repositoryUrl } : {}),
                ...(deployToken ? { deployToken } : {}),
                ...(repoPath ? { path: repoPath } : {}),
                ...(composeOverride ? { composeOverride } : {}),
                ...(traefik ? { traefik } : {})
            };
            configStore.writeConfig(config);

            const created = configStore.resolveProject(repoName);
            res.status(201).json({ id: created?.settings.id, name: repoName });
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "Could not save project." });
        }
    });

    app.put("/api/projects/:name", (req: Request, res: Response) => {
        try {
            const rawCurrentName = req.params.name;
            const currentRef = normalizeProjectName(Array.isArray(rawCurrentName) ? rawCurrentName[0] : rawCurrentName);
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
            const existingProject = configStore.resolveProject(currentRef);
            const existing = existingProject?.settings;
            const currentName = existingProject?.name ?? currentRef;

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
                id: existing.id,
                serverId: payload.serverId?.trim() || existing.serverId || "local",
                token: nextToken || existing.token,
                ...(nextRepositoryUrl ? { repositoryUrl: nextRepositoryUrl } : {}),
                ...(nextDeployToken || existing.deployToken ? { deployToken: nextDeployToken || existing.deployToken } : {}),
                ...(nextPath ? { path: nextPath } : {}),
                composeOverride: composeOverride || undefined,
                ...(traefik ? { traefik } : {})
            };
            configStore.writeConfig(config);

            res.json({ id: existing.id, name: nextName });
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "Could not update project." });
        }
    });

    app.delete("/api/projects/:name", async (req: Request, res: Response) => {
        try {
            const rawProjectName = req.params.name;
            const projectRef = normalizeProjectName(Array.isArray(rawProjectName) ? rawProjectName[0] : rawProjectName);
            const payload = req.body as DeleteProjectPayload;
            const project = configStore.resolveProject(projectRef);
            const projectName = project?.name ?? projectRef;
            const config = configStore.readConfig();
            const appSettings = project?.settings;

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
            const agent = agentManager.getClient(appSettings.serverId ?? "local");

            if (payload.deleteCheckout) {
                const inspection = await agent.inspectCompose(projectName, appSettings, globalSettings);
                if (hasUnsafeRelativeBindMounts(inspection)) {
                    res.status(400).json({
                        error: `${inspection.unsafeRelativeBindMounts} relative bind mounts still point into the checkout. Map them to ${globalSettings.dataRoot}/${projectName}/... before deleting the repository folder.`
                    });
                    return;
                }
            }

            if (payload.stopContainers) {
                await agent.stopProject(projectName, appSettings, globalSettings);
                actions.push("containers stopped");
            }

            if (payload.deleteCheckout) {
                const checkoutPath = assertSafeDeletePath(appSettings.path ?? defaultProjectPath(globalSettings, projectName), globalSettings.dataRoot);
                const cleanup = await agent.deleteCheckout(checkoutPath);
                actions.push(...cleanup.steps);
                actions.push("checkout deleted");
            }

            if (payload.deleteDeploymentHistory) {
                deploymentStore.deleteProject(appSettings.id ?? projectName);
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
        const projectRef = normalizeProjectName(Array.isArray(rawProjectName) ? rawProjectName[0] : rawProjectName);
        const project = configStore.resolveProject(projectRef);
        const projectName = project?.name ?? projectRef;
        const appSettings = project?.settings;

        if (!appSettings) {
            res.status(404).json({ error: "Project does not exist." });
            return;
        }

        const deployment = deploymentService.startDeployment(projectName, appSettings, "manual");
        res.status(200).json({ status: "Build worker dispatched", deploymentId: deployment.id });
    });

    app.post("/api/projects/:name/deployments/cancel", (req: Request, res: Response) => {
        try {
            const rawProjectName = req.params.name;
            const projectRef = normalizeProjectName(Array.isArray(rawProjectName) ? rawProjectName[0] : rawProjectName);
            const project = configStore.resolveProject(projectRef);
            const projectName = project?.name ?? projectRef;
            const appSettings = project?.settings;

            if (!appSettings) {
                res.status(404).json({ error: "Project does not exist." });
                return;
            }

            res.json(deploymentService.cancelDeployment(projectName, appSettings));
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "Could not cancel deployment." });
        }
    });

    app.post("/api/projects/:name/compose/import", async (req: Request, res: Response) => {
        try {
            const rawProjectName = req.params.name;
            const projectRef = normalizeProjectName(Array.isArray(rawProjectName) ? rawProjectName[0] : rawProjectName);
            const project = configStore.resolveProject(projectRef);
            const projectName = project?.name ?? projectRef;
            const appSettings = project?.settings;

            if (!appSettings) {
                res.status(404).json({ error: "Project does not exist." });
                return;
            }

            const importedCompose = await agentManager.getClient(appSettings.serverId ?? "local").importCompose(projectName, appSettings, globalSettingsStore.readSettings());
            res.json(importedCompose);
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "Could not import Docker Compose file." });
        }
    });

    app.get("/api/projects/:name/compose/inspect", async (req: Request, res: Response) => {
        try {
            const rawProjectName = req.params.name;
            const projectRef = normalizeProjectName(Array.isArray(rawProjectName) ? rawProjectName[0] : rawProjectName);
            const project = configStore.resolveProject(projectRef);
            const projectName = project?.name ?? projectRef;
            const appSettings = project?.settings;

            if (!appSettings) {
                res.status(404).json({ error: "Project does not exist." });
                return;
            }

            const inspection = await agentManager.getClient(appSettings.serverId ?? "local").inspectCompose(projectName, appSettings, globalSettingsStore.readSettings());
            res.json(inspection);
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "Could not inspect Docker Compose file." });
        }
    });

    app.get("/api/projects/:name/compose/validate", async (req: Request, res: Response) => {
        try {
            const rawProjectName = req.params.name;
            const projectRef = normalizeProjectName(Array.isArray(rawProjectName) ? rawProjectName[0] : rawProjectName);
            const project = configStore.resolveProject(projectRef);
            const projectName = project?.name ?? projectRef;
            const appSettings = project?.settings;

            if (!appSettings) {
                res.status(404).json({ error: "Project does not exist." });
                return;
            }

            const validation = await agentManager.getClient(appSettings.serverId ?? "local").validateCompose(projectName, appSettings, globalSettingsStore.readSettings());
            res.json(validation);
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "Could not validate Docker Compose file." });
        }
    });

    app.post("/api/projects/:name/compose/validate", async (req: Request, res: Response) => {
        try {
            const rawProjectName = req.params.name;
            const currentRef = normalizeProjectName(Array.isArray(rawProjectName) ? rawProjectName[0] : rawProjectName);
            const project = configStore.resolveProject(currentRef);
            const existing = project?.settings;

            if (!existing) {
                res.status(404).json({ error: "Project does not exist." });
                return;
            }

            const payload = req.body as ProjectPayload;
            const globalSettings = globalSettingsStore.readSettings();
            const projectName = normalizeProjectName(payload.name || project?.name || currentRef);
            const repositoryUrl = normalizeRepositoryUrl(payload.repositoryUrl);
            const composeOverride = payload.composeOverride?.trim();
            const traefik = normalizeTraefikSettings(payload, globalSettings);
            const appSettings: ProjectSettings = {
                id: existing.id,
                serverId: payload.serverId?.trim() || existing.serverId || "local",
                token: existing.token,
                deployToken: existing.deployToken,
                ...(repositoryUrl ? { repositoryUrl } : existing.repositoryUrl ? { repositoryUrl: existing.repositoryUrl } : {}),
                ...(payload.path?.trim() ? { path: payload.path.trim() } : existing.path ? { path: existing.path } : {}),
                ...(composeOverride ? { composeOverride } : {}),
                ...(traefik ? { traefik } : {})
            };

            const validation = await agentManager.getClient(appSettings.serverId ?? "local").validateCompose(projectName, appSettings, globalSettings);
            res.json(validation);
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "Could not validate Docker Compose file." });
        }
    });

    app.get("/api/projects/:name/status", async (req: Request, res: Response) => {
        try {
            const rawProjectName = req.params.name;
            const projectRef = normalizeProjectName(Array.isArray(rawProjectName) ? rawProjectName[0] : rawProjectName);
            const project = configStore.resolveProject(projectRef);
            const projectName = project?.name ?? projectRef;
            const appSettings = project?.settings;

            if (!appSettings) {
                res.status(404).json({ error: "Project does not exist." });
                return;
            }

            const status = await agentManager.getClient(appSettings.serverId ?? "local").inspectStatus(projectName, appSettings, globalSettingsStore.readSettings());
            res.json(status);
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "Could not inspect project status." });
        }
    });

    app.get("/api/projects/:name/traefik/diagnostics", async (req: Request, res: Response) => {
        try {
            const rawProjectName = req.params.name;
            const projectRef = normalizeProjectName(Array.isArray(rawProjectName) ? rawProjectName[0] : rawProjectName);
            const project = configStore.resolveProject(projectRef);
            const projectName = project?.name ?? projectRef;
            const appSettings = project?.settings;

            if (!appSettings) {
                res.status(404).json({ error: "Project does not exist." });
                return;
            }

            const diagnostics = await agentManager.getClient(appSettings.serverId ?? "local").diagnoseTraefik(projectName, appSettings, globalSettingsStore.readSettings());
            res.json(diagnostics);
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "Could not diagnose Traefik." });
        }
    });

    app.get("/api/projects/:name/runtime-logs", async (req: Request, res: Response) => {
        try {
            const rawProjectName = req.params.name;
            const projectRef = normalizeProjectName(Array.isArray(rawProjectName) ? rawProjectName[0] : rawProjectName);
            const project = configStore.resolveProject(projectRef);
            const projectName = project?.name ?? projectRef;
            const appSettings = project?.settings;
            const service = String(req.query.service || "").trim();
            const tail = Number(req.query.tail || 200);

            if (!appSettings) {
                res.status(404).json({ error: "Project does not exist." });
                return;
            }

            if (!service) {
                res.status(400).json({ error: "Service is required." });
                return;
            }

            const logs = await agentManager.getClient(appSettings.serverId ?? "local").runtimeLogs(projectName, appSettings, globalSettingsStore.readSettings(), service, tail);
            res.json(logs);
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "Could not read runtime logs." });
        }
    });

    app.post("/api/projects/:name/runtime-actions", async (req: Request, res: Response) => {
        try {
            const rawProjectName = req.params.name;
            const projectRef = normalizeProjectName(Array.isArray(rawProjectName) ? rawProjectName[0] : rawProjectName);
            const project = configStore.resolveProject(projectRef);
            const projectName = project?.name ?? projectRef;
            const appSettings = project?.settings;
            const service = String(req.body.service || "").trim();
            const action = String(req.body.action || "").trim() as RuntimeServiceAction;

            if (!appSettings) {
                res.status(404).json({ error: "Project does not exist." });
                return;
            }

            if (!service) {
                res.status(400).json({ error: "Service is required." });
                return;
            }

            if (!isRuntimeServiceAction(action)) {
                res.status(400).json({ error: "Unsupported runtime action." });
                return;
            }

            const startedAt = new Date().toISOString();
            try {
                const result = await agentManager.getClient(appSettings.serverId ?? "local").runtimeAction(projectName, appSettings, globalSettingsStore.readSettings(), service, action);
                const record = runtimeOperationStore.record(projectName, {
                    serverId: appSettings.serverId ?? "local",
                    service: result.service,
                    action: result.action,
                    status: "succeeded",
                    startedAt,
                    finishedAt: result.checkedAt,
                    output: result.output
                });
                res.json({ ...result, operation: record });
            } catch (error) {
                const message = error instanceof Error ? error.message : "Could not run runtime action.";
                const record = runtimeOperationStore.record(projectName, {
                    serverId: appSettings.serverId ?? "local",
                    service,
                    action,
                    status: "failed",
                    startedAt,
                    finishedAt: new Date().toISOString(),
                    error: message,
                    output: message
                });
                res.status(400).json({ error: message, operation: record });
            }
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "Could not run runtime action." });
        }
    });

    app.get("/api/projects/:name/runtime-operations", (req: Request, res: Response) => {
        try {
            const rawProjectName = req.params.name;
            const projectRef = normalizeProjectName(Array.isArray(rawProjectName) ? rawProjectName[0] : rawProjectName);
            const project = configStore.resolveProject(projectRef);

            if (!project) {
                res.status(404).json({ error: "Project does not exist." });
                return;
            }

            res.json(runtimeOperationStore.list(project.settings.id ?? project.name));
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "Could not load runtime operations." });
        }
    });

    app.get("/api/projects/:name/deployments", (req: Request, res: Response) => {
        const rawProjectName = req.params.name;
        const projectRef = normalizeProjectName(Array.isArray(rawProjectName) ? rawProjectName[0] : rawProjectName);
        const project = configStore.resolveProject(projectRef);

        if (!project) {
            res.status(404).json({ error: "Project does not exist." });
            return;
        }

        res.json(deploymentStore.list(project.settings.id ?? project.name));
    });

    app.get("/api/projects/:name/deployments/latest", async (req: Request, res: Response) => {
        try {
            const rawProjectName = req.params.name;
            const projectRef = normalizeProjectName(Array.isArray(rawProjectName) ? rawProjectName[0] : rawProjectName);
            const project = configStore.resolveProject(projectRef);

            if (!project) {
                res.status(404).json({ error: "Project does not exist." });
                return;
            }

            res.json(await deploymentService.reconcileLatestDeployment(project.name, project.settings));
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "Could not load latest deployment." });
        }
    });
}

/**
 * Registers the GitLab webhook endpoint.
 */
function registerWebhookRoute(app: Express, dependencies: Pick<RouteDependencies, "configStore" | "deploymentService">) {
    const { configStore, deploymentService } = dependencies;

    app.post("/webhook/:name", (req: Request, res: Response) => {
        const rawProjectName = req.params.name;
        const projectRef = normalizeProjectName(Array.isArray(rawProjectName) ? rawProjectName[0] : rawProjectName);
        handleWebhook(req, res, configStore.resolveProject(projectRef));
    });

    app.post("/webhook", (req: Request, res: Response) => {
        handleWebhook(req, res, resolveWebhookProject(req.body, configStore.readConfig()));
    });

    function handleWebhook(req: Request, res: Response, webhookProject: { name?: string; projectName?: string; settings?: ProjectSettings; appSettings?: ProjectSettings } | null | undefined) {
        const event = req.headers["x-gitlab-event"];

        if (event !== "Push Hook") {
            res.status(202).send("Ignored event");
            return;
        }

        if (!webhookProject) {
            throw new Error("No config for this repository");
        }

        const projectName = webhookProject.projectName ?? webhookProject.name;
        const appSettings = webhookProject.appSettings ?? webhookProject.settings;
        if (!projectName || !appSettings) {
            throw new Error("No config for this repository");
        }

        if (!appSettings.token) {
            res.status(403).send("Webhook secret token is not configured for this project.");
            return;
        }

        if (verifySignature(appSettings.token, req, res)) {
            const deployment = deploymentService.startDeployment(projectName, appSettings, "webhook");
            console.log(`Webhook deployment dispatched for ${projectName} (${deployment.id}).`);
            res.status(200).send("Build worker dispatched");
        }
    }
}

/**
 * Registers the token-protected CI deploy trigger endpoint.
 */
function registerCiDeployRoute(app: Express, dependencies: Pick<RouteDependencies, "configStore" | "deploymentService">) {
    const { configStore, deploymentService } = dependencies;

    app.post("/api/deploy/:name", (req: Request, res: Response) => {
        const rawProjectName = req.params.name;
        const projectRef = normalizeProjectName(Array.isArray(rawProjectName) ? rawProjectName[0] : rawProjectName);
        const project = configStore.resolveProject(projectRef);
        const projectName = project?.name ?? projectRef;
        const appSettings = project?.settings;

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

function isRuntimeServiceAction(value: string): value is RuntimeServiceAction {
    return ["restart", "start", "stop", "recreate", "pull"].includes(value);
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
