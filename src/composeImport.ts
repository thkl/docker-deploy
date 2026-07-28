import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { defaultProjectPath } from "./globalSettingsStore.js";
import { GlobalSettings, ProjectSettings } from "./types.js";

const execFileAsync = promisify(execFile);
const composeFileNames = ["docker-compose.yaml", "docker-compose.yml", "compose.yaml", "compose.yml"];

export interface ImportedCompose {
    composeFile: string;
    compose: string;
}

export async function importProjectCompose(repoName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings): Promise<ImportedCompose> {
    const projectPath = appSettings.path ?? defaultProjectPath(globalSettings, repoName);
    await ensureProjectCheckout(projectPath, appSettings.repositoryUrl);

    for (const composeFileName of composeFileNames) {
        const composePath = join(projectPath, composeFileName);
        if (existsSync(composePath)) {
            return {
                composeFile: composeFileName,
                compose: await readFile(composePath, "utf8")
            };
        }
    }

    throw new Error("No Docker Compose file found in the repository.");
}

async function ensureProjectCheckout(projectPath: string, repositoryUrl?: string) {
    if (existsSync(join(projectPath, ".git"))) {
        await execFileAsync("git", ["-C", projectPath, "pull", "--ff-only"]);
        return;
    }

    if (!repositoryUrl) {
        throw new Error("Project folder is missing or is not a Git checkout, and no repository URL is configured.");
    }

    if (existsSync(projectPath) && !(await isEmptyDirectory(projectPath))) {
        throw new Error("Project folder exists but is not an empty directory or a Git checkout.");
    }

    await mkdir(dirname(projectPath), { recursive: true });
    await execFileAsync("git", ["clone", repositoryUrl, projectPath]);
}

async function isEmptyDirectory(path: string) {
    try {
        return (await readdir(path)).length === 0;
    } catch (error) {
        return false;
    }
}
