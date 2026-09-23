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

    for (const candidate of candidates) {
        const idMatch = Object.entries(config).find(([, appSettings]) => appSettings.id === candidate);
        if (idMatch) {
            const [projectName, appSettings] = idMatch;
            return { projectName, appSettings };
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
export function webhookProjectCandidates(body: unknown) {
    if (!body || typeof body !== "object") {
        return [];
    }

    const payload = body as Record<string, unknown>;
    const repository = readRecord(payload.repository);
    const project = readRecord(payload.project);
    const candidates = [
        readIdentifier(repository?.id),
        readString(repository?.name),
        readString(repository?.path),
        readString(project?.name),
        readString(project?.path),
        readIdentifier(project?.id),
        readString(project?.path_with_namespace),
        readString(project?.http_url),
        readString(project?.web_url),
        readString(repository?.git_http_url),
        readString(repository?.git_ssh_url),
        readString(repository?.url),
        readString(payload.repository_url)
    ];

    return [...new Set(candidates.map((candidate) => candidate.trim()).filter(Boolean))];
}

/**
 * Returns the commit messages included in a GitLab Push Hook payload.
 */
export function webhookCommitMessages(body: unknown): string[] {
    if (!body || typeof body !== "object") {
        return [];
    }

    const commits = (body as Record<string, unknown>).commits;
    if (!Array.isArray(commits)) {
        return [];
    }

    return commits
        .map((commit) => readRecord(commit)?.message)
        .filter((message): message is string => typeof message === "string");
}

/**
 * Checks whether any commit in a GitLab Push Hook requests a skipped deployment.
 */
export function webhookRequestsSkipDeploy(body: unknown): boolean {
    return webhookCommitMessages(body).some((message) => message.toLowerCase().includes("[skip-deploy]"));
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

function readIdentifier(value: unknown) {
    return typeof value === "string" || typeof value === "number" ? String(value) : "";
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
