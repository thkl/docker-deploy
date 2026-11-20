import { basename } from "node:path";

/**
 * Returns a Docker Compose compatible project name for a project checkout.
 * Compose names must be lowercase and may only contain letters, numbers,
 * hyphens, and underscores, with an alphanumeric first character.
 */
export function composeProjectNameFromPath(projectPath: string, fallback: string) {
    const normalize = (value: string) => value
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^[-_]+/, "");
    const directoryName = basename(projectPath.replace(/\/+$/, ""));
    return normalize(directoryName) || normalize(fallback) || "project";
}
