import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { AppDatabase } from "./database.js";
import { decryptSecret, encryptSecret } from "./secretStore.js";
import { VaultSecret, VaultSecretPayload } from "./types.js";

/**
 * Stores reusable deploy-time secrets for the controller's internal vault.
 *
 * Values remain encrypted at rest. Plaintext is returned only through
 * `resolveValue`, which is intended for the controller-side deploy resolver.
 */
export class VaultSecretStore {
    constructor(private readonly database = new AppDatabase().connection) {}

    list(): VaultSecret[] {
        const rows = this.database
            .prepare(
                `SELECT id, namespace, key, description, created_at AS createdAt, updated_at AS updatedAt
                 FROM vault_secrets
                 ORDER BY namespace, key`
            )
            .all() as unknown as VaultSecretRow[];
        const references = this.projectReferences();
        return rows.map((row) => ({
            id: row.id,
            namespace: row.namespace,
            key: row.key,
            ...(row.description ? { description: row.description } : {}),
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            referencedByProjects: references.get(row.id) ?? []
        }));
    }

    get(secretId: string): VaultSecret | null {
        const row = this.database
            .prepare(
                `SELECT id, namespace, key, description, created_at AS createdAt, updated_at AS updatedAt
                 FROM vault_secrets
                 WHERE id = ?`
            )
            .get(secretId) as VaultSecretRow | undefined;
        if (!row) {
            return null;
        }

        return {
            id: row.id,
            namespace: row.namespace,
            key: row.key,
            ...(row.description ? { description: row.description } : {}),
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            referencedByProjects: this.projectReferences().get(row.id) ?? []
        };
    }

    create(payload: VaultSecretPayload) {
        const input = normalizeVaultSecretPayload(payload, true);
        const now = new Date().toISOString();
        const record = {
            id: randomUUID(),
            namespace: input.namespace,
            key: input.key,
            description: input.description,
            value: input.value,
            createdAt: now,
            updatedAt: now
        };

        this.database
            .prepare(
                `INSERT INTO vault_secrets
                 (id, namespace, key, description, value, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`
            )
            .run(record.id, record.namespace, record.key, record.description || null, encryptSecret(record.value) ?? "", record.createdAt, record.updatedAt);

        return this.get(record.id);
    }

    update(secretId: string, payload: VaultSecretPayload) {
        const existing = this.requireRow(secretId);
        const input = normalizeVaultSecretPayload(payload, false);
        const namespace = input.namespace || existing.namespace;
        const key = input.key || existing.key;
        const description = input.description ?? existing.description ?? "";
        const encryptedValue = input.value !== undefined ? encryptSecret(input.value) ?? "" : existing.value;
        const now = new Date().toISOString();

        this.database
            .prepare(
                `UPDATE vault_secrets
                 SET namespace = ?, key = ?, description = ?, value = ?, updated_at = ?
                 WHERE id = ?`
            )
            .run(namespace, key, description || null, encryptedValue, now, secretId);

        return this.get(secretId);
    }

    delete(secretId: string) {
        this.requireRow(secretId);
        const references = this.projectReferences().get(secretId) ?? [];
        if (references.length) {
            throw new Error(`Secret is still referenced by ${references.join(", ")}.`);
        }

        this.database.prepare("DELETE FROM vault_secrets WHERE id = ?").run(secretId);
        return { deleted: true };
    }

    resolveValue(secretId: string) {
        const row = this.requireRow(secretId);
        const value = decryptSecret(row.value);
        if (!value) {
            throw new Error(`Vault secret ${row.namespace}/${row.key} has no readable value.`);
        }

        return value;
    }

    private requireRow(secretId: string) {
        const row = this.database
            .prepare(
                `SELECT id, namespace, key, description, value, created_at AS createdAt, updated_at AS updatedAt
                 FROM vault_secrets
                 WHERE id = ?`
            )
            .get(secretId) as VaultSecretStoredRow | undefined;
        if (!row) {
            throw new Error("Secret does not exist.");
        }

        return row;
    }

    private projectReferences() {
        const rows = this.database.prepare("SELECT name, env_secrets_json AS envSecretsJson FROM projects").all() as unknown as Array<{ name: string; envSecretsJson: string | null }>;
        const references = new Map<string, string[]>();
        for (const row of rows) {
            for (const secretId of referencedVaultSecretIds(row.envSecretsJson)) {
                references.set(secretId, [...(references.get(secretId) ?? []), row.name]);
            }
        }

        return references;
    }
}

interface VaultSecretRow {
    id: string;
    namespace: string;
    key: string;
    description: string | null;
    createdAt: string;
    updatedAt: string;
}

interface VaultSecretStoredRow extends VaultSecretRow {
    value: string;
}

function normalizeVaultSecretPayload(payload: VaultSecretPayload, requireValue: boolean) {
    const namespace = String(payload.namespace ?? "").trim() || "default";
    const key = String(payload.key ?? "").trim();
    const description = String(payload.description ?? "").trim();
    const rawValue = payload.value;
    const value = rawValue === undefined ? undefined : String(rawValue);

    if (!key) {
        throw new Error("Secret key is required.");
    }
    if (requireValue && !value) {
        throw new Error("Secret value is required.");
    }

    return { namespace, key, description, value };
}

function referencedVaultSecretIds(value: string | null) {
    if (!value) {
        return [];
    }

    try {
        const parsed = JSON.parse(value) as Array<{ source?: string; vaultSecretId?: string }>;
        return parsed
            .map((secret) => secret.source === "vault" ? String(secret.vaultSecretId ?? "").trim() : "")
            .filter(Boolean);
    } catch {
        return [];
    }
}
