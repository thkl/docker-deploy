import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { GlobalSettings, GlobalSettingsPayload, ProjectConfig, ProjectSettings, ServerActiveJob, ServerRecord } from "./types.js";
import type { DeploymentRecord } from "./deploymentStore.js";

const schemaVersion = 3;
const legacyDefaultGlobalSettings: GlobalSettings = {
    dataRoot: "/root/docker-apps",
    defaultTraefikNetwork: "proxy",
    defaultTraefikEntryPoints: "websecure",
    defaultTraefikCertResolver: "letsencrypt",
    sshKeyPath: "~/.ssh",
    cleanupAfterDeploy: false
};

/**
 * Small synchronous SQLite database wrapper for controller state.
 *
 * The controller is single-process today, so Node's built-in synchronous SQLite
 * API keeps persistence simple while still giving us transactions, durable
 * history, and a clean migration path away from JSON files.
 */
export class AppDatabase {
    readonly connection: DatabaseSync;

    constructor(private readonly databasePath = join("./data", "updater.sqlite")) {
        mkdirSync(dirname(this.databasePath), { recursive: true });
        this.connection = new DatabaseSync(this.databasePath);
        this.connection.exec("PRAGMA foreign_keys = ON;");
        this.connection.exec("PRAGMA journal_mode = WAL;");
        this.migrate();
        this.ensureDefaultLocalServer();
        this.importLegacyJsonOnce();
    }

    /**
     * Creates or updates the database schema.
     */
    private migrate() {
        this.connection.exec(`
            CREATE TABLE IF NOT EXISTS metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS servers (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                kind TEXT NOT NULL,
                agent_server_id TEXT,
                base_url TEXT,
                agent_public_encryption_key TEXT,
                agent_public_signing_key TEXT,
                controller_public_encryption_key TEXT,
                controller_public_signing_key TEXT,
                status TEXT NOT NULL DEFAULT 'unpaired',
                last_seen_at TEXT,
                paired_at TEXT,
                agent_version TEXT,
                active_jobs_json TEXT,
                last_health_error TEXT,
                capabilities_json TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS agents (
                id TEXT PRIMARY KEY,
                server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                token TEXT NOT NULL,
                status TEXT NOT NULL,
                last_heartbeat_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                server_id TEXT NOT NULL REFERENCES servers(id),
                token TEXT,
                repository_url TEXT,
                deploy_token TEXT,
                path TEXT,
                compose_override TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS project_traefik_settings (
                project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
                enabled INTEGER NOT NULL,
                hostname TEXT,
                service TEXT,
                port INTEGER,
                entry_points TEXT,
                cert_resolver TEXT,
                network TEXT,
                websocket INTEGER NOT NULL,
                wildcard_certificate INTEGER NOT NULL,
                wildcard_domain TEXT,
                remove_published_ports INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS deployments (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                server_id TEXT NOT NULL REFERENCES servers(id),
                trigger TEXT NOT NULL,
                status TEXT NOT NULL,
                started_at TEXT NOT NULL,
                finished_at TEXT,
                exit_code TEXT,
                error TEXT
            );

            CREATE TABLE IF NOT EXISTS deployment_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
                stream TEXT NOT NULL,
                chunk TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS runtime_operations (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                server_id TEXT NOT NULL REFERENCES servers(id),
                service TEXT NOT NULL,
                action TEXT NOT NULL,
                status TEXT NOT NULL,
                started_at TEXT NOT NULL,
                finished_at TEXT NOT NULL,
                error TEXT,
                output TEXT NOT NULL
            );
        `);

        this.ensureColumn("servers", "base_url", "TEXT");
        this.ensureColumn("servers", "agent_server_id", "TEXT");
        this.ensureColumn("servers", "agent_public_encryption_key", "TEXT");
        this.ensureColumn("servers", "agent_public_signing_key", "TEXT");
        this.ensureColumn("servers", "controller_public_encryption_key", "TEXT");
        this.ensureColumn("servers", "controller_public_signing_key", "TEXT");
        this.ensureColumn("servers", "status", "TEXT NOT NULL DEFAULT 'unpaired'");
        this.ensureColumn("servers", "last_seen_at", "TEXT");
        this.ensureColumn("servers", "paired_at", "TEXT");
        this.ensureColumn("servers", "agent_version", "TEXT");
        this.ensureColumn("servers", "active_jobs_json", "TEXT");
        this.ensureColumn("servers", "last_health_error", "TEXT");
        this.ensureColumn("servers", "capabilities_json", "TEXT");
        this.migrateProjectsToStableIds();
        this.connection.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('schema_version', ?)").run(String(schemaVersion));
    }

    /**
     * Adds a column for existing SQLite databases when a migration grows a table.
     */
    private ensureColumn(tableName: string, columnName: string, definition: string) {
        const columns = this.connection.prepare(`PRAGMA table_info(${tableName})`).all() as unknown as Array<{ name: string }>;
        if (!columns.some((column) => column.name === columnName)) {
            this.connection.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition};`);
        }
    }

    /**
     * Rebuilds the early SQLite schema that used project names as foreign keys.
     */
    private migrateProjectsToStableIds() {
        const projectColumns = this.connection.prepare("PRAGMA table_info(projects)").all() as unknown as Array<{ name: string }>;
        if (projectColumns.some((column) => column.name === "id")) {
            return;
        }

        const projects = this.connection
            .prepare(
                `SELECT name, server_id AS serverId, token, repository_url AS repositoryUrl, deploy_token AS deployToken,
                        path, compose_override AS composeOverride, created_at AS createdAt, updated_at AS updatedAt
                 FROM projects`
            )
            .all() as unknown as LegacyProjectRow[];
        const traefikRows = this.connection.prepare("SELECT * FROM project_traefik_settings").all() as unknown as LegacyTraefikRow[];
        const deploymentRows = this.connection.prepare("SELECT * FROM deployments").all() as unknown as LegacyDeploymentRow[];
        const projectIds = new Map(projects.map((project) => [project.name, randomUUID()]));

        this.connection.exec("PRAGMA foreign_keys = OFF;");
        try {
            runDatabaseTransaction(this.connection, () => {
                this.connection.exec(`
                    CREATE TABLE projects_next (
                        id TEXT PRIMARY KEY,
                        name TEXT NOT NULL UNIQUE,
                        server_id TEXT NOT NULL REFERENCES servers(id),
                        token TEXT,
                        repository_url TEXT,
                        deploy_token TEXT,
                        path TEXT,
                        compose_override TEXT,
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL
                    );

                    CREATE TABLE project_traefik_settings_next (
                        project_id TEXT PRIMARY KEY REFERENCES projects_next(id) ON DELETE CASCADE,
                        enabled INTEGER NOT NULL,
                        hostname TEXT,
                        service TEXT,
                        port INTEGER,
                        entry_points TEXT,
                        cert_resolver TEXT,
                        network TEXT,
                        websocket INTEGER NOT NULL,
                        wildcard_certificate INTEGER NOT NULL,
                        wildcard_domain TEXT,
                        remove_published_ports INTEGER NOT NULL
                    );

                    CREATE TABLE deployments_next (
                        id TEXT PRIMARY KEY,
                        project_id TEXT NOT NULL REFERENCES projects_next(id) ON DELETE CASCADE,
                        server_id TEXT NOT NULL REFERENCES servers(id),
                        trigger TEXT NOT NULL,
                        status TEXT NOT NULL,
                        started_at TEXT NOT NULL,
                        finished_at TEXT,
                        exit_code TEXT,
                        error TEXT
                    );
                `);

                for (const project of projects) {
                    const projectId = projectIds.get(project.name);
                    if (!projectId) {
                        continue;
                    }

                    this.connection
                        .prepare(
                            `INSERT INTO projects_next
                             (id, name, server_id, token, repository_url, deploy_token, path, compose_override, created_at, updated_at)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                        )
                        .run(
                            projectId,
                            project.name,
                            project.serverId,
                            project.token,
                            project.repositoryUrl,
                            project.deployToken,
                            project.path,
                            project.composeOverride,
                            project.createdAt,
                            project.updatedAt
                        );
                }

                for (const row of traefikRows) {
                    const projectId = projectIds.get(row.project_name);
                    if (!projectId) {
                        continue;
                    }

                    this.connection
                        .prepare(
                            `INSERT INTO project_traefik_settings_next
                             (project_id, enabled, hostname, service, port, entry_points, cert_resolver, network, websocket, wildcard_certificate, wildcard_domain, remove_published_ports)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                        )
                        .run(projectId, row.enabled, row.hostname, row.service, row.port, row.entry_points, row.cert_resolver, row.network, row.websocket, row.wildcard_certificate, row.wildcard_domain, row.remove_published_ports);
                }

                for (const row of deploymentRows) {
                    const projectId = projectIds.get(row.project_name);
                    if (!projectId) {
                        continue;
                    }

                    this.connection
                        .prepare(
                            `INSERT INTO deployments_next
                             (id, project_id, server_id, trigger, status, started_at, finished_at, exit_code, error)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
                        )
                        .run(row.id, projectId, row.server_id, row.trigger, row.status, row.started_at, row.finished_at, row.exit_code, row.error);
                }

                this.connection.exec(`
                    DROP TABLE project_traefik_settings;
                    DROP TABLE deployments;
                    DROP TABLE projects;
                    ALTER TABLE projects_next RENAME TO projects;
                    ALTER TABLE project_traefik_settings_next RENAME TO project_traefik_settings;
                    ALTER TABLE deployments_next RENAME TO deployments;
                `);
            });
        } finally {
            this.connection.exec("PRAGMA foreign_keys = ON;");
        }
    }

    /**
     * Seeds the built-in local server and agent records.
     */
    private ensureDefaultLocalServer() {
        const now = new Date().toISOString();
        this.connection
            .prepare(
                `INSERT OR IGNORE INTO servers (id, name, kind, status, created_at, updated_at)
                 VALUES ('local', 'Local Server', 'local', 'online', ?, ?)`
            )
            .run(now, now);
        this.connection.prepare("UPDATE servers SET status = 'online', agent_server_id = COALESCE(agent_server_id, 'local') WHERE id = 'local'").run();

        this.connection
            .prepare(
                `INSERT OR IGNORE INTO agents (id, server_id, name, token, status, created_at, updated_at)
                 VALUES ('local', 'local', 'Local Agent', ?, 'online', ?, ?)`
            )
            .run(randomUUID(), now, now);
    }

    /**
     * Imports existing JSON files the first time SQLite starts.
     */
    private importLegacyJsonOnce() {
        const alreadyImported = this.connection.prepare("SELECT value FROM metadata WHERE key = 'legacy_json_imported'").get() as { value: string } | undefined;
        if (alreadyImported?.value === "true") {
            return;
        }

        runDatabaseTransaction(this.connection, () => {
            this.importLegacySettings();
            this.importLegacyProjects();
            this.importLegacyDeployments();
            this.connection.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('legacy_json_imported', 'true')").run();
        });
    }

    /**
     * Imports `data/settings.json` into key-value settings rows.
     */
    private importLegacySettings() {
        const settings = readLegacyJson<GlobalSettingsPayload>(join("./data", "settings.json"));
        const normalized = normalizeLegacyGlobalSettings(settings ?? legacyDefaultGlobalSettings);
        for (const [key, value] of Object.entries(normalized)) {
            this.connection.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, JSON.stringify(value));
        }
    }

    /**
     * Imports `data/config.json` into project and Traefik tables.
     */
    private importLegacyProjects() {
        const config = readLegacyJson<ProjectConfig>(join("./data", "config.json")) ?? {};
        for (const [projectName, settings] of Object.entries(config)) {
            upsertProject(this.connection, projectName, normalizeProjectForDatabase(settings));
        }
    }

    /**
     * Imports `data/deployments.json` into deployment rows and log chunks.
     */
    private importLegacyDeployments() {
        const deployments = readLegacyJson<Record<string, DeploymentRecord[]>>(join("./data", "deployments.json")) ?? {};
        for (const [projectName, records] of Object.entries(deployments)) {
            if (!projectExists(this.connection, projectName)) {
                continue;
            }

            for (const record of records) {
                upsertDeployment(this.connection, normalizeLegacyDeploymentRecord(projectName, record), "local");
            }
        }
    }
}

/**
 * Returns all configured servers.
 */
export function listServers(database: DatabaseSync): ServerRecord[] {
    const rows = database
        .prepare(
            `SELECT
                id,
                name,
                kind,
                agent_server_id AS agentServerId,
                base_url AS baseUrl,
                agent_public_encryption_key AS agentPublicEncryptionKey,
                agent_public_signing_key AS agentPublicSigningKey,
                controller_public_encryption_key AS controllerPublicEncryptionKey,
                controller_public_signing_key AS controllerPublicSigningKey,
                status,
                last_seen_at AS lastSeenAt,
                paired_at AS pairedAt,
                agent_version AS agentVersion,
                active_jobs_json AS activeJobsJson,
                last_health_error AS lastHealthError,
                capabilities_json AS capabilitiesJson,
                created_at AS createdAt,
                updated_at AS updatedAt
             FROM servers
             ORDER BY name`
        )
        .all() as unknown as ServerRow[];

    return rows.map((row) => ({
        id: row.id,
        name: row.name,
        kind: row.kind,
        ...(row.agentServerId ? { agentServerId: row.agentServerId } : {}),
        ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
        ...(row.agentPublicEncryptionKey ? { agentPublicEncryptionKey: row.agentPublicEncryptionKey } : {}),
        ...(row.agentPublicSigningKey ? { agentPublicSigningKey: row.agentPublicSigningKey } : {}),
        ...(row.controllerPublicEncryptionKey ? { controllerPublicEncryptionKey: row.controllerPublicEncryptionKey } : {}),
        ...(row.controllerPublicSigningKey ? { controllerPublicSigningKey: row.controllerPublicSigningKey } : {}),
        status: row.status,
        ...(row.lastSeenAt ? { lastSeenAt: row.lastSeenAt } : {}),
        ...(row.pairedAt ? { pairedAt: row.pairedAt } : {}),
        ...(row.agentVersion ? { agentVersion: row.agentVersion } : {}),
        ...(row.activeJobsJson ? { activeJobs: parseActiveJobs(row.activeJobsJson) } : {}),
        ...(row.lastHealthError ? { lastHealthError: row.lastHealthError } : {}),
        ...(row.capabilitiesJson ? { capabilities: JSON.parse(row.capabilitiesJson) } : {}),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt
    }));
}

interface ServerRow {
    id: string;
    name: string;
    kind: "local" | "remote";
    agentServerId: string | null;
    baseUrl: string | null;
    agentPublicEncryptionKey: string | null;
    agentPublicSigningKey: string | null;
    controllerPublicEncryptionKey: string | null;
    controllerPublicSigningKey: string | null;
    status: "online" | "offline" | "unpaired";
    lastSeenAt: string | null;
    pairedAt: string | null;
    agentVersion: string | null;
    activeJobsJson: string | null;
    lastHealthError: string | null;
    capabilitiesJson: string | null;
    createdAt: string;
    updatedAt: string;
}

function parseActiveJobs(value: string): ServerActiveJob[] {
    try {
        const parsed = JSON.parse(value) as ServerActiveJob[];
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

/**
 * Executes a synchronous SQLite transaction with rollback on failure.
 */
export function runDatabaseTransaction(database: DatabaseSync, work: () => void) {
    database.exec("BEGIN");
    try {
        work();
        database.exec("COMMIT");
    } catch (error) {
        database.exec("ROLLBACK");
        throw error;
    }
}

/**
 * Stores one project and its Traefik settings.
 */
export function upsertProject(database: DatabaseSync, name: string, settings: ProjectSettings) {
    const now = new Date().toISOString();
    const existing = settings.id
        ? (database.prepare("SELECT id, created_at AS createdAt FROM projects WHERE id = ?").get(settings.id) as { id: string; createdAt: string } | undefined)
        : (database.prepare("SELECT id, created_at AS createdAt FROM projects WHERE name = ?").get(name) as { id: string; createdAt: string } | undefined);
    const projectId = existing?.id ?? settings.id ?? randomUUID();
    const serverId = settings.serverId ?? "local";

    database
        .prepare(
            `INSERT INTO projects
             (id, name, server_id, token, repository_url, deploy_token, path, compose_override, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                server_id = excluded.server_id,
                token = excluded.token,
                repository_url = excluded.repository_url,
                deploy_token = excluded.deploy_token,
                path = excluded.path,
                compose_override = excluded.compose_override,
                updated_at = excluded.updated_at`
        )
        .run(projectId, name, serverId, settings.token ?? null, settings.repositoryUrl ?? null, settings.deployToken ?? null, settings.path ?? null, settings.composeOverride ?? null, existing?.createdAt ?? now, now);

    database.prepare("DELETE FROM project_traefik_settings WHERE project_id = ?").run(projectId);
    if (!settings.traefik) {
        return;
    }

    database
        .prepare(
            `INSERT INTO project_traefik_settings
             (project_id, enabled, hostname, service, port, entry_points, cert_resolver, network, websocket, wildcard_certificate, wildcard_domain, remove_published_ports)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
            projectId,
            settings.traefik.enabled ? 1 : 0,
            settings.traefik.hostname ?? null,
            settings.traefik.service ?? null,
            settings.traefik.port ?? null,
            settings.traefik.entryPoints ?? null,
            settings.traefik.certResolver ?? null,
            settings.traefik.network ?? null,
            settings.traefik.websocket ? 1 : 0,
            settings.traefik.wildcardCertificate ? 1 : 0,
            settings.traefik.wildcardDomain ?? null,
            settings.traefik.removePublishedPorts ? 1 : 0
        );
}

/**
 * Stores a deployment record and its current log content.
 */
function upsertDeployment(database: DatabaseSync, record: DeploymentRecord, serverId: string) {
    const projectId = projectIdByName(database, record.projectName);
    if (!projectId) {
        return;
    }

    database
        .prepare(
            `INSERT OR REPLACE INTO deployments
             (id, project_id, server_id, trigger, status, started_at, finished_at, exit_code, error)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(record.id, projectId, serverId, record.trigger, record.status, record.startedAt, record.finishedAt ?? null, record.exitCode ? String(record.exitCode) : null, record.error ?? null);

    if (record.log) {
        database
            .prepare("INSERT INTO deployment_logs (deployment_id, stream, chunk, created_at) VALUES (?, 'stdout', ?, ?)")
            .run(record.id, record.log, record.startedAt);
    }
}

/**
 * Reads a legacy JSON file if it exists.
 */
function readLegacyJson<T>(path: string): T | undefined {
    if (!existsSync(path)) {
        return undefined;
    }

    const content = readFileSync(path, "utf8").trim();
    if (!content) {
        return undefined;
    }

    return JSON.parse(content) as T;
}

/**
 * Ensures imported legacy project records have required new fields.
 */
function normalizeProjectForDatabase(settings: ProjectSettings): ProjectSettings {
    return {
        ...settings,
        serverId: settings.serverId ?? "local"
    };
}

/**
 * Checks whether a project exists before importing dependent records.
 */
function projectExists(database: DatabaseSync, projectName: string) {
    return Boolean(projectIdByName(database, projectName));
}

function projectIdByName(database: DatabaseSync, projectName: string) {
    const row = database.prepare("SELECT id FROM projects WHERE name = ?").get(projectName) as { id: string } | undefined;
    return row?.id;
}

interface LegacyProjectRow {
    name: string;
    serverId: string;
    token: string | null;
    repositoryUrl: string | null;
    deployToken: string | null;
    path: string | null;
    composeOverride: string | null;
    createdAt: string;
    updatedAt: string;
}

interface LegacyTraefikRow {
    project_name: string;
    enabled: number;
    hostname: string | null;
    service: string | null;
    port: number | null;
    entry_points: string | null;
    cert_resolver: string | null;
    network: string | null;
    websocket: number;
    wildcard_certificate: number;
    wildcard_domain: string | null;
    remove_published_ports: number;
}

interface LegacyDeploymentRow {
    id: string;
    project_name: string;
    server_id: string;
    trigger: string;
    status: string;
    started_at: string;
    finished_at: string | null;
    exit_code: string | null;
    error: string | null;
}

/**
 * Fills deployment fields that older JSON records may not have carried.
 */
function normalizeLegacyDeploymentRecord(projectName: string, record: DeploymentRecord): DeploymentRecord {
    return {
        ...record,
        id: record.id || `${Date.now()}-${randomUUID().slice(0, 8)}`,
        projectName,
        startedAt: record.startedAt || new Date().toISOString(),
        log: record.log || ""
    };
}

/**
 * Applies only the stable defaults needed while importing old JSON settings.
 */
function normalizeLegacyGlobalSettings(payload: GlobalSettingsPayload): GlobalSettings {
    return {
        dataRoot: payload.dataRoot?.trim() || legacyDefaultGlobalSettings.dataRoot,
        defaultTraefikNetwork: payload.defaultTraefikNetwork?.trim() || legacyDefaultGlobalSettings.defaultTraefikNetwork,
        defaultTraefikEntryPoints: payload.defaultTraefikEntryPoints?.trim() || legacyDefaultGlobalSettings.defaultTraefikEntryPoints,
        defaultTraefikCertResolver: payload.defaultTraefikCertResolver?.trim() || legacyDefaultGlobalSettings.defaultTraefikCertResolver,
        sshKeyPath: payload.sshKeyPath?.trim() || legacyDefaultGlobalSettings.sshKeyPath,
        cleanupAfterDeploy: Boolean(payload.cleanupAfterDeploy)
    };
}
