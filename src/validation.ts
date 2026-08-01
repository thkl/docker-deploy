import { GlobalSettings, ProjectPayload, TraefikSettings } from "./types.js";

/**
 * Normalizes and validates the project name used as the primary project key.
 */
export function normalizeProjectName(name?: string) {
    const repoName = name?.trim();
    if (!repoName) {
        throw new Error("Repository name is required.");
    }

    if (!/^[a-zA-Z0-9._-]+$/.test(repoName)) {
        throw new Error("Repository name can only contain letters, numbers, dots, underscores, and hyphens.");
    }

    return repoName;
}

/**
 * Normalizes an optional repository URL and accepts HTTPS, SSH URLs, and
 * scp-like Git syntax such as `git@example.com:group/project.git`.
 */
export function normalizeRepositoryUrl(repositoryUrl?: string) {
    const value = repositoryUrl?.trim();
    if (!value) {
        return "";
    }

    if (/^git@[\w.-]+:[\w./-]+(?:\.git)?$/.test(value)) {
        return value;
    }

    try {
        const url = new URL(value);
        if (url.protocol !== "https:" && url.protocol !== "ssh:") {
            throw new Error("Repository URL must use https://, ssh://, or git@host:path syntax.");
        }

        return value;
    } catch (error) {
        if (error instanceof Error && error.message.startsWith("Repository URL")) {
            throw error;
        }

        throw new Error("Repository URL must be a valid Git URL.");
    }
}

/**
 * Normalizes optional Docker/Traefik resource names.
 */
function normalizeOptionalName(name?: string) {
    const value = name?.trim();
    if (!value) {
        return "";
    }

    if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
        throw new Error("Names can only contain letters, numbers, dots, underscores, and hyphens.");
    }

    return value;
}

/**
 * Validates project-level Traefik settings and fills missing values from global
 * defaults.
 */
export function normalizeTraefikSettings(body: ProjectPayload, globalSettings?: GlobalSettings): TraefikSettings | undefined {
    const grouped = body.traefik;
    const enabled = grouped?.enabled ?? body.traefikEnabled;

    if (!enabled) {
        return undefined;
    }

    const hostname = (grouped?.hostname ?? body.traefikHostname)?.trim();
    if (!hostname) {
        throw new Error("Traefik hostname is required when Traefik is enabled.");
    }

    if (!/^[a-zA-Z0-9.-]+$/.test(hostname)) {
        throw new Error("Traefik hostname can only contain letters, numbers, dots, and hyphens.");
    }

    const port = Number(grouped?.port ?? body.traefikPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("Traefik service port must be a number between 1 and 65535.");
    }

    const entryPoints = (grouped?.entryPoints ?? body.traefikEntryPoints)?.trim() || globalSettings?.defaultTraefikEntryPoints || "websecure";
    const certResolver = (grouped?.certResolver ?? body.traefikCertResolver)?.trim() || globalSettings?.defaultTraefikCertResolver || "letsencrypt";
    const network = (grouped?.network ?? body.traefikNetwork)?.trim() || globalSettings?.defaultTraefikNetwork || "proxy";
    const service = normalizeOptionalName(grouped?.service ?? body.traefikService);
    const wildcardDomain = (grouped?.wildcardDomain ?? body.traefikWildcardDomain)?.trim();

    if (!/^[a-zA-Z0-9._,-]+$/.test(entryPoints)) {
        throw new Error("Traefik entry points can only contain letters, numbers, dots, underscores, hyphens, and commas.");
    }

    if (!/^[a-zA-Z0-9._-]+$/.test(certResolver)) {
        throw new Error("Traefik cert resolver can only contain letters, numbers, dots, underscores, and hyphens.");
    }

    if (!/^[a-zA-Z0-9._-]+$/.test(network)) {
        throw new Error("Traefik network can only contain letters, numbers, dots, underscores, and hyphens.");
    }

    const wildcardCertificate = grouped?.wildcardCertificate ?? body.traefikWildcardCertificate;
    if (wildcardCertificate && !wildcardDomain) {
        throw new Error("Wildcard certificate domain is required when wildcard certificates are enabled.");
    }

    if (wildcardDomain && !/^[a-zA-Z0-9.-]+$/.test(wildcardDomain)) {
        throw new Error("Wildcard certificate domain can only contain letters, numbers, dots, and hyphens.");
    }

    return {
        enabled: true,
        hostname,
        ...(service ? { service } : {}),
        port,
        entryPoints,
        certResolver,
        network,
        websocket: Boolean(grouped?.websocket ?? body.traefikWebsocket),
        wildcardCertificate: Boolean(wildcardCertificate),
        ...(wildcardDomain ? { wildcardDomain } : {}),
        removePublishedPorts: (grouped?.removePublishedPorts ?? body.traefikRemovePublishedPorts) !== false
    };
}
