import { randomUUID } from "node:crypto";
import { AppDatabase, runDatabaseTransaction } from "./database.js";
import { CapturedReleaseSnapshot, ProjectReleaseSnapshot } from "./types.js";

export const defaultMaxSnapshotsPerProject = 20;

export class ReleaseStore {
    constructor(private readonly database = new AppDatabase().connection) {}

    list(projectRef: string) {
        const rows = this.database
            .prepare(selectSql("WHERE p.id = ? OR p.name = ?", "ORDER BY r.created_at DESC"))
            .all(projectRef, projectRef) as unknown as ReleaseSnapshotRow[];
        return rows.map((row) => this.rowToRecord(row));
    }

    get(projectRef: string, releaseId: string) {
        const row = this.database
            .prepare(selectSql("WHERE r.id = ? AND (p.id = ? OR p.name = ?)", "LIMIT 1"))
            .get(releaseId, projectRef, projectRef) as ReleaseSnapshotRow | undefined;
        return row ? this.rowToRecord(row) : null;
    }

    save(projectName: string, deployment: { id: string; runId?: string; projectId?: string }, snapshot: CapturedReleaseSnapshot, snapshotLimit = defaultMaxSnapshotsPerProject) {
        const projectId = deployment.projectId ?? this.projectIdByRef(projectName);
        if (!projectId) {
            throw new Error("Project does not exist.");
        }

        const record: ProjectReleaseSnapshot = {
            id: `${Date.now()}-${randomUUID().slice(0, 8)}`,
            projectId,
            projectName,
            deploymentId: deployment.id,
            ...(deployment.runId ? { runId: deployment.runId } : {}),
            ...snapshot,
            createdAt: new Date().toISOString(),
            rollbackAvailable: snapshot.buildServices.length === 0,
            ...(snapshot.buildServices.length ? { rollbackUnavailableReason: `Build-backed services are not deterministic: ${snapshot.buildServices.join(", ")}.` } : {})
        };

        runDatabaseTransaction(this.database, () => {
            this.database
                .prepare(
                    `INSERT INTO release_snapshots
                     (id, project_id, deployment_id, run_id, server_id, compose_project_name, project_path, deployment_strategy, compose_yaml, git_sha, images_json, build_services_json, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                )
                .run(
                    record.id,
                    projectId,
                    record.deploymentId,
                    record.runId ?? null,
                    record.serverId,
                    record.composeProjectName,
                    record.projectPath,
                    record.deploymentStrategy,
                    record.composeYaml,
                    record.gitSha ?? null,
                    JSON.stringify(record.images),
                    JSON.stringify(record.buildServices),
                    record.createdAt
                );
            this.trim(projectId, snapshotLimit);
        });

        return record;
    }

    deleteProject(projectRef: string) {
        const projectId = this.projectIdByRef(projectRef);
        if (projectId) {
            this.database.prepare("DELETE FROM release_snapshots WHERE project_id = ?").run(projectId);
        }
    }

    private trim(projectId: string, snapshotLimit: number) {
        const limit = Math.max(1, Math.min(Math.trunc(snapshotLimit) || defaultMaxSnapshotsPerProject, 200));
        this.database
            .prepare(
                `DELETE FROM release_snapshots
                 WHERE project_id = ?
                   AND id NOT IN (
                       SELECT id FROM release_snapshots
                       WHERE project_id = ?
                       ORDER BY created_at DESC
                       LIMIT ?
                   )`
            )
            .run(projectId, projectId, limit);
    }

    private projectIdByRef(projectRef: string) {
        const row = this.database.prepare("SELECT id FROM projects WHERE id = ? OR name = ?").get(projectRef, projectRef) as { id: string } | undefined;
        return row?.id;
    }

    private rowToRecord(row: ReleaseSnapshotRow): ProjectReleaseSnapshot {
        const buildServices = readJsonArray<string>(row.buildServicesJson);
        return {
            id: row.id,
            projectId: row.projectId,
            projectName: row.projectName,
            deploymentId: row.deploymentId,
            ...(row.runId ? { runId: row.runId } : {}),
            serverId: row.serverId,
            composeProjectName: row.composeProjectName,
            projectPath: row.projectPath,
            deploymentStrategy: row.deploymentStrategy === "swarm" ? "swarm" : "compose",
            composeYaml: row.composeYaml,
            ...(row.gitSha ? { gitSha: row.gitSha } : {}),
            images: readJsonArray(row.imagesJson),
            buildServices,
            createdAt: row.createdAt,
            rollbackAvailable: buildServices.length === 0,
            ...(buildServices.length ? { rollbackUnavailableReason: `Build-backed services are not deterministic: ${buildServices.join(", ")}.` } : {})
        };
    }
}

interface ReleaseSnapshotRow {
    id: string;
    projectId: string;
    projectName: string;
    deploymentId: string;
    runId: string | null;
    serverId: string;
    composeProjectName: string;
    projectPath: string;
    deploymentStrategy: string;
    composeYaml: string;
    gitSha: string | null;
    imagesJson: string;
    buildServicesJson: string;
    createdAt: string;
}

function selectSql(where: string, suffix: string) {
    return `SELECT
                r.id,
                r.project_id AS projectId,
                p.name AS projectName,
                r.deployment_id AS deploymentId,
                r.run_id AS runId,
                r.server_id AS serverId,
                r.compose_project_name AS composeProjectName,
                r.project_path AS projectPath,
                r.deployment_strategy AS deploymentStrategy,
                r.compose_yaml AS composeYaml,
                r.git_sha AS gitSha,
                r.images_json AS imagesJson,
                r.build_services_json AS buildServicesJson,
                r.created_at AS createdAt
             FROM release_snapshots r
             JOIN projects p ON p.id = r.project_id
             ${where}
             ${suffix}`;
}

function readJsonArray<T>(value: string): T[] {
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed as T[] : [];
    } catch {
        return [];
    }
}
