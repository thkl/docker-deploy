import { randomUUID } from "node:crypto";
import { AppDatabase, runDatabaseTransaction } from "./database.js";

export type DeploymentStatus = "running" | "succeeded" | "failed";
export type DeploymentTrigger = "webhook" | "ci" | "manual" | "rollback";
export type DeploymentStream = "stdout" | "stderr";
export type DeploymentPhase = "queued" | "dispatching" | "running" | "reconnecting" | "reconciling" | "cleanup" | "succeeded" | "failed" | "canceled";

export interface DeploymentRecord {
    id: string;
    runId?: string;
    projectId?: string;
    projectName: string;
    serverId: string;
    trigger: DeploymentTrigger;
    status: DeploymentStatus;
    phase?: DeploymentPhase;
    agentJobId?: string;
    agentStreamToken?: string;
    startedAt: string;
    finishedAt?: string;
    exitCode?: number | string;
    error?: string;
    log: string;
    targets?: DeploymentRecord[];
}

const maxHistoryPerProject = 10;
const maxLogLength = 120_000;

/**
 * SQLite-backed deployment history store.
 *
 * `deployment_runs` is the parent run created by a webhook/manual/CI trigger.
 * `deployments` are durable per-server target rows attached to that run.
 */
export class DeploymentStore {
    constructor(private readonly database = new AppDatabase().connection) {}

    list(projectName: string) {
        const runs = this.runRows(projectName, "ASC");
        if (runs.length) {
            return runs.map((run) => this.runToRecord(run));
        }

        return this.targetRows(projectName, "ASC").map((row) => this.rowToRecord(row));
    }

    latest(projectName: string) {
        const run = this.runRows(projectName, "DESC", 1)[0];
        if (run) {
            return this.runToRecord(run);
        }

        const target = this.targetRows(projectName, "DESC", 1)[0];
        return target ? this.rowToRecord(target) : null;
    }

    get(deploymentId: string) {
        const row = this.database
            .prepare(targetSelectSql("WHERE d.id = ?", "LIMIT 1"))
            .get(deploymentId) as DeploymentRow | undefined;

        return row ? this.rowToRecord(row) : null;
    }

    getRun(runId: string) {
        const row = this.database
            .prepare(runSelectSql("WHERE r.id = ?", "LIMIT 1"))
            .get(runId) as DeploymentRunRow | undefined;
        return row ? this.runToRecord(row) : null;
    }

    listRunning() {
        const rows = this.database
            .prepare(targetSelectSql("WHERE d.status = 'running'", "ORDER BY d.started_at ASC"))
            .all() as unknown as DeploymentRow[];

        return rows.map((row) => this.rowToRecord(row));
    }

    deleteProject(projectName: string) {
        const projectId = this.projectIdByRef(projectName);
        if (projectId) {
            this.database.prepare("DELETE FROM deployment_runs WHERE project_id = ?").run(projectId);
            this.database.prepare("DELETE FROM deployments WHERE project_id = ?").run(projectId);
        }
    }

    startRun(projectName: string, trigger: DeploymentTrigger, serverIds: string[]) {
        const now = new Date().toISOString();
        const projectId = this.projectIdByRef(projectName);
        if (!projectId) {
            throw new Error("Project does not exist.");
        }

        const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
        const uniqueServerIds = [...new Set(serverIds.map((serverId) => serverId.trim()).filter(Boolean))];
        const targets = uniqueServerIds.map((serverId): DeploymentRecord => ({
            id: `${runId}-${serverId.replace(/[^a-zA-Z0-9_.-]/g, "_")}`,
            runId,
            projectId,
            projectName,
            serverId,
            trigger,
            status: "running",
            phase: "queued",
            startedAt: now,
            log: `Deployment target queued by ${trigger} at ${now} for ${serverId}\n`
        }));

        const run: DeploymentRecord = {
            id: runId,
            runId,
            projectId,
            projectName,
            serverId: uniqueServerIds.join(","),
            trigger,
            status: "running",
            phase: "queued",
            startedAt: now,
            log: `Deployment run queued by ${trigger} at ${now} for ${uniqueServerIds.length} target(s)\n`,
            targets
        };

        runDatabaseTransaction(this.database, () => {
            this.database
                .prepare(
                    `INSERT INTO deployment_runs
                     (id, project_id, trigger, status, started_at)
                     VALUES (?, ?, ?, 'running', ?)`
                )
                .run(runId, projectId, trigger, now);

            for (const target of targets) {
                this.database
                    .prepare(
                        `INSERT INTO deployments
                         (id, project_id, run_id, server_id, trigger, status, phase, started_at)
                         VALUES (?, ?, ?, ?, ?, 'running', 'queued', ?)`
                    )
                    .run(target.id, projectId, runId, target.serverId, trigger, now);
                this.database
                    .prepare("INSERT INTO deployment_logs (deployment_id, stream, chunk, created_at) VALUES (?, 'stdout', ?, ?)")
                    .run(target.id, target.log, now);
            }

            this.trimHistory(projectName);
        });

        return run;
    }

    setPhase(projectName: string, deploymentId: string, phase: DeploymentPhase) {
        if (!this.deploymentBelongsToProject(projectName, deploymentId)) {
            return;
        }

        this.database.prepare("UPDATE deployments SET phase = ? WHERE id = ?").run(phase, deploymentId);
    }

    setAgentJob(projectName: string, deploymentId: string, job: { jobId: string; streamToken: string }) {
        if (!this.deploymentBelongsToProject(projectName, deploymentId)) {
            return;
        }

        this.database
            .prepare("UPDATE deployments SET agent_job_id = ?, agent_stream_token = ? WHERE id = ?")
            .run(job.jobId, job.streamToken, deploymentId);
    }

    append(projectName: string, deploymentId: string, stream: DeploymentStream, chunk: string) {
        if (!this.deploymentBelongsToProject(projectName, deploymentId)) {
            return;
        }

        this.database
            .prepare("INSERT INTO deployment_logs (deployment_id, stream, chunk, created_at) VALUES (?, ?, ?, ?)")
            .run(deploymentId, stream, chunk, new Date().toISOString());
    }

    finish(projectName: string, deploymentId: string, status: Exclude<DeploymentStatus, "running">, details?: { error?: string; exitCode?: number | string; phase?: DeploymentPhase }) {
        const projectId = this.projectIdByRef(projectName);
        if (!projectId) {
            return;
        }

        const phase = details?.phase ?? (status === "succeeded" ? "succeeded" : "failed");
        this.database
            .prepare(
                `UPDATE deployments
                 SET status = ?, phase = ?, finished_at = ?, error = ?, exit_code = ?
                 WHERE id = ? AND project_id = ?`
            )
            .run(status, phase, new Date().toISOString(), details?.error ?? null, details?.exitCode ? String(details.exitCode) : null, deploymentId, projectId);

        this.refreshRunForTarget(deploymentId);
    }

    private refreshRunForTarget(deploymentId: string) {
        const row = this.database.prepare("SELECT run_id AS runId FROM deployments WHERE id = ?").get(deploymentId) as { runId: string | null } | undefined;
        if (!row?.runId) {
            return;
        }

        const targets = this.targetRowsByRun(row.runId);
        if (!targets.length) {
            return;
        }

        const status: DeploymentStatus = targets.some((target) => target.status === "running")
            ? "running"
            : targets.some((target) => target.status === "failed")
                ? "failed"
                : "succeeded";
        const finishedAt = status === "running" ? null : new Date().toISOString();
        const error = status === "failed"
            ? targets.filter((target) => target.error).map((target) => `${target.serverId}: ${target.error}`).join("\n") || "One or more deployment targets failed."
            : null;

        this.database
            .prepare("UPDATE deployment_runs SET status = ?, finished_at = ?, error = ? WHERE id = ?")
            .run(status, finishedAt, error, row.runId);
    }

    private runToRecord(row: DeploymentRunRow): DeploymentRecord {
        const targets = this.targetRowsByRun(row.id).map((target) => this.rowToRecord(target));
        const primary = targets[0];
        return {
            id: row.id,
            runId: row.id,
            projectId: row.projectId,
            projectName: row.projectName,
            serverId: targets.map((target) => target.serverId).join(",") || primary?.serverId || "",
            trigger: row.trigger,
            status: row.status,
            phase: summarizePhase(targets),
            startedAt: row.startedAt,
            ...(row.finishedAt ? { finishedAt: row.finishedAt } : {}),
            ...(row.error ? { error: row.error } : {}),
            log: buildRunLog(row, targets),
            targets
        };
    }

    private rowToRecord(row: DeploymentRow): DeploymentRecord {
        return {
            id: row.id,
            ...(row.runId ? { runId: row.runId } : {}),
            projectId: row.projectId,
            projectName: row.projectName,
            serverId: row.serverId,
            trigger: row.trigger,
            status: row.status,
            phase: row.phase,
            ...(row.agentJobId ? { agentJobId: row.agentJobId } : {}),
            ...(row.agentStreamToken ? { agentStreamToken: row.agentStreamToken } : {}),
            startedAt: row.startedAt,
            ...(row.finishedAt ? { finishedAt: row.finishedAt } : {}),
            ...(row.exitCode ? { exitCode: row.exitCode } : {}),
            ...(row.error ? { error: row.error } : {}),
            log: this.readLog(row.id)
        };
    }

    private readLog(deploymentId: string) {
        const rows = this.database
            .prepare("SELECT chunk FROM deployment_logs WHERE deployment_id = ? ORDER BY id ASC")
            .all(deploymentId) as unknown as Array<{ chunk: string }>;

        return trimLog(rows.map((row) => normalizeStoredLogChunk(row.chunk)).join(""));
    }

    private trimHistory(projectName: string) {
        const projectId = this.projectIdByRef(projectName);
        if (!projectId) {
            return;
        }

        this.database
            .prepare(
                `DELETE FROM deployment_runs
                 WHERE project_id = ?
                   AND id NOT IN (
                       SELECT id FROM deployment_runs
                       WHERE project_id = ?
                       ORDER BY started_at DESC
                       LIMIT ?
                   )`
            )
            .run(projectId, projectId, maxHistoryPerProject);

        this.database
            .prepare("DELETE FROM deployments WHERE project_id = ? AND run_id NOT IN (SELECT id FROM deployment_runs WHERE project_id = ?)")
            .run(projectId, projectId);
    }

    private deploymentBelongsToProject(projectName: string, deploymentId: string) {
        const projectId = this.projectIdByRef(projectName);
        const row = projectId ? this.database.prepare("SELECT id FROM deployments WHERE id = ? AND project_id = ?").get(deploymentId, projectId) : undefined;
        return Boolean(row);
    }

    private runRows(projectName: string, order: "ASC" | "DESC", limit?: number) {
        const sql = runSelectSql("WHERE p.name = ? OR p.id = ?", `ORDER BY r.started_at ${order}${limit ? " LIMIT ?" : ""}`);
        const params = limit ? [projectName, projectName, limit] : [projectName, projectName];
        return this.database.prepare(sql).all(...params) as unknown as DeploymentRunRow[];
    }

    private targetRows(projectName: string, order: "ASC" | "DESC", limit?: number) {
        const sql = targetSelectSql("WHERE p.name = ? OR p.id = ?", `ORDER BY d.started_at ${order}${limit ? " LIMIT ?" : ""}`);
        const params = limit ? [projectName, projectName, limit] : [projectName, projectName];
        return this.database.prepare(sql).all(...params) as unknown as DeploymentRow[];
    }

    private targetRowsByRun(runId: string) {
        return this.database
            .prepare(targetSelectSql("WHERE d.run_id = ?", "ORDER BY d.started_at ASC, d.server_id ASC"))
            .all(runId) as unknown as DeploymentRow[];
    }

    private projectIdByRef(projectRef: string) {
        const row = this.database.prepare("SELECT id FROM projects WHERE id = ? OR name = ?").get(projectRef, projectRef) as { id: string } | undefined;
        return row?.id;
    }
}

interface DeploymentRunRow {
    id: string;
    projectId: string;
    projectName: string;
    trigger: DeploymentTrigger;
    status: DeploymentStatus;
    startedAt: string;
    finishedAt: string | null;
    error: string | null;
}

interface DeploymentRow {
    id: string;
    runId: string | null;
    projectId: string;
    projectName: string;
    serverId: string;
    trigger: DeploymentTrigger;
    status: DeploymentStatus;
    phase: DeploymentPhase;
    agentJobId: string | null;
    agentStreamToken: string | null;
    startedAt: string;
    finishedAt: string | null;
    exitCode: string | null;
    error: string | null;
}

function runSelectSql(where: string, suffix: string) {
    return `SELECT
                r.id,
                r.project_id AS projectId,
                p.name AS projectName,
                r.trigger,
                r.status,
                r.started_at AS startedAt,
                r.finished_at AS finishedAt,
                r.error
             FROM deployment_runs r
             JOIN projects p ON p.id = r.project_id
             ${where}
             ${suffix}`;
}

function targetSelectSql(where: string, suffix: string) {
    return `SELECT
                d.id,
                d.run_id AS runId,
                d.project_id AS projectId,
                p.name AS projectName,
                d.server_id AS serverId,
                d.trigger,
                d.status,
                d.phase,
                d.agent_job_id AS agentJobId,
                d.agent_stream_token AS agentStreamToken,
                d.started_at AS startedAt,
                d.finished_at AS finishedAt,
                d.exit_code AS exitCode,
                d.error
             FROM deployments d
             JOIN projects p ON p.id = d.project_id
             ${where}
             ${suffix}`;
}

function summarizePhase(targets: DeploymentRecord[]): DeploymentPhase {
    if (!targets.length) {
        return "queued";
    }
    if (targets.some((target) => target.phase === "reconciling")) {
        return "reconciling";
    }
    if (targets.some((target) => target.phase === "reconnecting")) {
        return "reconnecting";
    }
    if (targets.some((target) => target.phase === "cleanup")) {
        return "cleanup";
    }
    if (targets.some((target) => target.phase === "running" || target.phase === "dispatching" || target.phase === "queued")) {
        return "running";
    }
    if (targets.some((target) => target.status === "failed")) {
        return "failed";
    }
    return "succeeded";
}

function buildRunLog(run: DeploymentRunRow, targets: DeploymentRecord[]) {
    const header = `Deployment run ${run.id} for ${targets.length} target(s)\n`;
    return trimLog(`${header}${targets.map((target) => [
        `\n===== Target ${target.serverId} (${target.status}${target.phase ? `/${target.phase}` : ""}) =====\n`,
        target.log
    ].join("")).join("")}`);
}

function normalizeStoredLogChunk(chunk: string) {
    return chunk.replace(/(^|\n)\[stderr\] /g, "$1");
}

function trimLog(log: string) {
    if (log.length <= maxLogLength) {
        return log;
    }

    return `... log trimmed to last ${maxLogLength} characters ...\n${log.slice(-maxLogLength)}`;
}
