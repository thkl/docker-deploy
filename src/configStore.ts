import { AppDatabase, runDatabaseTransaction, upsertProject } from "./database.js";
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
                    p.token,
                    p.repository_url AS repositoryUrl,
                    p.deploy_token AS deployToken,
                    p.path,
                    p.compose_override AS composeOverride,
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
                    p.token,
                    p.repository_url AS repositoryUrl,
                    p.deploy_token AS deployToken,
                    p.path,
                    p.compose_override AS composeOverride,
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
    token: string | null;
    repositoryUrl: string | null;
    deployToken: string | null;
    path: string | null;
    composeOverride: string | null;
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
    return {
        id: row.id,
        serverId: row.serverId || "local",
        ...(row.token ? { token: decryptSecret(row.token) } : {}),
        ...(row.repositoryUrl ? { repositoryUrl: row.repositoryUrl } : {}),
        ...(row.deployToken ? { deployToken: decryptSecret(row.deployToken) } : {}),
        ...(row.path ? { path: row.path } : {}),
        ...(row.composeOverride ? { composeOverride: row.composeOverride } : {}),
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
