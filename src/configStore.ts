import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ProjectConfig, ProjectSettings } from "./types.js";

/**
 * JSON-backed project configuration store.
 *
 * This is intentionally small and synchronous today. The upcoming SQLite
 * migration should keep this class boundary or replace it with an equivalent
 * repository interface so routes do not care where project data lives.
 */
export class ConfigStore {
    constructor(private readonly configPath = join("./data", "config.json")) {}

    /**
     * Reads all configured projects keyed by project name.
     */
    readConfig(): ProjectConfig {
        if (!existsSync(this.configPath)) {
            return {};
        }

        const content = readFileSync(this.configPath, "utf8").trim();
        if (!content) {
            return {};
        }

        const parsed = JSON.parse(content);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("Config must be an object keyed by repository name.");
        }

        return parsed as ProjectConfig;
    }

    /**
     * Persists the full project config object.
     */
    writeConfig(config: ProjectConfig) {
        mkdirSync(dirname(this.configPath), { recursive: true });
        writeFileSync(this.configPath, `${JSON.stringify(config, null, 2)}\n`);
    }

    /**
     * Returns one project profile without throwing if the config file is broken.
     */
    fetchProfile(repoName: string): ProjectSettings | undefined {
        try {
            return this.readConfig()[repoName];
        } catch (error) {
            console.log("Error reading config");
            return undefined;
        }
    }
}

/**
 * Masks a stored token for API responses so the UI can show that a secret
 * exists without exposing it.
 */
export function maskToken(token: string) {
    if (token.length <= 8) {
        return "********";
    }

    return `${token.slice(0, 6)}...${token.slice(-4)}`;
}
