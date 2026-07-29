import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { GlobalSettings, GlobalSettingsPayload, ProjectConfig, ProjectSettings, ServerRecord } from "./types.js";
import type { DeploymentRecord } from "./deploymentStore.js";

const schemaVersion = 1;
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
                name TEXT PRIMARY KEY,
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
                project_name TEXT PRIMARY KEY REFERENCES projects(name) ON DELETE CASCADE,
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
                project_name TEXT NOT NULL REFERENCES projects(name) ON DELETE CASCADE,
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
        `);

        this.connection.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('schema_version', ?)").run(String(schemaVersion));
    }

    /**
     * Seeds the built-in local server and agent records.
     */
    private ensureDefaultLocalServer() {
        const now = new Date().toISOString();
        this.connection
            .prepare(
                `INSERT OR IGNORE INTO servers (id, name, kind, created_at, updated_at)
                 VALUES ('local', 'Local Server', 'local', ?, ?)`
            )
            .run(now, now);

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
    return database.prepare("SELECT id, name, kind, created_at AS createdAt, updated_at AS updatedAt FROM servers ORDER BY name").all() as unknown as ServerRecord[];
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
    const existing = database.prepare("SELECT created_at AS createdAt FROM projects WHERE name = ?").get(name) as { createdAt: string } | undefined;
    const serverId = settings.serverId ?? "local";

    database
        .prepare(
            `INSERT OR REPLACE INTO projects
             (name, server_id, token, repository_url, deploy_token, path, compose_override, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(name, serverId, settings.token ?? null, settings.repositoryUrl ?? null, settings.deployToken ?? null, settings.path ?? null, settings.composeOverride ?? null, existing?.createdAt ?? now, now);

    database.prepare("DELETE FROM project_traefik_settings WHERE project_name = ?").run(name);
    if (!settings.traefik) {
        return;
    }

    database
        .prepare(
            `INSERT INTO project_traefik_settings
             (project_name, enabled, hostname, service, port, entry_points, cert_resolver, network, websocket, wildcard_certificate, wildcard_domain, remove_published_ports)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
            name,
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
    database
        .prepare(
            `INSERT OR REPLACE INTO deployments
             (id, project_name, server_id, trigger, status, started_at, finished_at, exit_code, error)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(record.id, record.projectName, serverId, record.trigger, record.status, record.startedAt, record.finishedAt ?? null, record.exitCode ? String(record.exitCode) : null, record.error ?? null);

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
    return Boolean(database.prepare("SELECT name FROM projects WHERE name = ?").get(projectName));
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
