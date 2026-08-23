import { existsSync } from "node:fs";
import { join } from "node:path";
import express, { Express, NextFunction, Request, Response } from "express";
import { AgentManager } from "./agentManager.js";
import { AgentHealthService } from "./agentHealth.js";
import { sealEnvelope } from "./agentCrypto.js";
import { AdminAuth } from "./auth.js";
import { assertSafeDeletePath } from "./checkoutCleanup.js";
import { countBindMountsInsidePath, hasUnsafeRelativeBindMounts } from "./composeInspection.js";
import { writeControllerBackup } from "./configAutoBackup.js";
import { ConfigStore, maskSecretValue, maskToken } from "./configStore.js";
import { DeploymentStore } from "./deploymentStore.js";
import { DeploymentService } from "./deploymentService.js";
import { EventBus } from "./eventBus.js";
import { defaultProjectPath, GlobalSettingsStore, normalizeGlobalSettings } from "./globalSettingsStore.js";
import { ControllerKeyState } from "./keyStore.js";
import { AppDatabase, ControllerStateBackup } from "./database.js";
import { browseContainerPath } from "./pathBrowser.js";
import { runProjectPreflight } from "./projectPreflight.js";
import { parseProjectComposeImport, renderProjectComposeExport } from "./projectComposeTransfer.js";
import { RuntimeOperationStore } from "./runtimeOperationStore.js";
import { RuntimeStatusStreamHub } from "./runtimeStatusStreams.js";
import { NotificationService } from "./notificationService.js";
import { NotificationStore } from "./notificationStore.js";
import { ServerStore } from "./serverStore.js";
import { ReleaseStore } from "./releaseStore.js";
import { verifySignatureDetailed } from "./signature.js";
import { collectSystemMetrics } from "./systemMetrics.js";
import { DeleteProjectPayload, GlobalSettings, GlobalSettingsPayload, ProjectEnvironmentSecret, ProjectPayload, ProjectReleaseSnapshot, ProjectSettings, RuntimeServiceAction, ServerPayload, TraefikAffectedProject, TraefikDefaultsPayload, VaultSecretPayload } from "./types.js";
import { VaultSecretStore } from "./vaultSecretStore.js";
import { normalizeProjectName, normalizeRepositoryUrl, normalizeTraefikSettings } from "./validation.js";
import { resolveWebhookProject, webhookProjectCandidates } from "./webhookResolver.js";
import { WebhookStore } from "./webhookStore.js";

/**
 * Dependencies required by the HTTP route layer.
 */
export interface RouteDependencies {
    adminAuth: AdminAuth;
    database: AppDatabase;
    configStore: ConfigStore;
    deploymentService: DeploymentService;
    deploymentStore: DeploymentStore;
    releaseStore: ReleaseStore;
    webhookStore: WebhookStore;
    notificationStore: NotificationStore;
    runtimeOperationStore: RuntimeOperationStore;
    globalSettingsStore: GlobalSettingsStore;
    agentManager: AgentManager;
    controllerKeys: ControllerKeyState;
    serverStore: ServerStore;
    vaultSecretStore: VaultSecretStore;
    runtimeStatusStreams: RuntimeStatusStreamHub;
    agentHealth: AgentHealthService;
    eventBus: EventBus;
    notificationService: NotificationService;
}

/**
 * Registers all HTTP routes for the controller API and Angular frontend.
 */
export function registerRoutes(app: Express, dependencies: RouteDependencies) {
    const { adminAuth, database, configStore, deploymentService, deploymentStore, releaseStore, webhookStore, notificationStore, runtimeOperationStore, globalSettingsStore, agentManager, controllerKeys, serverStore, vaultSecretStore, runtimeStatusStreams, agentHealth, eventBus, notificationService } = dependencies;

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
    app.use("/api/secrets", adminAuth.requireAuth);

    registerSettingsRoutes(app, { database, globalSettingsStore, eventBus, notificationService, notificationStore });
    registerSecretRoutes(app, { vaultSecretStore });
    registerServerRoutes(app, { serverStore, configStore, controllerKeys, agentManager, globalSettingsStore, agentHealth, eventBus });
    registerProjectRoutes(app, { configStore, deploymentService, deploymentStore, releaseStore, webhookStore, runtimeOperationStore, globalSettingsStore, agentManager, vaultSecretStore, runtimeStatusStreams, eventBus });
    registerWebhookRoute(app, { configStore, deploymentService, webhookStore });
    registerCiDeployRoute(app, { configStore, deploymentService });
    registerFrontendRoutes(app);
}

/**
 * Registers global settings read/write endpoints.
 */
function registerSettingsRoutes(app: Express, dependencies: Pick<RouteDependencies, "database" | "globalSettingsStore" | "eventBus" | "notificationService" | "notificationStore">) {
    const { database, globalSettingsStore, eventBus, notificationService, notificationStore } = dependencies;

    app.get("/api/settings", (req: Request, res: Response) => {
        res.json(publicGlobalSettings(globalSettingsStore.readSettings()));
    });

    app.put("/api/settings", (req: Request, res: Response) => {
        try {
            const settings = globalSettingsStore.writeSettings(req.body as GlobalSettingsPayload);
            res.json(publicGlobalSettings(settings));
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "Could not save global settings." });
        }
    });

    app.post("/api/settings/notifications/test", async (req: Request, res: Response) => {
        try {
            res.json(await notificationService.sendTest(typeof req.body.channelId === "string" ? req.body.channelId : undefined));
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "Could not send test notification." });
        }
    });

    app.get("/api/settings/notifications/history", (req: Request, res: Response) => {
        const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : 100;
        res.json(notificationStore.list(Number.isFinite(limit) ? limit : 100));
    });

    app.get("/api/settings/backup", (req: Request, res: Response) => {
        try {
            const backup = database.exportBackup();
            res.setHeader("content-disposition", `attachment; filename="deploy-backup-${backup.createdAt.slice(0, 10)}.json"`);
            res.json(backup);
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "Could not export backup." });
        }
    });

    app.post("/api/settings/backup/test", (req: Request, res: Response) => {
        try {
            const settings = normalizeGlobalSettings({ ...globalSettingsStore.readSettings(), ...(req.body as GlobalSettingsPayload) });
            const result = writeControllerBackup(database.exportBackup(), settings.autoBackupPath);
            res.json({ ok: true, ...result });
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "Could not write test backup." });
        }
    });

    app.get("/api/settings/paths/browse", (req: Request, res: Response) => {
        try {
            const path = typeof req.query.path === "string" ? req.query.path : "/";
            res.json(browseContainerPath(path));
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "Could not browse path." });
        }
    });

    app.post("/api/settings/backup/restore", (req: Request, res: Response) => {
        try {
            database.restoreBackup(req.body as ControllerStateBackup);
            eventBus.publish({ type: "servers.updated", changedAt: new Date().toISOString() });
            eventBus.publish({ type: "projects.updated", changedAt: new Date().toISOString() });
            res.json({ restored: true, restartRecommended: Boolean(req.body?.keys?.controllerKeys) });
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "Could not restore backup." });
        }
    });
}

/**
 * Registers central vault secret endpoints.
 */
function registerSecretRoutes(app: Express, dependencies: Pick<RouteDependencies, "vaultSecretStore">) {
    const { vaultSecretStore } = dependencies;

    app.get("/api/secrets", (req: Request, res: Response) => {
        try {
            const namespace = typeof req.query.namespace === "string" ? req.query.namespace : undefined;
            res.json(vaultSecretStore.list(namespace));
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "Could not load secrets." });
        }
    });

    app.post("/api/secrets", (req: Request, res: Response) => {
        try {
            const secret = vaultSecretStore.create(req.body as VaultSecretPayload);
            res.status(201).json(secret);
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "Could not create secret." });
        }
    });

    app.put("/api/secrets/:id", (req: Request, res: Response) => {
        try {
            const secretId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
            const payload = req.body as VaultSecretPayload;
            const { value, ...metadata } = payload;
            const secret = vaultSecretStore.update(secretId, {
                ...metadata,
                ...(value?.trim() ? { value } : {})
            });
            res.json(secret);
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "Could not update secret." });
        }
    });

    app.delete("/api/secrets/:id", (req: Request, res: Response) => {
        try {
            const secretId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
            res.json(vaultSecretStore.delete(secretId));
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "Could not delete secret." });
        }
    });
}

/**
 * Registers target-server read endpoints.
 */
function registerServerRoutes(app: Express, dependencies: Pick<RouteDependencies, "serverStore" | "configStore" | "controllerKeys" | "agentManager" | "globalSettingsStore" | "agentHealth" | "eventBus">) {
    const { serverStore, configStore, controllerKeys, agentManager, globalSettingsStore, agentHealth, eventBus } = dependencies;

    app.get("/api/servers", async (req: Request, res: Response) => {
        await agentHealth.refreshLocal();
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

            const system = server.kind === "local" ? await collectSystemMetrics() : server.capabilities?.system;
            const capabilities = {
                docker: await agentManager.getClient(serverId).inspectDocker(),
                traefik: await agentManager.getClient(serverId).detectTraefik(globalSettingsStore.readSettings()),
                ...(system ? { system } : {})
            };
            serverStore.updateCapabilities(serverId, capabilities);
            res.json(capabilities);
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "Could not inspect server capabilities." });
        }
    });

    app.get("/api/servers/:id/paths/browse", async (req: Request, res: Response) => {
        try {
            const serverId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
            const server = serverStore.get(serverId);
            if (!server) {
                res.status(404).json({ error: "Server does not exist." });
                return;
            }

            const path = typeof req.query.path === "string" ? req.query.path : "/";
            res.json(await agentManager.getClient(serverId).browsePath(path));
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "Could not browse host path." });
        }
    });

    app.get("/api/servers/:id/traefik/backup", async (req: Request, res: Response) => {
        try {
            const serverId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
            const server = serverStore.get(serverId);
            if (!server) {
                res.status(404).json({ error: "Server does not exist." });
                return;
            }

            const backup = await agentManager.getClient(serverId).backupTraefik(serverId, globalSettingsStore.readSettings());
            res.json(backup);
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "Could not export Traefik backup." });
        }
    });

    app.get("/api/servers/:id/traefik/validate", async (req: Request, res: Response) => {
        try {
            const serverId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
            const server = serverStore.get(serverId);
            if (!server) {
                res.status(404).json({ error: "Server does not exist." });
                return;
            }

            const validation = await agentManager.getClient(serverId).validateTraefik(serverId, globalSettingsStore.readSettings());
            res.json(validation);
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "Could not validate Traefik config." });
        }
    });

    app.get("/api/servers/:id/traefik/impact", async (req: Request, res: Response) => {
        try {
            const serverId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
            const server = serverStore.get(serverId);
            if (!server) {
                res.status(404).json({ error: "Server does not exist." });
                return;
            }

            const settings = globalSettingsStore.readSettings();
            const projects = buildTraefikImpactProjects(configStore.readConfig(), serverId, settings);
            res.json({
                serverId,
                checkedAt: new Date().toISOString(),
                defaults: {
                    network: settings.defaultTraefikNetwork,
                    entryPoints: settings.defaultTraefikEntryPoints,
                    certResolver: settings.defaultTraefikCertResolver
                },
                projectCount: projects.length,
                projects
            });
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "Could not preview Traefik impact." });
        }
    });

    app.post("/api/servers/:id/traefik/defaults", async (req: Request, res: Response) => {
        try {
            const serverId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
            const server = serverStore.get(serverId);
            if (!server) {
                res.status(404).json({ error: "Server does not exist." });
                return;
            }

            const payload = normalizeTraefikDefaultsPayload(req.body as TraefikDefaultsPayload);
            const currentSettings = globalSettingsStore.readSettings();
            const nextSettings = {
                ...currentSettings,
                defaultTraefikNetwork: payload.network || currentSettings.defaultTraefikNetwork,
                defaultTraefikEntryPoints: payload.entryPoints || currentSettings.defaultTraefikEntryPoints,
                defaultTraefikCertResolver: payload.certResolver || currentSettings.defaultTraefikCertResolver
            };

            let applyResult = null;
            if (payload.applyToServer) {
                applyResult = await agentManager.getClient(serverId).applyTraefikDefaults(serverId, nextSettings, payload);
            }

            globalSettingsStore.writeSettings(nextSettings);
            const capabilities = {
                docker: await agentManager.getClient(serverId).inspectDocker(),
                traefik: await agentManager.getClient(serverId).detectTraefik(nextSettings),
                ...(server.kind === "local" ? { system: await collectSystemMetrics() } : server.capabilities?.system ? { system: server.capabilities.system } : {})
            };
            const updatedServer = serverStore.updateCapabilities(serverId, capabilities);
            eventBus.publish({ type: "server.health", server: updatedServer ?? server });

            res.json({
                settings: nextSettings,
                applyResult,
                server: updatedServer
            });
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "Could not update Traefik defaults." });
        }
    });

    app.post("/api/servers/:id/health", async (req: Request, res: Response) => {
        try {
            const serverId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
            const server = serverStore.get(serverId);
            if (!server) {
                res.status(404).json({ error: "Server does not exist." });
                return;
            }

            res.json(await agentHealth.refreshServer(server.id));
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "Could not refresh server health." });
        }
    });

    app.post("/api/servers", (req: Request, res: Response) => {
        try {
            void createRemoteServer(req.body as ServerPayload, serverStore, agentHealth, eventBus, res);
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "Could not create server." });
        }
    });

    app.put("/api/servers/:id", (req: Request, res: Response) => {
        try {
            const serverId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
            const server = serverStore.updateServer(serverId, req.body as ServerPayload);
            eventBus.publish({ type: "servers.updated", changedAt: new Date().toISOString() });
            res.json(server);
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "Could not update server." });
        }
    });

    app.delete("/api/servers/:id", (req: Request, res: Response) => {
        try {
            const serverId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
            serverStore.deleteRemote(serverId);
            eventBus.publish({ type: "servers.updated", changedAt: new Date().toISOString() });
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

            if (!server.baseUrl) {
                res.status(400).json({ error: "Server URL is required before pairing." });
                return;
            }

            const agentBaseUrl = server.baseUrl.replace(/\/+$/, "");
            const health = await agentHealth.fetchAgentHealth(agentBaseUrl);
            if (!health.ok || !health.body) {
                res.status(400).json({
                    error: `Agent URL is not reaching a Deploy agent. ${health.message}`
                });
                return;
            }
            const agentEncryptionPublicKey = health.body.encryptionPublicKey;
            const agentSigningPublicKey = health.body.signingPublicKey;
            if (!agentEncryptionPublicKey || !agentSigningPublicKey) {
                res.status(400).json({ error: "Agent health response is missing public keys." });
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
                        recipientId: health.body?.serverId || server.agentServerId || server.id,
                        messageType: "pair.request"
                    }, {
                        senderSigningPrivateKey: controllerKeys.signingPrivateKey,
                        recipientEncryptionPublicKey: agentEncryptionPublicKey
                    })
                })
            });

            if (!pairResponse.ok) {
                res.status(400).json({ error: `Agent pairing failed: ${await readResponseError(pairResponse)}` });
                return;
            }

            const paired = serverStore.markPaired(
                server.id,
                controllerKeys.encryptionPublicKey,
                controllerKeys.signingPublicKey,
                agentEncryptionPublicKey,
                agentSigningPublicKey
            );
            const updated = serverStore.updateHealth(server.id, {
                status: "online",
                agentServerId: health.body?.serverId,
                agentVersion: health.body?.version,
                activeJobs: health.body?.activeJobs ?? [],
                capabilities: health.body?.capabilities
            }) ?? paired;
            if (!updated) {
                res.status(400).json({ error: "Could not update paired server health." });
                return;
            }
            eventBus.publish({ type: "server.health", server: updated });
            eventBus.publish({ type: "servers.updated", changedAt: new Date().toISOString() });
            res.json(updated);
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "Could not pair server." });
        }
    });
}

function buildTraefikImpactProjects(config: Record<string, ProjectSettings>, serverId: string, globalSettings: GlobalSettings): TraefikAffectedProject[] {
    return Object.entries(config)
        .filter(([, settings]) => targetServerIds(settings).includes(serverId) && settings.traefik?.enabled)
        .map(([name, settings]) => {
            const traefik = settings.traefik;
            const network = traefik?.network || globalSettings.defaultTraefikNetwork;
            const entryPoints = traefik?.entryPoints || globalSettings.defaultTraefikEntryPoints;
            const certResolver = traefik?.certResolver || globalSettings.defaultTraefikCertResolver;

            return {
                ...(settings.id ? { id: settings.id } : {}),
                name,
                ...(traefik?.hostname ? { hostname: traefik.hostname } : {}),
                ...(traefik?.service ? { service: traefik.service } : {}),
                ...(traefik?.port ? { port: traefik.port } : {}),
                network,
                entryPoints,
                certResolver,
                ...(traefik?.wildcardCertificate && traefik.wildcardDomain ? { wildcardDomain: traefik.wildcardDomain } : {}),
                usesDefaultNetwork: !traefik?.network,
                usesDefaultEntryPoints: !traefik?.entryPoints,
                usesDefaultCertResolver: !traefik?.certResolver
            };
        })
        .sort((left, right) => left.name.localeCompare(right.name));
}

function normalizeTraefikDefaultsPayload(payload: TraefikDefaultsPayload): Required<Pick<TraefikDefaultsPayload, "applyToServer">> & TraefikDefaultsPayload {
    const network = payload.network?.trim();
    const entryPoints = payload.entryPoints?.trim();
    const certResolver = payload.certResolver?.trim();
    const acmeEmail = payload.acmeEmail?.trim();
    const acmeStorage = payload.acmeStorage?.trim();
    const wildcardDomain = payload.wildcardDomain?.trim();

    if (network && !/^[a-zA-Z0-9._-]+$/.test(network)) {
        throw new Error("Traefik network can only contain letters, numbers, dots, underscores, and hyphens.");
    }
    if (entryPoints && !/^[a-zA-Z0-9._,-]+$/.test(entryPoints)) {
        throw new Error("Traefik entrypoints can only contain letters, numbers, dots, underscores, hyphens, and commas.");
    }
    if (certResolver && !/^[a-zA-Z0-9._-]+$/.test(certResolver)) {
        throw new Error("Traefik cert resolver can only contain letters, numbers, dots, underscores, and hyphens.");
    }
    if (wildcardDomain && !/^[a-zA-Z0-9.-]+$/.test(wildcardDomain)) {
        throw new Error("Wildcard domain can only contain letters, numbers, dots, and hyphens.");
    }
    if (acmeEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(acmeEmail)) {
        throw new Error("ACME email must be a valid email address.");
    }
    if (acmeStorage && !/^\/?[a-zA-Z0-9._/-]+$/.test(acmeStorage)) {
        throw new Error("ACME storage path contains unsupported characters.");
    }

    return {
        ...(network ? { network } : {}),
        ...(entryPoints ? { entryPoints } : {}),
        ...(certResolver ? { certResolver } : {}),
        ...(acmeEmail ? { acmeEmail } : {}),
        ...(acmeStorage ? { acmeStorage } : {}),
        ...(wildcardDomain ? { wildcardDomain } : {}),
        applyToServer: Boolean(payload.applyToServer)
    };
}

function payloadProjectName(payload: ProjectPayload) {
    return payload.project?.name?.trim() || payload.name?.trim();
}

function payloadServerId(payload: ProjectPayload, fallback = "local") {
    return payloadServerIds(payload, [fallback])[0] || fallback;
}

function payloadServerIds(payload: ProjectPayload, fallback = ["local"]) {
    const ids = (payload.project?.serverIds?.length ? payload.project.serverIds : payload.serverIds?.length ? payload.serverIds : payload.project?.serverId || payload.serverId ? [payload.project?.serverId ?? payload.serverId ?? "local"] : fallback)
        .map((serverId) => serverId.trim())
        .filter(Boolean);
    return [...new Set(ids.length ? ids : ["local"])];
}

function payloadProjectPath(payload: ProjectPayload) {
    return payload.project?.path?.trim() || payload.path?.trim() || "";
}

function payloadRepositoryUrl(payload: ProjectPayload) {
    return payload.git?.repositoryUrl?.trim() || payload.repositoryUrl?.trim();
}

function payloadGitToken(payload: ProjectPayload) {
    return payload.git?.token?.trim() || payload.token?.trim();
}

function payloadDeployToken(payload: ProjectPayload) {
    return payload.deployment?.deployToken?.trim() || payload.deployToken?.trim();
}

function payloadDeploymentStrategy(payload: ProjectPayload, fallback: "compose" | "swarm" = "compose") {
    const value = payload.deployment?.strategy ?? payload.deployment?.deploymentStrategy ?? payload.deploymentStrategy;
    if (value === "swarm") {
        return "swarm" as const;
    }
    if (value === "compose") {
        return "compose" as const;
    }
    return fallback;
}

function payloadRegistrySettings(payload: ProjectPayload, fallback?: ProjectSettings["registry"]) {
    const registry = payload.registry ?? {};
    const publish = Boolean(registry.publish ?? payload.registryPublish ?? fallback?.publish);
    const deployFromRegistry = Boolean(registry.deployFromRegistry ?? payload.registryDeployFromRegistry ?? fallback?.deployFromRegistry);
    const imageNamespace = (registry.imageNamespace ?? payload.registryImageNamespace ?? fallback?.imageNamespace)?.trim() || "";
    const imageTag = (registry.imageTag ?? payload.registryImageTag ?? fallback?.imageTag)?.trim() || "";

    return {
        publish,
        deployFromRegistry,
        ...(imageNamespace ? { imageNamespace } : {}),
        ...(imageTag ? { imageTag } : {})
    };
}

function publicGlobalSettings(settings: GlobalSettings): GlobalSettings {
    return {
        ...settings,
        registryPassword: settings.registryPassword ? maskSecretValue(settings.registryPassword) : "",
        notifications: {
            ...settings.notifications,
            channels: settings.notifications.channels.map((channel) => ({
                ...channel,
                slackWebhookUrl: channel.slackWebhookUrl ? maskSecretValue(channel.slackWebhookUrl) : "",
                pushoverToken: channel.pushoverToken ? maskSecretValue(channel.pushoverToken) : "",
                pushoverUser: channel.pushoverUser ? maskSecretValue(channel.pushoverUser) : "",
                smtpPassword: channel.smtpPassword ? maskSecretValue(channel.smtpPassword) : ""
            }))
        }
    };
}

function payloadComposeOverride(payload: ProjectPayload) {
    return payload.compose?.override?.trim() || payload.composeOverride?.trim();
}

function payloadEnvSecrets(payload: ProjectPayload) {
    return payload.compose?.envSecrets ?? payload.envSecrets;
}

/**
 * Creates a remote server and discovers public agent keys from `/agent/health`
 * when the UI only submits a base URL.
 */
async function createRemoteServer(payload: ServerPayload, serverStore: ServerStore, agentHealth: AgentHealthService, eventBus: EventBus, res: Response) {
    try {
        const baseUrl = String(payload.baseUrl || "").trim().replace(/\/+$/, "");
        const health = await agentHealth.fetchAgentHealth(baseUrl);
        if (!health.ok || !health.body) {
            res.status(400).json({ error: `Agent URL is not reaching a Deploy agent. ${health.message}` });
            return;
        }

        const baseServerId = payload.id || health.body.serverId || "server";
        const serverId = serverStore.nextAvailableId(baseServerId);

        const created = serverStore.createRemote({
            ...payload,
            id: serverId,
            agentServerId: health.body.serverId,
            name: payload.name || health.body.serverId,
            baseUrl,
            agentPublicEncryptionKey: health.body.encryptionPublicKey,
            agentPublicSigningKey: health.body.signingPublicKey,
            capabilities: health.body.capabilities
        });
        if (!created) {
            res.status(400).json({ error: "Could not create server." });
            return;
        }

        const updated = serverStore.updateHealth(created.id, {
            status: health.body.paired ? "online" : "unpaired",
            agentServerId: health.body.serverId,
            agentVersion: health.body.version,
            activeJobs: health.body.activeJobs ?? [],
            capabilities: health.body.capabilities
        }) ?? created;
        eventBus.publish({ type: "server.health", server: updated });
        eventBus.publish({ type: "servers.updated", changedAt: new Date().toISOString() });
        res.status(201).json(updated);
    } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : "Could not create server." });
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
function registerProjectRoutes(app: Express, dependencies: Pick<RouteDependencies, "configStore" | "deploymentService" | "deploymentStore" | "releaseStore" | "webhookStore" | "runtimeOperationStore" | "globalSettingsStore" | "agentManager" | "vaultSecretStore" | "runtimeStatusStreams" | "eventBus">) {
    const { configStore, deploymentService, deploymentStore, releaseStore, webhookStore, runtimeOperationStore, globalSettingsStore, agentManager, vaultSecretStore, runtimeStatusStreams, eventBus } = dependencies;

    app.get("/api/projects", async (req: Request, res: Response, next: NextFunction) => {
        try {
            const globalSettings = globalSettingsStore.readSettings();
            const config = configStore.readConfig();
            await deploymentService.reconcileRunningDeployments(config);
            const projects = Object.entries(config)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([name, settings]) => projectSummary(name, settings, globalSettings, deploymentStore));

            res.json(projects);
        } catch (error) {
            next(error);
        }
    });

    app.get("/api/projects/:name", async (req: Request, res: Response) => {
        try {
            const rawProjectName = req.params.name;
            const projectRef = normalizeProjectName(Array.isArray(rawProjectName) ? rawProjectName[0] : rawProjectName);
            const project = configStore.resolveProject(projectRef);
            if (!project) {
                res.status(404).json({ error: "Project does not exist." });
                return;
            }

            await deploymentService.reconcileLatestDeployment(project.name, project.settings);
            res.json(projectSummary(project.name, project.settings, globalSettingsStore.readSettings(), deploymentStore));
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "Could not load project." });
        }
    });

    app.post("/api/projects", (req: Request, res: Response) => {
        try {
            const payload = req.body as ProjectPayload;
            const repoName = normalizeProjectName(payloadProjectName(payload));
            const repoToken = payloadGitToken(payload);
            const repositoryUrl = normalizeRepositoryUrl(payloadRepositoryUrl(payload));
            const deployToken = payloadDeployToken(payload);
            const repoPath = payloadProjectPath(payload);
            const composeOverride = payloadComposeOverride(payload);
            const envSecrets = normalizeEnvSecrets(payloadEnvSecrets(payload));
            const globalSettings = globalSettingsStore.readSettings();
            const traefik = normalizeTraefikSettings(payload, globalSettings);

            const config = configStore.readConfig();
            if (config[repoName]) {
                res.status(409).json({ error: "A project with that repository name already exists." });
                return;
            }

            config[repoName] = {
                serverId: payloadServerId(payload),
                serverIds: payloadServerIds(payload),
                ...(repoToken ? { token: repoToken } : {}),
                ...(repositoryUrl ? { repositoryUrl } : {}),
                ...(deployToken ? { deployToken } : {}),
                ...(repoPath ? { path: repoPath } : {}),
                ...(composeOverride ? { composeOverride } : {}),
                ...(envSecrets.length ? { envSecrets } : {}),
                deploymentStrategy: payloadDeploymentStrategy(payload),
                registry: payloadRegistrySettings(payload),
                ...(traefik ? { traefik } : {})
            };
            configStore.writeConfig(config);
            eventBus.publish({ type: "projects.updated", changedAt: new Date().toISOString() });

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
            const nextName = normalizeProjectName(payloadProjectName(payload));
            const nextToken = payloadGitToken(payload);
            const nextRepositoryUrl = normalizeRepositoryUrl(payloadRepositoryUrl(payload));
            const nextDeployToken = payloadDeployToken(payload);
            const nextPath = payloadProjectPath(payload);
            const composeOverride = payloadComposeOverride(payload);
            const globalSettings = globalSettingsStore.readSettings();
            const traefik = normalizeTraefikSettings(payload, globalSettings);
            const config = configStore.readConfig();
            const existingProject = configStore.resolveProject(currentRef);
            const existing = existingProject?.settings;
            const envSecrets = normalizeEnvSecrets(payloadEnvSecrets(payload), existing?.envSecrets);
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
                serverId: payloadServerId(payload, existing.serverId || "local"),
                serverIds: payloadServerIds(payload, existing.serverIds?.length ? existing.serverIds : [existing.serverId || "local"]),
                token: nextToken || existing.token,
                ...(nextRepositoryUrl ? { repositoryUrl: nextRepositoryUrl } : {}),
                ...(nextDeployToken || existing.deployToken ? { deployToken: nextDeployToken || existing.deployToken } : {}),
                ...(nextPath ? { path: nextPath } : {}),
                composeOverride: composeOverride || undefined,
                ...(envSecrets.length ? { envSecrets } : {}),
                deploymentStrategy: payloadDeploymentStrategy(payload, existing.deploymentStrategy === "swarm" ? "swarm" : "compose"),
                registry: payloadRegistrySettings(payload, existing.registry),
                ...(traefik ? { traefik } : {})
            };
            configStore.writeConfig(config);
            eventBus.publish({ type: "projects.updated", changedAt: new Date().toISOString() });

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
                const checkoutPath = appSettings.path ?? defaultProjectPath(globalSettings, projectName);
                const unsafeProjectRootMounts = countBindMountsInsidePath(inspection, checkoutPath);
                if (hasUnsafeRelativeBindMounts(inspection) || unsafeProjectRootMounts > 0) {
                    const unsafeMounts = Math.max(inspection.unsafeRelativeBindMounts, unsafeProjectRootMounts);
                    res.status(400).json({
                        error: `${unsafeMounts} bind mounts still point into the project root or temporary checkout. Move them outside ${checkoutPath} before deleting the project folder.`
                    });
                    return;
                }
            }

            if (payload.stopContainers) {
                for (const serverId of targetServerIds(appSettings)) {
                    await agentManager.getClient(serverId).stopProject(projectName, { ...appSettings, serverId }, globalSettings);
                    actions.push(`containers stopped on ${serverId}`);
                }
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
            eventBus.publish({ type: "projects.updated", changedAt: new Date().toISOString() });

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
        res.status(200).json({ status: "Build worker dispatched", deploymentId: deployment.id, deploymentIds: deployment.targets?.map((target) => target.id) ?? [deployment.id] });
    });

    app.post("/api/projects/:name/preflight", async (req: Request, res: Response) => {
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

            res.json(await runProjectPreflight(
                projectName,
                appSettings,
                globalSettingsStore.readSettings(),
                agentManager,
                new Set(vaultSecretStore.list().map((secret) => secret.id))
            ));
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "Could not run deployment preflight." });
        }
    });

    app.get("/api/projects/:name/export", async (req: Request, res: Response) => {
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

            const globalSettings = globalSettingsStore.readSettings();
            let compose = appSettings.composeOverride?.trim() ?? "";
            if (!compose) {
                const imported = await agentManager.getClient(appSettings.serverId ?? "local").importCompose(projectName, appSettings, globalSettings);
                compose = imported.compose.trim();
            }

            if (!compose) {
                res.status(400).json({ error: "Project has no Docker Compose content to export." });
                return;
            }

            const exported = renderProjectComposeExport({
                name: projectName,
                settings: appSettings,
                globalSettings,
                compose
            });

            res.setHeader("content-disposition", `attachment; filename="${projectName}.deploy.compose.yml"`);
            res.type("yaml").send(exported);
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "Could not export project." });
        }
    });

    app.post("/api/projects/import", (req: Request, res: Response) => {
        try {
            const content = typeof req.body?.content === "string" ? req.body.content : "";
            if (!content.trim()) {
                res.status(400).json({ error: "Import file content is required." });
                return;
            }

            res.json(parseProjectComposeImport(content));
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "Could not import project compose file." });
        }
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

    app.get("/api/projects/:name/releases", (req: Request, res: Response) => {
        try {
            const rawProjectName = req.params.name;
            const projectRef = normalizeProjectName(Array.isArray(rawProjectName) ? rawProjectName[0] : rawProjectName);
            const project = configStore.resolveProject(projectRef);

            if (!project) {
                res.status(404).json({ error: "Project does not exist." });
                return;
            }

            res.json(releaseStore.list(project.settings.id ?? project.name).map(stripReleaseSnapshot));
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "Could not load release snapshots." });
        }
    });

    app.get("/api/projects/:name/releases/:releaseId", (req: Request, res: Response) => {
        try {
            const rawProjectName = req.params.name;
            const projectRef = normalizeProjectName(Array.isArray(rawProjectName) ? rawProjectName[0] : rawProjectName);
            const releaseId = String(req.params.releaseId || "");
            const project = configStore.resolveProject(projectRef);

            if (!project) {
                res.status(404).json({ error: "Project does not exist." });
                return;
            }

            const release = releaseStore.get(project.settings.id ?? project.name, releaseId);
            if (!release) {
                res.status(404).json({ error: "Release snapshot does not exist." });
                return;
            }

            res.json(stripReleaseSnapshot(release));
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "Could not load release snapshot." });
        }
    });

    app.post("/api/projects/:name/releases/:releaseId/rollback", (req: Request, res: Response) => {
        try {
            const rawProjectName = req.params.name;
            const projectRef = normalizeProjectName(Array.isArray(rawProjectName) ? rawProjectName[0] : rawProjectName);
            const releaseId = String(req.params.releaseId || "");
            const project = configStore.resolveProject(projectRef);
            const projectName = project?.name ?? projectRef;
            const appSettings = project?.settings;

            if (!appSettings) {
                res.status(404).json({ error: "Project does not exist." });
                return;
            }

            const deployment = deploymentService.rollbackRelease(projectName, appSettings, releaseId);
            res.status(200).json({ status: "Rollback worker dispatched", deploymentId: deployment.id, deploymentIds: deployment.targets?.map((target) => target.id) ?? [deployment.id] });
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "Could not start rollback." });
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
            const projectName = normalizeProjectName(payloadProjectName(payload) || project?.name || currentRef);
            const repositoryUrl = normalizeRepositoryUrl(payloadRepositoryUrl(payload));
            const composeOverride = payloadComposeOverride(payload);
            const traefik = normalizeTraefikSettings(payload, globalSettings);
            const appSettings: ProjectSettings = {
                id: existing.id,
                serverId: payloadServerId(payload, existing.serverId || "local"),
                serverIds: payloadServerIds(payload, existing.serverIds?.length ? existing.serverIds : [existing.serverId || "local"]),
                token: existing.token,
                deployToken: existing.deployToken,
                ...(repositoryUrl ? { repositoryUrl } : existing.repositoryUrl ? { repositoryUrl: existing.repositoryUrl } : {}),
                ...(payloadProjectPath(payload) ? { path: payloadProjectPath(payload) } : existing.path ? { path: existing.path } : {}),
                ...(composeOverride ? { composeOverride } : {}),
                deploymentStrategy: payloadDeploymentStrategy(payload, existing.deploymentStrategy === "swarm" ? "swarm" : "compose"),
                registry: payloadRegistrySettings(payload, existing.registry),
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
            eventBus.publish({ type: "runtime.status", projectId: appSettings.id, projectName, status });
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
                void runtimeStatusStreams.refreshProject(projectName);
                eventBus.publish({
                    type: "runtime.operation.updated",
                    projectId: record.projectId,
                    projectName,
                    operation: record
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
                void runtimeStatusStreams.refreshProject(projectName);
                eventBus.publish({
                    type: "runtime.operation.updated",
                    projectId: record.projectId,
                    projectName,
                    operation: record
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

        res.json(deploymentStore.list(project.settings.id ?? project.name).map(stripInternalDeploymentFields));
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

            res.json(stripInternalDeploymentFields(await deploymentService.reconcileLatestDeployment(project.name, project.settings)));
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "Could not load latest deployment." });
        }
    });

    app.get("/api/projects/:name/webhooks/latest", (req: Request, res: Response) => {
        try {
            const rawProjectName = req.params.name;
            const projectRef = normalizeProjectName(Array.isArray(rawProjectName) ? rawProjectName[0] : rawProjectName);
            const project = configStore.resolveProject(projectRef);

            if (!project) {
                res.status(404).json({ error: "Project does not exist." });
                return;
            }

            res.json(webhookStore.latestForProject(project.settings.id ?? project.name));
        } catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : "Could not load latest webhook event." });
        }
    });
}

/**
 * Registers the GitLab webhook endpoint.
 */
function registerWebhookRoute(app: Express, dependencies: Pick<RouteDependencies, "configStore" | "deploymentService" | "webhookStore">) {
    const { configStore, deploymentService, webhookStore } = dependencies;

    app.post("/webhook/:name", (req: Request, res: Response) => {
        const rawProjectName = req.params.name;
        const projectRef = normalizeProjectName(Array.isArray(rawProjectName) ? rawProjectName[0] : rawProjectName);
        handleWebhook(req, res, configStore.resolveProject(projectRef), `path:${projectRef}`, [projectRef, ...webhookProjectCandidates(req.body)]);
    });

    app.post("/webhook", (req: Request, res: Response) => {
        handleWebhook(req, res, resolveWebhookProject(req.body, configStore.readConfig()), "auto", webhookProjectCandidates(req.body));
    });

    function handleWebhook(req: Request, res: Response, webhookProject: { name?: string; projectName?: string; settings?: ProjectSettings; appSettings?: ProjectSettings } | null | undefined, source: string, candidates: string[]) {
        const event = readHeader(req.headers["x-gitlab-event"]);
        const projectName = webhookProject?.projectName ?? webhookProject?.name;
        const appSettings = webhookProject?.appSettings ?? webhookProject?.settings;

        if (event !== "Push Hook") {
            webhookStore.record({
                projectId: appSettings?.id,
                projectName,
                source,
                eventType: event,
                status: "ignored",
                reason: event ? `Ignored ${event}. Only Push Hook triggers deployments.` : "Ignored webhook without X-Gitlab-Event header.",
                candidates
            });
            res.status(202).send("Ignored event");
            return;
        }

        if (!projectName || !appSettings) {
            webhookStore.record({
                source,
                eventType: event,
                status: "error",
                reason: candidates.length ? `No configured project matched: ${candidates.join(", ")}` : "No configured project matched this webhook payload.",
                candidates
            });
            res.status(404).send("No config for this repository");
            return;
        }

        if (!appSettings.token) {
            webhookStore.record({
                projectId: appSettings.id,
                projectName,
                source,
                eventType: event,
                status: "error",
                reason: "Webhook secret token is not configured for this project.",
                candidates
            });
            res.status(403).send("Webhook secret token is not configured for this project.");
            return;
        }

        const signature = verifySignatureDetailed(appSettings.token, req);
        if (!signature.valid) {
            if (signature.logMessage) {
                console.warn(signature.logMessage);
            }

            webhookStore.record({
                projectId: appSettings.id,
                projectName,
                source,
                eventType: event,
                status: "error",
                reason: signature.reason,
                candidates
            });
            res.status(signature.statusCode).send(signature.response);
            return;
        }

        const deployment = deploymentService.startDeployment(projectName, appSettings, "webhook");
        webhookStore.record({
            projectId: appSettings.id,
            projectName,
            source,
            eventType: event,
            status: "dispatched",
            reason: "Webhook matched project and dispatched deployment.",
            candidates,
            deploymentId: deployment.targets?.[0]?.id ?? deployment.id
        });
        console.log(`Webhook deployment dispatched for ${projectName} (${deployment.id}: ${(deployment.targets ?? []).map((target) => target.id).join(", ")}).`);
        res.status(200).send("Build worker dispatched");
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
        res.status(200).json({ status: "Build worker dispatched", deploymentId: deployment.id, deploymentIds: deployment.targets?.map((target) => target.id) ?? [deployment.id] });
    });
}

function isRuntimeServiceAction(value: string): value is RuntimeServiceAction {
    return ["restart", "start", "stop", "recreate", "pull"].includes(value);
}

function readHeader(value: string | string[] | undefined) {
    return Array.isArray(value) ? value[0] : value ?? "";
}

function projectSummary(name: string, settings: ProjectSettings, globalSettings: ReturnType<GlobalSettingsStore["readSettings"]>, deploymentStore: DeploymentStore) {
    const serverIds = targetServerIds(settings);
    const serverId = serverIds[0] ?? "local";
    const repositoryUrl = settings.repositoryUrl ?? "";
    const path = settings.path ?? defaultProjectPath(globalSettings, name);
    const token = settings.token ? maskToken(settings.token) : "";
    const deployToken = settings.deployToken ? maskToken(settings.deployToken) : "";
    const composeOverride = settings.composeOverride ?? "";
    const envSecrets = maskEnvSecrets(settings.envSecrets);
    const deploymentStrategy = settings.deploymentStrategy === "swarm" ? "swarm" : "compose";
    const registry = settings.registry ?? { publish: false, deployFromRegistry: false };
    const traefik = settings.traefik ?? { enabled: false };
    const lastDeployment = stripInternalDeploymentFields(deploymentStore.latest(settings.id ?? name));

    return {
        id: settings.id,
        name,
        serverId,
        serverIds,
        repositoryUrl,
        path,
        token,
        deployToken,
        composeOverride,
        envSecrets,
        deploymentStrategy,
        registry,
        hasComposeOverride: Boolean(composeOverride),
        traefik,
        lastDeployment,
        project: {
            id: settings.id,
            name,
            serverId,
            serverIds,
            path
        },
        git: {
            repositoryUrl,
            token
        },
        deployment: {
            deployToken,
            strategy: deploymentStrategy,
            lastDeployment
        },
        compose: {
            override: composeOverride,
            envSecrets,
            hasOverride: Boolean(composeOverride)
        }
    };
}

function stripInternalDeploymentFields<T extends { agentJobId?: string; agentStreamToken?: string; targets?: T[] } | null>(deployment: T): T {
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

function stripReleaseSnapshot(snapshot: ProjectReleaseSnapshot) {
    const { composeYaml, ...publicSnapshot } = snapshot;
    void composeYaml;
    return publicSnapshot;
}

function targetServerIds(settings: ProjectSettings) {
    const ids = (settings.serverIds?.length ? settings.serverIds : [settings.serverId ?? "local"])
        .map((serverId) => serverId.trim())
        .filter(Boolean);
    return [...new Set(ids.length ? ids : ["local"])];
}

function maskEnvSecrets(secrets: ProjectEnvironmentSecret[] | undefined) {
    return (secrets ?? []).map((secret) => ({
        service: secret.service,
        key: secret.key,
        value: secret.source === "vault" ? "" : maskSecretValue(secret.value ?? ""),
        mode: secret.mode,
        source: secret.source === "vault" ? "vault" as const : "inline" as const,
        exposure: secret.mode === "docker_secret" && secret.exposure === "env" ? "env" as const : "file" as const,
        helperCommand: secret.mode === "docker_secret" && secret.exposure === "env" ? secret.helperCommand ?? "" : "",
        ...(secret.vaultSecretId ? { vaultSecretId: secret.vaultSecretId } : {})
    }));
}

function normalizeEnvSecrets(payload: ProjectEnvironmentSecret[] | undefined, existing: ProjectEnvironmentSecret[] = []) {
    if (!Array.isArray(payload)) {
        return [];
    }

    return payload
        .map((secret) => {
            const service = String(secret.service ?? "").trim();
            const key = String(secret.key ?? "").trim();
            const source = secret.source === "vault" ? "vault" as const : "inline" as const;
            const vaultSecretId = String(secret.vaultSecretId ?? "").trim();
            const value = source === "vault" ? "" : String(secret.value ?? "").trim();
            const mode = source === "vault" ? "docker_secret" as const : secret.mode === "env" ? "env" as const : "docker_secret" as const;
            const exposure = mode === "docker_secret" && secret.exposure === "env" ? "env" as const : "file" as const;
            const helperCommand = exposure === "env" ? String(secret.helperCommand ?? "").trim() : "";
            const existingSecret = existing.find((candidate) =>
                candidate.service === service &&
                candidate.key === key &&
                (source === "vault" ? candidate.vaultSecretId === vaultSecretId : candidate.source !== "vault")
            );
            return {
                service,
                key,
                value: source === "vault" ? "" : isMaskedSecretValue(value) ? existingSecret?.value ?? "" : value,
                mode,
                source,
                exposure,
                helperCommand,
                ...(source === "vault" ? { vaultSecretId } : {})
            };
        })
        .filter((secret) => secret.service && secret.key && (secret.source === "vault" ? secret.vaultSecretId : secret.value));
}

function isMaskedSecretValue(value: string) {
    return /^\*+$/.test(value) || /^[^*]+?\.\.\.[^*]+$/.test(value);
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
