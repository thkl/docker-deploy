import { ProjectSettings } from "./types.js";

/**
 * Configured project resolved from an incoming webhook payload.
 */
export interface ResolvedWebhookProject {
    projectName: string;
    appSettings: ProjectSettings;
}

/**
 * Resolves a GitLab webhook payload to the configured project record.
 *
 * Matching first tries direct project-name candidates, then falls back to
 * normalized repository URL identity so display names do not break UI status.
 */
export function resolveWebhookProject(body: unknown, config: Record<string, ProjectSettings>): ResolvedWebhookProject | null {
    const candidates = webhookProjectCandidates(body);
    for (const candidate of candidates) {
        const exactMatch = config[candidate];
        if (exactMatch) {
            return { projectName: candidate, appSettings: exactMatch };
        }
    }

    const normalizedRepositoryCandidates = new Set(candidates.map(normalizeGitRepositoryIdentity).filter(Boolean));
    for (const [projectName, appSettings] of Object.entries(config)) {
        if (appSettings.repositoryUrl && normalizedRepositoryCandidates.has(normalizeGitRepositoryIdentity(appSettings.repositoryUrl))) {
            return { projectName, appSettings };
        }
    }

    return null;
}

/**
 * Extracts all useful project identifiers from a GitLab push payload.
 */
function webhookProjectCandidates(body: unknown) {
    if (!body || typeof body !== "object") {
        return [];
    }

    const payload = body as Record<string, unknown>;
    const repository = readRecord(payload.repository);
    const project = readRecord(payload.project);
    const candidates = [
        readString(repository?.name),
        readString(repository?.path),
        readString(project?.name),
        readString(project?.path),
        readString(project?.path_with_namespace),
        readString(repository?.git_http_url),
        readString(repository?.git_ssh_url),
        readString(repository?.url),
        readString(payload.repository_url)
    ];

    return [...new Set(candidates.map((candidate) => candidate.trim()).filter(Boolean))];
}

/**
 * Safely narrows an unknown value to a record-like object.
 */
function readRecord(value: unknown) {
    return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

/**
 * Safely reads string fields from unknown webhook payload values.
 */
function readString(value: unknown) {
    return typeof value === "string" ? value : "";
}

/**
 * Converts Git repository URLs into comparable `host/path` identities.
 *
 * This makes `git@gitlab.example.com:group/repo.git` and
 * `https://gitlab.example.com/group/repo.git` match the same configured repo.
 */
function normalizeGitRepositoryIdentity(value: string) {
    const trimmed = value.trim();
    if (!trimmed) {
        return "";
    }

    const urlValue = trimmed.replace(/^git@([^:]+):/i, "ssh://git@$1/");
    try {
        const url = new URL(urlValue);
        return `${url.hostname}${url.pathname}`
            .replace(/\.git$/i, "")
            .replace(/\/+$/g, "")
            .toLowerCase();
    } catch (error) {
        return trimmed
            .replace(/\.git$/i, "")
            .replace(/\/+$/g, "")
            .toLowerCase();
    }
}
