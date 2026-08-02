import { AppDatabase, listServers } from "./database.js";
import { ServerActiveJob, ServerCapabilities, ServerPayload, ServerRecord } from "./types.js";

export interface ServerHealthSnapshot {
    status: "online" | "offline" | "unpaired";
    agentServerId?: string;
    agentVersion?: string;
    activeJobs?: ServerActiveJob[];
    lastHealthError?: string;
    capabilities?: ServerCapabilities;
}

/**
 * Stores target Docker servers known to the controller.
 */
export class ServerStore {
    constructor(private readonly database = new AppDatabase().connection) {}

    /**
     * Lists all configured target servers.
     */
    list() {
        return listServers(this.database);
    }

    /**
     * Returns one server record by ID.
     */
    get(serverId: string): ServerRecord | undefined {
        return this.list().find((server) => server.id === serverId);
    }

    /**
     * Creates a remote server record before pairing.
     */
    createRemote(payload: ServerPayload) {
        const id = normalizeServerId(payload.id || payload.name);
        const now = new Date().toISOString();
        this.database
            .prepare(
                `INSERT INTO servers
                 (id, name, kind, agent_server_id, base_url, agent_public_encryption_key, agent_public_signing_key, status, capabilities_json, created_at, updated_at)
                 VALUES (?, ?, 'remote', ?, ?, ?, ?, 'unpaired', ?, ?, ?)`
            )
            .run(
                id,
                payload.name?.trim() || id,
                payload.agentServerId?.trim() || id,
                normalizeBaseUrl(payload.baseUrl),
                payload.agentPublicEncryptionKey?.trim() || null,
                payload.agentPublicSigningKey?.trim() || null,
                payload.capabilities ? JSON.stringify(payload.capabilities) : null,
                now,
                now
            );

        return this.get(id);
    }

    /**
     * Updates editable server metadata. Local servers allow display-name edits
     * only; remote servers also allow URL/key maintenance.
     */
    updateServer(serverId: string, payload: ServerPayload) {
        const existing = this.requireServer(serverId);
        const now = new Date().toISOString();
        const nextName = payload.name?.trim() || existing.name;
        if (existing.kind === "local") {
            this.database
                .prepare("UPDATE servers SET name = ?, updated_at = ? WHERE id = ?")
                .run(nextName, now, serverId);
            return this.get(serverId);
        }

        this.database
            .prepare(
                `UPDATE servers
                 SET name = ?,
                     base_url = ?,
                     agent_public_encryption_key = ?,
                     agent_public_signing_key = ?,
                     updated_at = ?
                 WHERE id = ?`
            )
            .run(
                nextName,
                normalizeBaseUrl(payload.baseUrl || existing.baseUrl),
                payload.agentPublicEncryptionKey?.trim() || existing.agentPublicEncryptionKey || null,
                payload.agentPublicSigningKey?.trim() || existing.agentPublicSigningKey || null,
                now,
                serverId
            );

        return this.get(serverId);
    }

    /**
     * Updates a remote server record.
     */
    updateRemote(serverId: string, payload: ServerPayload) {
        this.requireRemote(serverId);
        return this.updateServer(serverId, payload);
    }

    /**
     * Deletes a remote server when no project still targets it.
     */
    deleteRemote(serverId: string) {
        const server = this.requireRemote(serverId);
        const projectCount = this.database
            .prepare("SELECT COUNT(*) AS count FROM projects WHERE server_id = ? OR server_ids_json LIKE ?")
            .get(server.id, `%"${server.id.replace(/"/g, "\"\"")}"%`) as { count: number };
        if (projectCount.count > 0) {
            throw new Error("Cannot remove this agent while projects still target it.");
        }

        this.database.exec("BEGIN");
        try {
            this.database
                .prepare("UPDATE webhook_events SET deployment_id = NULL WHERE deployment_id IN (SELECT id FROM deployments WHERE server_id = ?)")
                .run(server.id);
            this.database
                .prepare("DELETE FROM deployment_logs WHERE deployment_id IN (SELECT id FROM deployments WHERE server_id = ?)")
                .run(server.id);
            this.database.prepare("DELETE FROM runtime_operations WHERE server_id = ?").run(server.id);
            this.database.prepare("DELETE FROM deployments WHERE server_id = ?").run(server.id);
            this.database.prepare("DELETE FROM deployment_runs WHERE id NOT IN (SELECT DISTINCT run_id FROM deployments WHERE run_id IS NOT NULL)").run();
            this.database.prepare("DELETE FROM agents WHERE server_id = ?").run(server.id);
            this.database.prepare("DELETE FROM servers WHERE id = ?").run(server.id);
            this.database.exec("COMMIT");
        } catch (error) {
            this.database.exec("ROLLBACK");
            throw error;
        }
    }

    /**
     * Marks a remote server as paired with controller public keys.
     */
    markPaired(serverId: string, controllerPublicEncryptionKey: string, controllerPublicSigningKey: string) {
        const now = new Date().toISOString();
        this.database
            .prepare(
                `UPDATE servers
                 SET controller_public_encryption_key = ?,
                     controller_public_signing_key = ?,
                     status = 'online',
                     paired_at = COALESCE(paired_at, ?),
                     last_seen_at = ?,
                     updated_at = ?
                 WHERE id = ?`
            )
            .run(controllerPublicEncryptionKey, controllerPublicSigningKey, now, now, now, serverId);
        return this.get(serverId);
    }

    /**
     * Stores the latest capability snapshot reported by an agent.
     */
    updateCapabilities(serverId: string, capabilities: ServerCapabilities) {
        this.database
            .prepare("UPDATE servers SET capabilities_json = ?, last_seen_at = ?, updated_at = ?, status = 'online' WHERE id = ?")
            .run(JSON.stringify(capabilities), new Date().toISOString(), new Date().toISOString(), serverId);
        return this.get(serverId);
    }

    /**
     * Stores a full health snapshot used by the settings UI.
     */
    updateHealth(serverId: string, health: ServerHealthSnapshot) {
        const now = new Date().toISOString();
        this.database
            .prepare(
                `UPDATE servers
                 SET status = ?,
                     last_seen_at = CASE WHEN ? = 'offline' THEN last_seen_at ELSE ? END,
                     updated_at = ?,
                     agent_server_id = COALESCE(?, agent_server_id),
                     agent_version = ?,
                     active_jobs_json = ?,
                     last_health_error = ?,
                     capabilities_json = COALESCE(?, capabilities_json)
                 WHERE id = ?`
            )
            .run(
                health.status,
                health.status,
                now,
                now,
                health.agentServerId ?? null,
                health.agentVersion ?? null,
                JSON.stringify(health.activeJobs ?? []),
                health.lastHealthError ?? null,
                health.capabilities ? JSON.stringify(health.capabilities) : null,
                serverId
            );
        return this.get(serverId);
    }

    /**
     * Returns a unique server id for controller-owned server rows.
     */
    nextAvailableId(baseId: string) {
        const normalized = normalizeServerId(baseId);
        if (!this.get(normalized)) {
            return normalized;
        }

        for (let index = 2; index < 10_000; index += 1) {
            const candidate = `${normalized}-${index}`;
            if (!this.get(candidate)) {
                return candidate;
            }
        }

        throw new Error("Could not allocate a unique server ID.");
    }

    /**
     * Updates a server heartbeat/status after a successful controller call.
     */
    markSeen(serverId: string, status: "online" | "offline") {
        this.database
            .prepare("UPDATE servers SET status = ?, last_seen_at = ?, updated_at = ? WHERE id = ?")
            .run(status, new Date().toISOString(), new Date().toISOString(), serverId);
    }

    /**
     * Ensures a server exists and can receive remote jobs.
     */
    requireRemote(serverId: string) {
        const server = this.requireServer(serverId);

        if (server.kind !== "remote") {
            throw new Error("Only remote servers can be edited here.");
        }

        return server;
    }

    /**
     * Ensures a server exists.
     */
    requireServer(serverId: string) {
        const server = this.get(serverId);
        if (!server) {
            throw new Error("Server does not exist.");
        }

        return server;
    }
}

/**
 * Normalizes a UI/server ID into a Docker-safe identifier.
 */
function normalizeServerId(value: string | undefined) {
    const trimmed = value?.trim();
    if (!trimmed || !/^[a-zA-Z0-9._-]+$/.test(trimmed)) {
        throw new Error("Server ID can only contain letters, numbers, dots, underscores, and hyphens.");
    }

    return trimmed;
}

/**
 * Validates remote agent base URLs.
 */
function normalizeBaseUrl(value: string | undefined) {
    const trimmed = value?.trim().replace(/\/+$/, "");
    if (!trimmed) {
        throw new Error("Agent base URL is required.");
    }

    const parsed = new URL(trimmed);
    if (!["http:", "https:"].includes(parsed.protocol)) {
        throw new Error("Agent base URL must start with http:// or https://.");
    }

    return parsed.toString().replace(/\/+$/, "");
}
