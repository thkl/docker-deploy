import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { GlobalSettings, GlobalSettingsPayload, NotificationSettings, ProjectConfig, ProjectSettings, ServerActiveJob, ServerRecord } from "./types.js";
import type { DeploymentRecord } from "./deploymentStore.js";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "./secretStore.js";

const schemaVersion = 8;
const legacyDefaultGlobalSettings: GlobalSettings = {
    dataRoot: "/root/docker-apps",
    updaterInternalUrl: "",
    defaultTraefikNetwork: "proxy",
    defaultTraefikEntryPoints: "websecure",
    defaultTraefikCertResolver: "letsencrypt",
    traefikDomains: [],
    sshKeyPath: "~/.ssh",
    cleanupAfterDeploy: false,
    autoBackupEnabled: false,
    autoBackupCron: "0 3 * * *",
    autoBackupPath: "/root/docker-apps/.updater/backups",
    registryAddress: "",
    registryUsername: "",
    registryPassword: "",
    releaseSnapshotLimit: 20,
    notifications: {
        enabled: false,
        healthPollingEnabled: true,
        healthPollingIntervalSeconds: 60,
        events: {
            deploymentStarted: true,
            deploymentSucceeded: true,
            deploymentFailed: true,
            serviceDown: true
        },
        channels: []
    }
};

const backupVersion = 1;
const backupTables = ["settings", "servers", "agents", "projects", "project_traefik_settings", "vault_secrets"] as const;

export interface ControllerStateBackup {
    version: 1;
    createdAt: string;
    warning: string;
    databasePath: string;
    keys: {
        controllerKeys?: unknown;
        controllerSecretKey?: unknown;
        missing: string[];
    };
    tables: Record<(typeof backupTables)[number], Array<Record<string, unknown>>>;
}

/**
 * Small synchronous SQLite database wrapper for controller state.
 *
 * The controller is single-process today, so Node's built-in synchronous SQLite
 * API keeps persistence simple while still giving us transactions, durable
 * history, and a clean migration path away from JSON files.
 */
export class AppDatabase {
    readonly connection: DatabaseSync;

    constructor(private readonly databasePath = process.env.DEPLOY_DATABASE_PATH || process.env.UPDATER_DATABASE_PATH || join("./data", "updater.sqlite")) {
        mkdirSync(dirname(this.databasePath), { recursive: true });
        console.log(`Using Deploy database at ${this.databasePath}`);
        this.connection = new DatabaseSync(this.databasePath);
        this.connection.exec("PRAGMA foreign_keys = ON;");
        this.connection.exec("PRAGMA journal_mode = WAL;");
        this.migrate();
        this.ensureDefaultLocalServer();
        this.importLegacyJsonOnce();
        this.restoreLegacyProjectsIfDatabaseIsEmpty();
        this.encryptStoredProjectSecrets();
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
                server_ids_json TEXT,
                token TEXT,
                repository_url TEXT,
                deploy_token TEXT,
                path TEXT,
                env_file_path TEXT,
                deployment_on_hold INTEGER NOT NULL DEFAULT 0,
                compose_override TEXT,
                env_secrets_json TEXT,
                deployment_strategy TEXT NOT NULL DEFAULT 'compose',
                scale_to_zero_json TEXT,
                registry_publish INTEGER NOT NULL DEFAULT 0,
                registry_deploy_from_registry INTEGER NOT NULL DEFAULT 0,
                registry_image_namespace TEXT,
                registry_image_tag TEXT,
                notification_settings_json TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS vault_secrets (
                id TEXT PRIMARY KEY,
                namespace TEXT NOT NULL,
                key TEXT NOT NULL,
                description TEXT,
                value TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                UNIQUE(namespace, key)
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
                run_id TEXT,
                server_id TEXT NOT NULL REFERENCES servers(id),
                trigger TEXT NOT NULL,
                status TEXT NOT NULL,
                phase TEXT NOT NULL DEFAULT 'running',
                agent_job_id TEXT,
                agent_stream_token TEXT,
                started_at TEXT NOT NULL,
                finished_at TEXT,
                exit_code TEXT,
                error TEXT
            );

            CREATE TABLE IF NOT EXISTS deployment_runs (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                trigger TEXT NOT NULL,
                status TEXT NOT NULL,
                master_server_id TEXT,
                started_at TEXT NOT NULL,
                finished_at TEXT,
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

            CREATE TABLE IF NOT EXISTS webhook_events (
                id TEXT PRIMARY KEY,
                project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
                project_name TEXT,
                source TEXT NOT NULL,
                event_type TEXT,
                status TEXT NOT NULL,
                reason TEXT NOT NULL,
                candidates_json TEXT NOT NULL,
                deployment_id TEXT REFERENCES deployments(id) ON DELETE SET NULL,
                received_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS notification_events (
                id TEXT PRIMARY KEY,
                event TEXT NOT NULL,
                deployment_id TEXT,
                channel_id TEXT,
                channel_name TEXT,
                channel_type TEXT,
                project_id TEXT,
                project_name TEXT,
                service TEXT,
                title TEXT NOT NULL,
                body TEXT NOT NULL,
                status TEXT NOT NULL,
                error TEXT,
                dedupe_key TEXT,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS release_snapshots (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                deployment_id TEXT NOT NULL,
                run_id TEXT,
                server_id TEXT NOT NULL REFERENCES servers(id),
                compose_project_name TEXT NOT NULL,
                project_path TEXT NOT NULL,
                deployment_strategy TEXT NOT NULL,
                compose_yaml TEXT NOT NULL,
                git_sha TEXT,
                images_json TEXT NOT NULL,
                build_services_json TEXT NOT NULL,
                created_at TEXT NOT NULL
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
        this.ensureColumn("projects", "env_secrets_json", "TEXT");
        this.ensureColumn("projects", "env_file_path", "TEXT");
        this.ensureColumn("projects", "deployment_on_hold", "INTEGER NOT NULL DEFAULT 0");
        this.ensureColumn("projects", "server_ids_json", "TEXT");
        this.ensureColumn("projects", "deployment_strategy", "TEXT NOT NULL DEFAULT 'compose'");
        this.ensureColumn("projects", "scale_to_zero_json", "TEXT");
        this.ensureColumn("projects", "registry_publish", "INTEGER NOT NULL DEFAULT 0");
        this.ensureColumn("projects", "registry_deploy_from_registry", "INTEGER NOT NULL DEFAULT 0");
        this.ensureColumn("projects", "registry_image_namespace", "TEXT");
        this.ensureColumn("projects", "registry_image_tag", "TEXT");
        this.ensureColumn("projects", "notification_settings_json", "TEXT");
        this.ensureColumn("deployments", "run_id", "TEXT");
        this.ensureColumn("deployments", "phase", "TEXT NOT NULL DEFAULT 'running'");
        this.ensureColumn("deployments", "agent_job_id", "TEXT");
        this.ensureColumn("deployments", "agent_stream_token", "TEXT");
        this.ensureColumn("deployment_runs", "master_server_id", "TEXT");
        this.ensureColumn("notification_events", "deployment_id", "TEXT");
        this.ensureColumn("notification_events", "dedupe_key", "TEXT");
        this.connection.exec("DROP INDEX IF EXISTS notification_events_dedupe_key_idx;");
        this.connection.exec("CREATE UNIQUE INDEX IF NOT EXISTS notification_events_sent_dedupe_key_idx ON notification_events(dedupe_key) WHERE dedupe_key IS NOT NULL AND status = 'sent';");
        this.recreateReleaseSnapshotsWithoutDeploymentForeignKey();
        this.migrateProjectsToStableIds();
        this.backfillDeploymentRuns();
        this.normalizeDeploymentPhases();
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

    private recreateReleaseSnapshotsWithoutDeploymentForeignKey() {
        const foreignKeys = this.connection.prepare("PRAGMA foreign_key_list(release_snapshots)").all() as unknown as Array<{ table: string }>;
        if (!foreignKeys.some((key) => key.table === "deployments")) {
            return;
        }

        runDatabaseTransaction(this.connection, () => {
            this.connection.exec(`
                CREATE TABLE release_snapshots_next (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                    deployment_id TEXT NOT NULL,
                    run_id TEXT,
                    server_id TEXT NOT NULL REFERENCES servers(id),
                    compose_project_name TEXT NOT NULL,
                    project_path TEXT NOT NULL,
                    deployment_strategy TEXT NOT NULL,
                    compose_yaml TEXT NOT NULL,
                    git_sha TEXT,
                    images_json TEXT NOT NULL,
                    build_services_json TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );

                INSERT INTO release_snapshots_next
                    (id, project_id, deployment_id, run_id, server_id, compose_project_name, project_path, deployment_strategy, compose_yaml, git_sha, images_json, build_services_json, created_at)
                SELECT id, project_id, deployment_id, run_id, server_id, compose_project_name, project_path, deployment_strategy, compose_yaml, git_sha, images_json, build_services_json, created_at
                FROM release_snapshots;

                DROP TABLE release_snapshots;
                ALTER TABLE release_snapshots_next RENAME TO release_snapshots;
            `);
        });
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
                        path, scale_to_zero_json AS scaleToZeroJson, compose_override AS composeOverride, created_at AS createdAt, updated_at AS updatedAt
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
                        server_ids_json TEXT,
                        token TEXT,
                        repository_url TEXT,
                        deploy_token TEXT,
                        path TEXT,
                        compose_override TEXT,
                        env_secrets_json TEXT,
                        deployment_strategy TEXT NOT NULL DEFAULT 'compose',
                        scale_to_zero_json TEXT,
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
                        run_id TEXT,
                        server_id TEXT NOT NULL REFERENCES servers(id),
                        trigger TEXT NOT NULL,
                        status TEXT NOT NULL,
                        phase TEXT NOT NULL DEFAULT 'running',
                        agent_job_id TEXT,
                        agent_stream_token TEXT,
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
                             (id, name, server_id, server_ids_json, token, repository_url, deploy_token, path, scale_to_zero_json, compose_override, env_secrets_json, deployment_strategy, created_at, updated_at)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                        )
                        .run(
                            projectId,
                            project.name,
                            project.serverId,
                            JSON.stringify([project.serverId || "local"]),
                            project.token,
                            project.repositoryUrl,
                            project.deployToken,
                            project.path,
                            project.scaleToZeroJson,
                            project.composeOverride,
                            null,
                            "compose",
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
                             (id, project_id, run_id, server_id, trigger, status, phase, agent_job_id, agent_stream_token, started_at, finished_at, exit_code, error)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                        )
                        .run(row.id, projectId, row.run_id ?? row.id, row.server_id, row.trigger, row.status, row.phase ?? row.status, row.agent_job_id ?? null, row.agent_stream_token ?? null, row.started_at, row.finished_at, row.exit_code, row.error);
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
     * Recovers projects when a deployment starts with a fresh SQLite database
     * but still has the legacy config file mounted in the data directory.
     */
    private restoreLegacyProjectsIfDatabaseIsEmpty() {
        const row = this.connection.prepare("SELECT COUNT(*) AS count FROM projects").get() as { count: number };
        if (row.count > 0 || !existsSync(this.legacyDataFile("config.json"))) {
            return;
        }

        runDatabaseTransaction(this.connection, () => {
            this.importLegacyProjects();
            this.importLegacyDeployments();
        });
    }

    /**
     * Imports `data/settings.json` into key-value settings rows.
     */
    private importLegacySettings() {
        const settings = readLegacyJson<GlobalSettingsPayload>(this.legacyDataFile("settings.json"));
        const normalized = normalizeLegacyGlobalSettings(settings ?? legacyDefaultGlobalSettings);
        for (const [key, value] of Object.entries(normalized)) {
            this.connection.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, JSON.stringify(value));
        }
    }

    /**
     * Imports `data/config.json` into project and Traefik tables.
     */
    private importLegacyProjects() {
        const config = readLegacyJson<ProjectConfig>(this.legacyDataFile("config.json")) ?? {};
        for (const [projectName, settings] of Object.entries(config)) {
            upsertProject(this.connection, projectName, normalizeProjectForDatabase(settings));
        }
    }

    /**
     * Imports `data/deployments.json` into deployment rows and log chunks.
     */
    private importLegacyDeployments() {
        const deployments = readLegacyJson<Record<string, DeploymentRecord[]>>(this.legacyDataFile("deployments.json")) ?? {};
        for (const [projectName, records] of Object.entries(deployments)) {
            if (!projectExists(this.connection, projectName)) {
                continue;
            }

            for (const record of records) {
                upsertDeployment(this.connection, normalizeLegacyDeploymentRecord(projectName, record), "local");
            }
        }
    }

    /**
     * Creates parent deployment runs for databases created before multi-target
     * run tracking existed.
     */
    private backfillDeploymentRuns() {
        const rows = this.connection
            .prepare(
                `SELECT id, project_id AS projectId, trigger, status, started_at AS startedAt, finished_at AS finishedAt, error
                 FROM deployments
                 WHERE run_id IS NULL
                    OR run_id = ''
                    OR run_id NOT IN (SELECT id FROM deployment_runs)`
            )
            .all() as unknown as Array<{
                id: string;
                projectId: string;
                trigger: string;
                status: string;
                startedAt: string;
                finishedAt: string | null;
                error: string | null;
            }>;

        for (const row of rows) {
            this.connection
                .prepare(
                    `INSERT OR IGNORE INTO deployment_runs
                     (id, project_id, trigger, status, started_at, finished_at, error)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`
                )
                .run(row.id, row.projectId, row.trigger, row.status, row.startedAt, row.finishedAt, row.error);
            this.connection
                .prepare("UPDATE deployments SET run_id = ?, phase = COALESCE(NULLIF(phase, ''), status) WHERE id = ?")
                .run(row.id, row.id);
        }
    }

    /**
     * Repairs early run/target rows where a target finished but kept an active
     * phase such as `running`.
     */
    private normalizeDeploymentPhases() {
        this.connection
            .prepare("UPDATE deployments SET phase = status WHERE status != 'running' AND phase IN ('queued', 'dispatching', 'running', 'reconnecting', 'reconciling', 'cleanup')")
            .run();
    }

    private legacyDataFile(fileName: string) {
        return join(dirname(this.databasePath), fileName);
    }

    /**
     * Exports essential controller state without deployment/runtime logs.
     */
    exportBackup(): ControllerStateBackup {
        return {
            version: backupVersion,
            createdAt: new Date().toISOString(),
            warning: "This backup contains controller key material and encrypted secrets. Store it like a password.",
            databasePath: this.databasePath,
            keys: this.readBackupKeys(),
            tables: Object.fromEntries(
                backupTables.map((table) => [table, this.connection.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>])
            ) as ControllerStateBackup["tables"]
        };
    }

    /**
     * Restores essential controller state from a Deploy JSON backup.
     */
    restoreBackup(backup: ControllerStateBackup) {
        if (!backup || backup.version !== backupVersion || !backup.tables) {
            throw new Error("Backup file is not a supported Deploy backup.");
        }

        runDatabaseTransaction(this.connection, () => {
            this.connection.prepare("DELETE FROM project_traefik_settings").run();
            this.connection.prepare("DELETE FROM vault_secrets").run();
            this.connection.prepare("DELETE FROM projects").run();
            this.connection.prepare("DELETE FROM agents").run();
            this.connection.prepare("DELETE FROM servers").run();
            this.connection.prepare("DELETE FROM settings").run();

            this.insertRows("settings", backup.tables.settings ?? []);
            this.insertRows("servers", backup.tables.servers ?? []);
            this.insertRows("agents", backup.tables.agents ?? []);
            this.insertRows("projects", backup.tables.projects ?? []);
            this.insertRows("project_traefik_settings", backup.tables.project_traefik_settings ?? []);
            this.insertRows("vault_secrets", backup.tables.vault_secrets ?? []);
        });

        this.writeBackupKeys(backup.keys);
        this.ensureDefaultLocalServer();
    }

    private readBackupKeys(): ControllerStateBackup["keys"] {
        const missing: string[] = [];
        const controllerKeys = this.readOptionalJson("controller-keys.json", missing);
        const controllerSecretKey = this.readOptionalJson("controller-secret-key.json", missing);
        return {
            ...(controllerKeys ? { controllerKeys } : {}),
            ...(controllerSecretKey ? { controllerSecretKey } : {}),
            missing
        };
    }

    private readOptionalJson(fileName: string, missing: string[]) {
        const path = this.legacyDataFile(fileName);
        if (!existsSync(path)) {
            missing.push(fileName);
            return undefined;
        }

        return JSON.parse(readFileSync(path, "utf8")) as unknown;
    }

    private writeBackupKeys(keys: ControllerStateBackup["keys"] | undefined) {
        if (keys?.controllerKeys) {
            writeFileSync(this.legacyDataFile("controller-keys.json"), `${JSON.stringify(keys.controllerKeys, null, 2)}\n`, { mode: 0o600 });
        }

        if (keys?.controllerSecretKey) {
            writeFileSync(this.legacyDataFile("controller-secret-key.json"), `${JSON.stringify(keys.controllerSecretKey, null, 2)}\n`, { mode: 0o600 });
        }
    }

    private insertRows(tableName: (typeof backupTables)[number], rows: Array<Record<string, unknown>>) {
        for (const row of rows) {
            const columns = Object.keys(row);
            if (!columns.length) {
                continue;
            }

            const quotedColumns = columns.map((column) => `"${column.replace(/"/g, "\"\"")}"`).join(", ");
            const placeholders = columns.map(() => "?").join(", ");
            this.connection.prepare(`INSERT INTO ${tableName} (${quotedColumns}) VALUES (${placeholders})`).run(...columns.map((column) => toSqlValue(row[column])));
        }
    }

    /**
     * Encrypts older plaintext project tokens in-place after the controller key
     * is available. Reads stay backward-compatible through ConfigStore.
     */
    private encryptStoredProjectSecrets() {
        const rows = this.connection.prepare("SELECT id, token, deploy_token AS deployToken, env_secrets_json AS envSecretsJson FROM projects").all() as unknown as Array<{ id: string; token: string | null; deployToken: string | null; envSecretsJson: string | null }>;
        const update = this.connection.prepare("UPDATE projects SET token = ?, deploy_token = ?, env_secrets_json = ? WHERE id = ?");

        runDatabaseTransaction(this.connection, () => {
            for (const row of rows) {
                const token = row.token && !isEncryptedSecret(row.token) ? encryptSecret(row.token) : row.token;
                const deployToken = row.deployToken && !isEncryptedSecret(row.deployToken) ? encryptSecret(row.deployToken) : row.deployToken;
                const envSecretsJson = encryptProjectEnvSecretsJson(row.envSecretsJson);
                if (token !== row.token || deployToken !== row.deployToken || envSecretsJson !== row.envSecretsJson) {
                    update.run(token ?? null, deployToken ?? null, envSecretsJson, row.id);
                }
            }
        });
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
        ...(row.capabilitiesJson ? { capabilities: normalizeServerCapabilities(JSON.parse(row.capabilitiesJson)) } : {}),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt
    }));
}

function normalizeServerCapabilities(capabilities: NonNullable<Partial<ServerRecord["capabilities"]>>): ServerRecord["capabilities"] {
    return {
        docker: capabilities.docker ?? {
            checkedAt: new Date().toISOString(),
            available: false,
            mode: "unknown"
        },
        traefik: capabilities.traefik ?? {
            available: false,
            containerCount: 0,
            networkPresent: false,
            checkedAt: new Date().toISOString()
        },
        ...(capabilities.system ? { system: capabilities.system } : {})
    };
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

function toSqlValue(value: unknown) {
    if (value === undefined) {
        return null;
    }

    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
        return value;
    }

    if (typeof value === "boolean") {
        return value ? 1 : 0;
    }

    return JSON.stringify(value);
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
    const serverIds = normalizeServerIds(settings.serverIds, settings.serverId);
    const serverId = serverIds[0] ?? "local";

    database
        .prepare(
            `INSERT INTO projects
             (id, name, server_id, server_ids_json, token, repository_url, deploy_token, path, env_file_path, deployment_on_hold, scale_to_zero_json, compose_override, env_secrets_json, deployment_strategy, registry_publish, registry_deploy_from_registry, registry_image_namespace, registry_image_tag, notification_settings_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                server_id = excluded.server_id,
                server_ids_json = excluded.server_ids_json,
                token = excluded.token,
                repository_url = excluded.repository_url,
                deploy_token = excluded.deploy_token,
                path = excluded.path,
                env_file_path = excluded.env_file_path,
                deployment_on_hold = excluded.deployment_on_hold,
                scale_to_zero_json = excluded.scale_to_zero_json,
                compose_override = excluded.compose_override,
                env_secrets_json = excluded.env_secrets_json,
                deployment_strategy = excluded.deployment_strategy,
                registry_publish = excluded.registry_publish,
                registry_deploy_from_registry = excluded.registry_deploy_from_registry,
                registry_image_namespace = excluded.registry_image_namespace,
                registry_image_tag = excluded.registry_image_tag,
                notification_settings_json = excluded.notification_settings_json,
                updated_at = excluded.updated_at`
        )
        .run(
            projectId,
            name,
            serverId,
            JSON.stringify(serverIds),
            encryptSecret(settings.token),
            settings.repositoryUrl ?? null,
            encryptSecret(settings.deployToken),
            settings.path ?? null,
            settings.envFilePath ?? null,
            settings.deploymentOnHold ? 1 : 0,
            encryptedScaleToZeroJson(settings.scaleToZero),
            settings.composeOverride ?? null,
            encryptedProjectEnvSecretsJson(settings.envSecrets),
            normalizeDeploymentStrategy(settings.deploymentStrategy),
            settings.registry?.publish ? 1 : 0,
            settings.registry?.deployFromRegistry ? 1 : 0,
            settings.registry?.imageNamespace ?? null,
            settings.registry?.imageTag ?? null,
            settings.notifications ? JSON.stringify(settings.notifications) : null,
            existing?.createdAt ?? now,
            now
        );

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
            `INSERT OR REPLACE INTO deployment_runs
             (id, project_id, trigger, status, started_at, finished_at, error)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(record.runId ?? record.id, projectId, record.trigger, record.status, record.startedAt, record.finishedAt ?? null, record.error ?? null);

    database
        .prepare(
             `INSERT OR REPLACE INTO deployments
             (id, project_id, run_id, server_id, trigger, status, phase, agent_job_id, agent_stream_token, started_at, finished_at, exit_code, error)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(record.id, projectId, record.runId ?? record.id, serverId, record.trigger, record.status, record.phase ?? record.status, record.agentJobId ?? null, record.agentStreamToken ?? null, record.startedAt, record.finishedAt ?? null, record.exitCode ? String(record.exitCode) : null, record.error ?? null);

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
    const serverIds = normalizeServerIds(settings.serverIds, settings.serverId);
    return {
        ...settings,
        serverId: serverIds[0] ?? "local",
        serverIds
    };
}

function normalizeServerIds(serverIds: string[] | undefined, fallback?: string) {
    const ids = (serverIds?.length ? serverIds : [fallback ?? "local"])
        .map((serverId) => serverId.trim())
        .filter(Boolean);
    return [...new Set(ids.length ? ids : ["local"])];
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
    scaleToZeroJson: string | null;
    composeOverride: string | null;
    createdAt: string;
    updatedAt: string;
}

function encryptedScaleToZeroJson(value: ProjectSettings["scaleToZero"]) {
    if (!value) {
        return null;
    }

    return encryptSecret(JSON.stringify({
        enabled: Boolean(value.enabled),
        services: [...new Set((value.services ?? []).map((service) => service.trim()).filter(Boolean))],
        idleTimeoutSeconds: normalizeScaleToZeroNumber(value.idleTimeoutSeconds, 900),
        startupTimeoutSeconds: normalizeScaleToZeroNumber(value.startupTimeoutSeconds, 120),
        ...(value.wakeAddress?.trim() ? { wakeAddress: value.wakeAddress.trim() } : {}),
        ...(value.wakeToken ? { wakeToken: encryptSecret(value.wakeToken) } : {})
    }));
}

export function parseScaleToZeroJson(value: string | null | undefined) {
    if (!value) {
        return undefined;
    }

    try {
        const parsed = JSON.parse(decryptSecret(value) ?? value) as Partial<NonNullable<ProjectSettings["scaleToZero"]>>;
        return {
            enabled: Boolean(parsed.enabled),
            services: Array.isArray(parsed.services) ? parsed.services.map(String).map((service) => service.trim()).filter(Boolean) : [],
            idleTimeoutSeconds: normalizeScaleToZeroNumber(parsed.idleTimeoutSeconds, 900),
            startupTimeoutSeconds: normalizeScaleToZeroNumber(parsed.startupTimeoutSeconds, 120),
            ...(typeof parsed.wakeAddress === "string" && parsed.wakeAddress.trim() ? { wakeAddress: parsed.wakeAddress.trim() } : {}),
            ...(typeof parsed.wakeToken === "string" && parsed.wakeToken ? { wakeToken: decryptSecret(parsed.wakeToken) ?? parsed.wakeToken } : {})
        } satisfies NonNullable<ProjectSettings["scaleToZero"]>;
    } catch {
        return undefined;
    }
}

function normalizeScaleToZeroNumber(value: unknown, fallback: number) {
    const number = typeof value === "number" ? value : Number(value);
    return Number.isFinite(number) && number > 0 ? Math.min(Math.trunc(number), 86400) : fallback;
}

function normalizeDeploymentStrategy(value: ProjectSettings["deploymentStrategy"]) {
    return value === "swarm" ? "swarm" : "compose";
}

function encryptedProjectEnvSecretsJson(secrets: ProjectSettings["envSecrets"] = []) {
    const normalized = secrets
        .map((secret) => {
            const service = secret.service.trim();
            const key = secret.key.trim();
            const mode = secret.source === "vault" ? "docker_secret" : secret.mode === "env" ? "env" : "docker_secret";
            const exposure = mode === "docker_secret" && secret.exposure === "env" ? "env" : "file";
            if (secret.source === "vault") {
                return {
                    service,
                    key,
                    value: "",
                    mode,
                    source: "vault" as const,
                    vaultSecretId: secret.vaultSecretId?.trim() ?? "",
                    exposure,
                    helperCommand: exposure === "env" ? secret.helperCommand?.trim() ?? "" : ""
                };
            }

            return {
                service,
                key,
                value: encryptSecret(secret.value?.trim() ?? "") ?? "",
                mode,
                source: "inline" as const,
                exposure,
                helperCommand: exposure === "env" ? secret.helperCommand?.trim() ?? "" : ""
            };
        })
        .filter((secret) => secret.service && secret.key && (secret.source === "vault" ? secret.vaultSecretId : secret.value));

    return normalized.length ? JSON.stringify(normalized) : null;
}

function encryptProjectEnvSecretsJson(value: string | null) {
    if (!value) {
        return null;
    }

    try {
        const parsed = JSON.parse(value) as NonNullable<ProjectSettings["envSecrets"]>;
        return encryptedProjectEnvSecretsJson(parsed);
    } catch {
        return value;
    }
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
    run_id?: string | null;
    server_id: string;
    trigger: string;
    status: string;
    phase?: string | null;
    agent_job_id?: string | null;
    agent_stream_token?: string | null;
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
        updaterInternalUrl: payload.updaterInternalUrl?.trim() || "",
        defaultTraefikNetwork: payload.defaultTraefikNetwork?.trim() || legacyDefaultGlobalSettings.defaultTraefikNetwork,
        defaultTraefikEntryPoints: payload.defaultTraefikEntryPoints?.trim() || legacyDefaultGlobalSettings.defaultTraefikEntryPoints,
        defaultTraefikCertResolver: payload.defaultTraefikCertResolver?.trim() || legacyDefaultGlobalSettings.defaultTraefikCertResolver,
        traefikDomains: payload.traefikDomains ?? legacyDefaultGlobalSettings.traefikDomains,
        sshKeyPath: payload.sshKeyPath?.trim() || legacyDefaultGlobalSettings.sshKeyPath,
        cleanupAfterDeploy: Boolean(payload.cleanupAfterDeploy),
        autoBackupEnabled: Boolean(payload.autoBackupEnabled),
        autoBackupCron: payload.autoBackupCron?.trim() || legacyDefaultGlobalSettings.autoBackupCron,
        autoBackupPath: payload.autoBackupPath?.trim() || legacyDefaultGlobalSettings.autoBackupPath,
        registryAddress: payload.registryAddress?.trim() || "",
        registryUsername: payload.registryUsername?.trim() || "",
        registryPassword: payload.registryPassword?.trim() || "",
        releaseSnapshotLimit: normalizeLegacyRetentionLimit(payload.releaseSnapshotLimit),
        notifications: normalizeLegacyNotificationSettings(payload.notifications)
    };
}

function normalizeLegacyRetentionLimit(value: number | undefined) {
    const parsed = Number(value ?? legacyDefaultGlobalSettings.releaseSnapshotLimit);
    if (!Number.isFinite(parsed)) {
        return legacyDefaultGlobalSettings.releaseSnapshotLimit;
    }
    return Math.max(1, Math.min(Math.trunc(parsed), 200));
}

function normalizeLegacyNotificationSettings(payload: GlobalSettingsPayload["notifications"]): NotificationSettings {
    const events = payload?.events ?? {};
    const interval = Number(payload?.healthPollingIntervalSeconds ?? 60);
    return {
        enabled: Boolean(payload?.enabled),
        healthPollingEnabled: payload?.healthPollingEnabled !== false,
        healthPollingIntervalSeconds: Number.isFinite(interval) ? Math.max(15, Math.min(Math.round(interval), 3600)) : 60,
        events: {
            deploymentStarted: events.deploymentStarted !== false,
            deploymentSucceeded: events.deploymentSucceeded !== false,
            deploymentFailed: events.deploymentFailed !== false,
            serviceDown: events.serviceDown !== false
        },
        channels: (payload?.channels ?? []).map((channel, index) => ({
            id: channel.id?.trim() || `notification-${index + 1}`,
            type: channel.type === "pushover" || channel.type === "email" ? channel.type : "slack",
            name: channel.name?.trim() || `Notification ${index + 1}`,
            enabled: channel.enabled !== false,
            slackWebhookUrl: channel.slackWebhookUrl?.trim() ?? "",
            pushoverToken: channel.pushoverToken?.trim() ?? "",
            pushoverUser: channel.pushoverUser?.trim() ?? "",
            emailTo: channel.emailTo?.trim() ?? "",
            emailFrom: channel.emailFrom?.trim() ?? "",
            smtpHost: channel.smtpHost?.trim() ?? "",
            smtpPort: Number(channel.smtpPort || 587),
            smtpSecure: Boolean(channel.smtpSecure),
            smtpUsername: channel.smtpUsername?.trim() ?? "",
            smtpPassword: channel.smtpPassword?.trim() ?? ""
        }))
    };
}
