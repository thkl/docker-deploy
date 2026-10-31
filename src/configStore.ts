import { AppDatabase, parseScaleToZeroJson, runDatabaseTransaction, upsertProject } from "./database.js";
import { decryptSecret } from "./secretStore.js";
import { ProjectConfig, ProjectSettings } from "./types.js";

/**
 * SQLite-backed project configuration store.
 *
 * The route layer still works with the original config-object shape while this
 * store maps projects and Traefik settings into normalized SQLite tables.
 */
export class ConfigStore {
    constructor(private readonly database = new AppDatabase().connection) {}

    /**
     * Reads all configured projects keyed by project name.
     */
    readConfig(): ProjectConfig {
        const projects = this.database
            .prepare(
                `SELECT
                    p.name,
                    p.id,
                    p.server_id AS serverId,
                    p.server_ids_json AS serverIdsJson,
                    p.token,
                    p.repository_url AS repositoryUrl,
                    p.deploy_token AS deployToken,
                    p.path,
                    p.env_file_path AS envFilePath,
                    p.deployment_on_hold AS deploymentOnHold,
                    p.scale_to_zero_json AS scaleToZeroJson,
                    p.compose_override AS composeOverride,
                    p.env_secrets_json AS envSecretsJson,
                    p.infisical_json AS infisicalJson,
                    p.deployment_strategy AS deploymentStrategy,
                    p.registry_publish AS registryPublish,
                    p.registry_deploy_from_registry AS registryDeployFromRegistry,
                    p.registry_image_namespace AS registryImageNamespace,
                    p.registry_image_tag AS registryImageTag,
                    p.notification_settings_json AS notificationSettingsJson,
                    t.enabled AS traefikEnabled,
                    t.hostname AS traefikHostname,
                    t.service AS traefikService,
                    t.port AS traefikPort,
                    t.entry_points AS traefikEntryPoints,
                    t.cert_resolver AS traefikCertResolver,
                    t.network AS traefikNetwork,
                    t.websocket AS traefikWebsocket,
                    t.wildcard_certificate AS traefikWildcardCertificate,
                    t.wildcard_domain AS traefikWildcardDomain,
                    t.remove_published_ports AS traefikRemovePublishedPorts
                 FROM projects p
                 LEFT JOIN project_traefik_settings t ON t.project_id = p.id
                 ORDER BY p.name`
            )
            .all() as unknown as ProjectRow[];

        return projects.reduce<ProjectConfig>((config, row) => {
            config[row.name] = rowToProjectSettings(row);
            return config;
        }, {});
    }

    /**
     * Persists the full project config object without touching deployment rows
     * for projects that still exist.
     */
    writeConfig(config: ProjectConfig) {
        runDatabaseTransaction(this.database, () => {
            const existingProjects = this.database.prepare("SELECT id, name FROM projects").all() as Array<{ id: string; name: string }>;
            const nextNames = new Set(Object.keys(config));
            const nextIds = new Set(Object.values(config).map((settings) => settings.id).filter(Boolean));

            for (const existingProject of existingProjects) {
                if (!nextNames.has(existingProject.name) && !nextIds.has(existingProject.id)) {
                    this.database.prepare("DELETE FROM projects WHERE id = ?").run(existingProject.id);
                }
            }

            for (const [name, settings] of Object.entries(config)) {
                upsertProject(this.database, name, settings);
            }
        });
    }

    /**
     * Returns one project profile without throwing if the config file is broken.
     */
    fetchProfile(repoName: string): ProjectSettings | undefined {
        try {
            return this.resolveProject(repoName)?.settings;
        } catch (error) {
            console.log("Error reading config");
            return undefined;
        }
    }

    /**
     * Resolves either the stable project UUID or the legacy unique name.
     */
    resolveProject(projectRef: string): { name: string; settings: ProjectSettings } | undefined {
        const row = this.database
            .prepare(
                `SELECT
                    p.id,
                    p.name,
                    p.server_id AS serverId,
                    p.server_ids_json AS serverIdsJson,
                    p.token,
                    p.repository_url AS repositoryUrl,
                    p.deploy_token AS deployToken,
                    p.path,
                    p.env_file_path AS envFilePath,
                    p.deployment_on_hold AS deploymentOnHold,
                    p.scale_to_zero_json AS scaleToZeroJson,
                    p.compose_override AS composeOverride,
                    p.env_secrets_json AS envSecretsJson,
                    p.infisical_json AS infisicalJson,
                    p.deployment_strategy AS deploymentStrategy,
                    p.registry_publish AS registryPublish,
                    p.registry_deploy_from_registry AS registryDeployFromRegistry,
                    p.registry_image_namespace AS registryImageNamespace,
                    p.registry_image_tag AS registryImageTag,
                    p.notification_settings_json AS notificationSettingsJson,
                    t.enabled AS traefikEnabled,
                    t.hostname AS traefikHostname,
                    t.service AS traefikService,
                    t.port AS traefikPort,
                    t.entry_points AS traefikEntryPoints,
                    t.cert_resolver AS traefikCertResolver,
                    t.network AS traefikNetwork,
                    t.websocket AS traefikWebsocket,
                    t.wildcard_certificate AS traefikWildcardCertificate,
                    t.wildcard_domain AS traefikWildcardDomain,
                    t.remove_published_ports AS traefikRemovePublishedPorts
                 FROM projects p
                 LEFT JOIN project_traefik_settings t ON t.project_id = p.id
                 WHERE p.id = ? OR p.name = ?
                 LIMIT 1`
            )
            .get(projectRef, projectRef) as ProjectRow | undefined;

        return row ? { name: row.name, settings: rowToProjectSettings(row) } : undefined;
    }
}

interface ProjectRow {
    id: string;
    name: string;
    serverId: string;
    serverIdsJson: string | null;
    token: string | null;
    repositoryUrl: string | null;
    deployToken: string | null;
    path: string | null;
    envFilePath: string | null;
    deploymentOnHold: number | null;
    scaleToZeroJson: string | null;
    composeOverride: string | null;
    envSecretsJson: string | null;
    infisicalJson: string | null;
    deploymentStrategy: string | null;
    registryPublish: number | null;
    registryDeployFromRegistry: number | null;
    registryImageNamespace: string | null;
    registryImageTag: string | null;
    notificationSettingsJson: string | null;
    traefikEnabled: number | null;
    traefikHostname: string | null;
    traefikService: string | null;
    traefikPort: number | null;
    traefikEntryPoints: string | null;
    traefikCertResolver: string | null;
    traefikNetwork: string | null;
    traefikWebsocket: number | null;
    traefikWildcardCertificate: number | null;
    traefikWildcardDomain: string | null;
    traefikRemovePublishedPorts: number | null;
}

/**
 * Converts a project join row into the API-facing settings shape.
 */
function rowToProjectSettings(row: ProjectRow): ProjectSettings {
    const serverIds = parseServerIds(row.serverIdsJson, row.serverId);
    const scaleToZero = parseScaleToZeroJson(row.scaleToZeroJson);
    return {
        id: row.id,
        serverId: serverIds[0] || "local",
        serverIds,
        ...(row.token ? { token: decryptSecret(row.token) } : {}),
        ...(row.repositoryUrl ? { repositoryUrl: row.repositoryUrl } : {}),
        ...(row.deployToken ? { deployToken: decryptSecret(row.deployToken) } : {}),
        ...(row.path ? { path: row.path } : {}),
        ...(row.envFilePath ? { envFilePath: row.envFilePath } : {}),
        deploymentOnHold: Boolean(row.deploymentOnHold),
        ...(scaleToZero ? { scaleToZero } : {}),
        ...(row.composeOverride ? { composeOverride: row.composeOverride } : {}),
        ...(row.envSecretsJson ? { envSecrets: parseProjectEnvSecrets(row.envSecretsJson) } : {}),
        ...(row.infisicalJson ? { infisical: parseInfisicalSettings(row.infisicalJson) } : {}),
        deploymentStrategy: row.deploymentStrategy === "swarm" ? "swarm" : "compose",
        registry: {
            publish: Boolean(row.registryPublish),
            deployFromRegistry: Boolean(row.registryDeployFromRegistry),
            ...(row.registryImageNamespace ? { imageNamespace: row.registryImageNamespace } : {}),
            ...(row.registryImageTag ? { imageTag: row.registryImageTag } : {})
        },
        ...(row.notificationSettingsJson ? { notifications: parseProjectNotificationSettings(row.notificationSettingsJson) } : {}),
        ...(row.traefikEnabled === null
            ? {}
            : {
                  traefik: {
                      enabled: Boolean(row.traefikEnabled),
                      ...(row.traefikHostname ? { hostname: row.traefikHostname } : {}),
                      ...(row.traefikService ? { service: row.traefikService } : {}),
                      ...(row.traefikPort ? { port: row.traefikPort } : {}),
                      ...(row.traefikEntryPoints ? { entryPoints: row.traefikEntryPoints } : {}),
                      ...(row.traefikCertResolver ? { certResolver: row.traefikCertResolver } : {}),
                      ...(row.traefikNetwork ? { network: row.traefikNetwork } : {}),
                      websocket: Boolean(row.traefikWebsocket),
                      wildcardCertificate: Boolean(row.traefikWildcardCertificate),
                      ...(row.traefikWildcardDomain ? { wildcardDomain: row.traefikWildcardDomain } : {}),
                      removePublishedPorts: Boolean(row.traefikRemovePublishedPorts)
                  }
              })
    };
}

function parseProjectNotificationSettings(value: string): NonNullable<ProjectSettings["notifications"]> | undefined {
    try {
        const parsed = JSON.parse(value) as Partial<NonNullable<ProjectSettings["notifications"]>>;
        const events = parsed.events ?? {
            deploymentStarted: true,
            deploymentSucceeded: true,
            deploymentFailed: true,
            serviceDown: true
        };
        return {
            useGlobal: parsed.useGlobal !== false,
            enabled: parsed.enabled !== false,
            channelIds: Array.isArray(parsed.channelIds) ? parsed.channelIds.map((id) => String(id).trim()).filter(Boolean) : [],
            events: {
                deploymentStarted: events.deploymentStarted !== false,
                deploymentSucceeded: events.deploymentSucceeded !== false,
                deploymentFailed: events.deploymentFailed !== false,
                serviceDown: events.serviceDown !== false
            }
        };
    } catch {
        return undefined;
    }
}

function parseServerIds(value: string | null, fallback: string) {
    if (value) {
        try {
            const parsed = JSON.parse(value) as unknown[];
            const ids = parsed.map((id) => String(id).trim()).filter(Boolean);
            return [...new Set(ids.length ? ids : [fallback || "local"])];
        } catch {
            return [fallback || "local"];
        }
    }

    return [fallback || "local"];
}

function parseProjectEnvSecrets(value: string) {
    try {
        const parsed = JSON.parse(value) as NonNullable<ProjectSettings["envSecrets"]>;
        return parsed
            .map((secret) => {
                const source = secret.source === "vault" ? "vault" as const : secret.source === "infisical" ? "infisical" as const : "inline" as const;
                return {
                    service: secret.service,
                    key: secret.key,
                    value: source === "inline" ? decryptSecret(secret.value ?? "") ?? "" : "",
                    mode: source === "vault" ? "docker_secret" as const : secret.mode === "env" ? "env" as const : "docker_secret" as const,
                    source,
                    ...(secret.vaultSecretId ? { vaultSecretId: secret.vaultSecretId } : {}),
                    ...(secret.infisicalSecretName ? { infisicalSecretName: secret.infisicalSecretName } : {}),
                    exposure: secret.mode === "docker_secret" && secret.exposure === "env" ? "env" as const : "file" as const,
                    helperCommand: secret.mode === "docker_secret" && secret.exposure === "env" ? secret.helperCommand ?? "" : ""
                };
            })
            .filter((secret) => secret.service && secret.key && (secret.source === "vault" ? secret.vaultSecretId : secret.source === "infisical" ? secret.infisicalSecretName : true));
    } catch {
        return [];
    }
}

function parseInfisicalSettings(value: string) {
    try {
        const parsed = JSON.parse(decryptSecret(value) ?? value) as Partial<NonNullable<ProjectSettings["infisical"]>>;
        return {
            enabled: Boolean(parsed.enabled),
            siteUrl: String(parsed.siteUrl ?? ""),
            clientId: String(parsed.clientId ?? ""),
            clientSecret: String(parsed.clientSecret ?? ""),
            projectId: String(parsed.projectId ?? ""),
            environment: String(parsed.environment ?? "prod"),
            secretPath: String(parsed.secretPath ?? "/")
        };
    } catch {
        return undefined;
    }
}

/**
 * Masks a stored token for API responses so the UI can show that a secret
 * exists without exposing it.
 */
export function maskToken(token: string) {
    if (token.length <= 8) {
        return "********";
    }

    return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

export function maskSecretValue(value: string) {
    return maskToken(value);
}
