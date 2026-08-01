import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { AppDatabase } from "./database.js";
import { WebhookEventRecord, WebhookEventStatus } from "./types.js";

export interface WebhookEventInput {
    projectId?: string;
    projectName?: string;
    source: string;
    eventType?: string;
    status: WebhookEventStatus;
    reason: string;
    candidates?: string[];
    deploymentId?: string;
}

/**
 * Persists webhook receipts and routing outcomes for diagnostics.
 */
export class WebhookStore {
    constructor(private readonly database: DatabaseSync = new AppDatabase().connection) {}

    record(input: WebhookEventInput) {
        const now = new Date().toISOString();
        const id = randomUUID();
        this.database
            .prepare(
                `INSERT INTO webhook_events
                 (id, project_id, project_name, source, event_type, status, reason, candidates_json, deployment_id, received_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
                id,
                input.projectId ?? null,
                input.projectName ?? null,
                input.source,
                input.eventType ?? null,
                input.status,
                input.reason,
                JSON.stringify(input.candidates ?? []),
                input.deploymentId ?? null,
                now
            );

        return this.get(id);
    }

    latestForProject(projectIdOrName: string) {
        const row = this.database
            .prepare(
                `SELECT
                    id,
                    project_id AS projectId,
                    project_name AS projectName,
                    source,
                    event_type AS eventType,
                    status,
                    reason,
                    candidates_json AS candidatesJson,
                    deployment_id AS deploymentId,
                    received_at AS receivedAt
                 FROM webhook_events
                 WHERE project_id = ? OR project_name = ?
                 ORDER BY received_at DESC
                 LIMIT 1`
            )
            .get(projectIdOrName, projectIdOrName) as WebhookEventRow | undefined;
        return row ? rowToWebhookEvent(row) : null;
    }

    private get(id: string) {
        const row = this.database
            .prepare(
                `SELECT
                    id,
                    project_id AS projectId,
                    project_name AS projectName,
                    source,
                    event_type AS eventType,
                    status,
                    reason,
                    candidates_json AS candidatesJson,
                    deployment_id AS deploymentId,
                    received_at AS receivedAt
                 FROM webhook_events
                 WHERE id = ?`
            )
            .get(id) as WebhookEventRow | undefined;
        return row ? rowToWebhookEvent(row) : null;
    }
}

interface WebhookEventRow {
    id: string;
    projectId: string | null;
    projectName: string | null;
    source: string;
    eventType: string | null;
    status: WebhookEventStatus;
    reason: string;
    candidatesJson: string;
    deploymentId: string | null;
    receivedAt: string;
}

function rowToWebhookEvent(row: WebhookEventRow): WebhookEventRecord {
    return {
        id: row.id,
        ...(row.projectId ? { projectId: row.projectId } : {}),
        ...(row.projectName ? { projectName: row.projectName } : {}),
        source: row.source,
        ...(row.eventType ? { eventType: row.eventType } : {}),
        status: row.status,
        reason: row.reason,
        candidates: parseCandidates(row.candidatesJson),
        ...(row.deploymentId ? { deploymentId: row.deploymentId } : {}),
        receivedAt: row.receivedAt
    };
}

function parseCandidates(value: string) {
    try {
        const parsed = JSON.parse(value) as unknown;
        return Array.isArray(parsed) ? parsed.filter((candidate): candidate is string => typeof candidate === "string") : [];
    } catch {
        return [];
    }
}
