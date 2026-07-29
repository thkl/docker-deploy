import { randomUUID } from "node:crypto";
import { AppDatabase, runDatabaseTransaction } from "./database.js";

export type DeploymentStatus = "running" | "succeeded" | "failed";
export type DeploymentTrigger = "webhook" | "ci" | "manual";
export type DeploymentStream = "stdout" | "stderr";

export interface DeploymentRecord {
    id: string;
    projectName: string;
    serverId: string;
    trigger: DeploymentTrigger;
    status: DeploymentStatus;
    startedAt: string;
    finishedAt?: string;
    exitCode?: number | string;
    error?: string;
    log: string;
}

const maxHistoryPerProject = 10;
const maxLogLength = 120_000;

/**
 * SQLite-backed deployment history store.
 *
 * Deployment metadata lives in `deployments`, while output is appended to
 * `deployment_logs` so live log streaming and remote agents can share the same
 * durable event model later.
 */
export class DeploymentStore {
    constructor(private readonly database = new AppDatabase().connection) {}

    /**
     * Lists deployment history for one project in chronological order.
     */
    list(projectName: string) {
        const rows = this.database
            .prepare(
                `SELECT
                    id,
                    project_name AS projectName,
                    server_id AS serverId,
                    trigger,
                    status,
                    started_at AS startedAt,
                    finished_at AS finishedAt,
                    exit_code AS exitCode,
                    error
                 FROM deployments
                 WHERE project_name = ?
                 ORDER BY started_at ASC`
            )
            .all(projectName) as unknown as DeploymentRow[];

        return rows.map((row) => this.rowToRecord(row));
    }

    /**
     * Returns the newest deployment record for a project.
     */
    latest(projectName: string) {
        const row = this.database
            .prepare(
                `SELECT
                    id,
                    project_name AS projectName,
                    server_id AS serverId,
                    trigger,
                    status,
                    started_at AS startedAt,
                    finished_at AS finishedAt,
                    exit_code AS exitCode,
                    error
                 FROM deployments
                 WHERE project_name = ?
                 ORDER BY started_at DESC
                 LIMIT 1`
            )
            .get(projectName) as DeploymentRow | undefined;

        return row ? this.rowToRecord(row) : null;
    }

    /**
     * Removes all deployment history for a deleted project.
     */
    deleteProject(projectName: string) {
        this.database.prepare("DELETE FROM deployments WHERE project_name = ?").run(projectName);
    }

    /**
     * Creates a running deployment record before the worker process starts.
     */
    start(projectName: string, trigger: DeploymentTrigger, serverId = "local") {
        const now = new Date().toISOString();
        const record: DeploymentRecord = {
            id: `${Date.now()}-${randomUUID().slice(0, 8)}`,
            projectName,
            serverId,
            trigger,
            status: "running",
            startedAt: now,
            log: `Deployment queued by ${trigger} at ${now}\n`
        };

        runDatabaseTransaction(this.database, () => {
            this.database
                .prepare(
                    `INSERT INTO deployments
                     (id, project_name, server_id, trigger, status, started_at)
                     VALUES (?, ?, ?, ?, ?, ?)`
                )
                .run(record.id, projectName, serverId, trigger, record.status, now);

            this.database
                .prepare("INSERT INTO deployment_logs (deployment_id, stream, chunk, created_at) VALUES (?, 'stdout', ?, ?)")
                .run(record.id, record.log, now);

            this.trimHistory(projectName);
        });
        return record;
    }

    /**
     * Appends stdout or stderr output to a running deployment log.
     */
    append(projectName: string, deploymentId: string, stream: DeploymentStream, chunk: string) {
        if (!this.deploymentBelongsToProject(projectName, deploymentId)) {
            return;
        }

        this.database
            .prepare("INSERT INTO deployment_logs (deployment_id, stream, chunk, created_at) VALUES (?, ?, ?, ?)")
            .run(deploymentId, stream, prefixChunk(stream, chunk), new Date().toISOString());
    }

    /**
     * Marks a running deployment as succeeded or failed.
     */
    finish(projectName: string, deploymentId: string, status: Exclude<DeploymentStatus, "running">, details?: { error?: string; exitCode?: number | string }) {
        this.database
            .prepare(
                `UPDATE deployments
                 SET status = ?, finished_at = ?, error = ?, exit_code = ?
                 WHERE id = ? AND project_name = ?`
            )
            .run(status, new Date().toISOString(), details?.error ?? null, details?.exitCode ? String(details.exitCode) : null, deploymentId, projectName);
    }

    /**
     * Converts a deployment row into the existing API shape.
     */
    private rowToRecord(row: DeploymentRow): DeploymentRecord {
        return {
            id: row.id,
            projectName: row.projectName,
            serverId: row.serverId,
            trigger: row.trigger,
            status: row.status,
            startedAt: row.startedAt,
            ...(row.finishedAt ? { finishedAt: row.finishedAt } : {}),
            ...(row.exitCode ? { exitCode: row.exitCode } : {}),
            ...(row.error ? { error: row.error } : {}),
            log: this.readLog(row.id)
        };
    }

    /**
     * Reads and trims the assembled log for one deployment.
     */
    private readLog(deploymentId: string) {
        const rows = this.database
            .prepare("SELECT chunk FROM deployment_logs WHERE deployment_id = ? ORDER BY id ASC")
            .all(deploymentId) as unknown as Array<{ chunk: string }>;

        return trimLog(rows.map((row) => row.chunk).join(""));
    }

    /**
     * Deletes older deployment rows after a new record is created.
     */
    private trimHistory(projectName: string) {
        this.database
            .prepare(
                `DELETE FROM deployments
                 WHERE project_name = ?
                   AND id NOT IN (
                       SELECT id FROM deployments
                       WHERE project_name = ?
                       ORDER BY started_at DESC
                       LIMIT ?
                   )`
            )
            .run(projectName, projectName, maxHistoryPerProject);
    }

    /**
     * Guards log appends so stale worker callbacks cannot cross project names.
     */
    private deploymentBelongsToProject(projectName: string, deploymentId: string) {
        const row = this.database.prepare("SELECT id FROM deployments WHERE id = ? AND project_name = ?").get(deploymentId, projectName);
        return Boolean(row);
    }
}

interface DeploymentRow {
    id: string;
    projectName: string;
    serverId: string;
    trigger: DeploymentTrigger;
    status: DeploymentStatus;
    startedAt: string;
    finishedAt: string | null;
    exitCode: string | null;
    error: string | null;
}

/**
 * Keeps stderr markers compatible with the old JSON log output.
 */
function prefixChunk(stream: DeploymentStream, chunk: string) {
    return stream === "stderr" ? `[stderr] ${chunk}` : chunk;
}

/**
 * Keeps only the latest part of a large deployment log.
 */
function trimLog(log: string) {
    if (log.length <= maxLogLength) {
        return log;
    }

    return `... log trimmed to last ${maxLogLength} characters ...\n${log.slice(-maxLogLength)}`;
}
