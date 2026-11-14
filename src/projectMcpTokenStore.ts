import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const tokenPrefix = "dpmcp_";

export interface ProjectMcpTokenStatus {
    enabled: boolean;
    createdAt?: string;
}

export interface CreatedProjectMcpToken extends ProjectMcpTokenStatus {
    enabled: true;
    token: string;
    createdAt: string;
}

/** Stores one project-scoped MCP token as a one-way hash per project. */
export class ProjectMcpTokenStore {
    constructor(private readonly database: DatabaseSync) {}

    status(projectId: string): ProjectMcpTokenStatus {
        const row = this.database
            .prepare("SELECT created_at AS createdAt FROM project_mcp_tokens WHERE project_id = ?")
            .get(projectId) as { createdAt: string } | undefined;
        return row ? { enabled: true, createdAt: row.createdAt } : { enabled: false };
    }

    create(projectId: string): CreatedProjectMcpToken {
        const token = `${tokenPrefix}${randomBytes(32).toString("base64url")}`;
        const createdAt = new Date().toISOString();
        this.database
            .prepare(
                `INSERT INTO project_mcp_tokens (project_id, token_hash, created_at)
                 VALUES (?, ?, ?)
                 ON CONFLICT(project_id) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at`
            )
            .run(projectId, hashToken(token), createdAt);
        return { enabled: true, token, createdAt };
    }

    projectIdForToken(token: string | undefined) {
        if (!token?.startsWith(tokenPrefix)) {
            return undefined;
        }
        const row = this.database
            .prepare("SELECT project_id AS projectId FROM project_mcp_tokens WHERE token_hash = ?")
            .get(hashToken(token)) as { projectId: string } | undefined;
        return row?.projectId;
    }

    revoke(projectId: string) {
        return this.database.prepare("DELETE FROM project_mcp_tokens WHERE project_id = ?").run(projectId).changes > 0;
    }
}

function hashToken(token: string) {
    return createHash("sha256").update(token).digest("hex");
}
