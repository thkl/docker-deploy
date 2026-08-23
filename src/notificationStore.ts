import { randomUUID } from "node:crypto";
import { AppDatabase } from "./database.js";
import { NotificationDeliveryRecord } from "./types.js";

export class NotificationStore {
    constructor(private readonly database = new AppDatabase().connection) {}

    record(payload: Omit<NotificationDeliveryRecord, "id" | "createdAt"> & { createdAt?: string }) {
        const record: NotificationDeliveryRecord = {
            id: `${Date.now()}-${randomUUID().slice(0, 8)}`,
            createdAt: payload.createdAt ?? new Date().toISOString(),
            ...payload
        };

        this.database
            .prepare(
                `INSERT INTO notification_events
                 (id, event, deployment_id, channel_id, channel_name, channel_type, project_id, project_name, service, title, body, status, error, dedupe_key, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
                record.id,
                record.event,
                record.deploymentId ?? null,
                record.channelId ?? null,
                record.channelName ?? null,
                record.channelType ?? null,
                record.projectId ?? null,
                record.projectName ?? null,
                record.service ?? null,
                record.title,
                record.body,
                record.status,
                record.error ?? null,
                record.dedupeKey ?? null,
                record.createdAt
            );

        this.prune();
        return record;
    }

    list(limit = 100) {
        const rows = this.database
            .prepare(
                `SELECT id, event, deployment_id AS deploymentId, channel_id AS channelId, channel_name AS channelName, channel_type AS channelType,
                        project_id AS projectId, project_name AS projectName, service, title, body, status, error,
                        dedupe_key AS dedupeKey, created_at AS createdAt
                 FROM notification_events
                 ORDER BY created_at DESC
                 LIMIT ?`
            )
            .all(Math.max(1, Math.min(limit, 500))) as unknown as NotificationDeliveryRecord[];

        return rows;
    }

    hasDedupeKey(dedupeKey: string) {
        const row = this.database
            .prepare("SELECT id FROM notification_events WHERE dedupe_key = ? AND status = 'sent' LIMIT 1")
            .get(dedupeKey) as { id: string } | undefined;
        return Boolean(row);
    }

    private prune() {
        this.database
            .prepare(
                `DELETE FROM notification_events
                 WHERE id NOT IN (
                    SELECT id FROM notification_events ORDER BY created_at DESC LIMIT 500
                 )`
            )
            .run();
    }
}
