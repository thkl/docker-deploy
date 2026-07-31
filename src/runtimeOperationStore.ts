import { randomUUID } from "node:crypto";
import { AppDatabase } from "./database.js";
import { RuntimeServiceAction } from "./types.js";

export type RuntimeOperationStatus = "succeeded" | "failed";

export interface RuntimeOperationRecord {
    id: string;
    projectId?: string;
    projectName: string;
    serverId: string;
    service: string;
    action: RuntimeServiceAction;
    status: RuntimeOperationStatus;
    startedAt: string;
    finishedAt: string;
    error?: string;
    output: string;
}

const maxOperationsPerProject = 25;
const maxOutputLength = 80_000;

/**
 * Stores short service-level runtime actions like restart, stop, recreate, and
 * pull separately from full deployment history.
 */
export class RuntimeOperationStore {
    constructor(private readonly database = new AppDatabase().connection) {}

    list(projectRef: string) {
        const rows = this.database
            .prepare(
                `SELECT
                    o.id,
                    o.project_id AS projectId,
                    p.name AS projectName,
                    o.server_id AS serverId,
                    o.service,
                    o.action,
                    o.status,
                    o.started_at AS startedAt,
                    o.finished_at AS finishedAt,
                    o.error,
                    o.output
                 FROM runtime_operations o
                 JOIN projects p ON p.id = o.project_id
                 WHERE p.name = ? OR p.id = ?
                 ORDER BY o.started_at DESC
                 LIMIT ?`
            )
            .all(projectRef, projectRef, maxOperationsPerProject) as unknown as RuntimeOperationRow[];

        return rows.map(rowToRecord);
    }

    record(projectRef: string, operation: Omit<RuntimeOperationRecord, "id" | "projectId" | "projectName">) {
        const project = this.projectByRef(projectRef);
        if (!project) {
            throw new Error("Project does not exist.");
        }

        const record: RuntimeOperationRecord = {
            id: `${Date.now()}-${randomUUID().slice(0, 8)}`,
            projectId: project.id,
            projectName: project.name,
            ...operation,
            output: trimOutput(operation.output)
        };

        this.database
            .prepare(
                `INSERT INTO runtime_operations
                 (id, project_id, server_id, service, action, status, started_at, finished_at, error, output)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
                record.id,
                project.id,
                record.serverId,
                record.service,
                record.action,
                record.status,
                record.startedAt,
                record.finishedAt,
                record.error ?? null,
                record.output
            );
        this.trimHistory(project.id);

        return record;
    }

    private trimHistory(projectId: string) {
        this.database
            .prepare(
                `DELETE FROM runtime_operations
                 WHERE project_id = ?
                   AND id NOT IN (
                       SELECT id FROM runtime_operations
                       WHERE project_id = ?
                       ORDER BY started_at DESC
                       LIMIT ?
                   )`
            )
            .run(projectId, projectId, maxOperationsPerProject);
    }

    private projectByRef(projectRef: string) {
        return this.database.prepare("SELECT id, name FROM projects WHERE id = ? OR name = ?").get(projectRef, projectRef) as { id: string; name: string } | undefined;
    }
}

interface RuntimeOperationRow {
    id: string;
    projectId: string;
    projectName: string;
    serverId: string;
    service: string;
    action: RuntimeServiceAction;
    status: RuntimeOperationStatus;
    startedAt: string;
    finishedAt: string;
    error: string | null;
    output: string;
}

function rowToRecord(row: RuntimeOperationRow): RuntimeOperationRecord {
    return {
        id: row.id,
        projectId: row.projectId,
        projectName: row.projectName,
        serverId: row.serverId,
        service: row.service,
        action: row.action,
        status: row.status,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        ...(row.error ? { error: row.error } : {}),
        output: row.output
    };
}

function trimOutput(output: string) {
    if (output.length <= maxOutputLength) {
        return output;
    }

    return `... output trimmed to last ${maxOutputLength} characters ...\n${output.slice(-maxOutputLength)}`;
}
