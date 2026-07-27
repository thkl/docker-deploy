import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ProjectConfig, ProjectSettings } from "./types.js";

export class ConfigStore {
    constructor(private readonly configPath = join("./data", "config.json")) {}

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

    writeConfig(config: ProjectConfig) {
        mkdirSync(dirname(this.configPath), { recursive: true });
        writeFileSync(this.configPath, `${JSON.stringify(config, null, 2)}\n`);
    }

    fetchProfile(repoName: string): ProjectSettings | undefined {
        try {
            return this.readConfig()[repoName];
        } catch (error) {
            console.log("Error reading config");
            return undefined;
        }
    }
}

export function maskToken(token: string) {
    if (token.length <= 8) {
        return "********";
    }

    return `${token.slice(0, 6)}...${token.slice(-4)}`;
}
