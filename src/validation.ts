import { GlobalSettings, ProjectPayload, TraefikSettings } from "./types.js";

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

export function normalizeTraefikSettings(body: ProjectPayload, globalSettings?: GlobalSettings): TraefikSettings | undefined {
    if (!body.traefikEnabled) {
        return undefined;
    }

    const hostname = body.traefikHostname?.trim();
    if (!hostname) {
        throw new Error("Traefik hostname is required when Traefik is enabled.");
    }

    if (!/^[a-zA-Z0-9.-]+$/.test(hostname)) {
        throw new Error("Traefik hostname can only contain letters, numbers, dots, and hyphens.");
    }

    const port = Number(body.traefikPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("Traefik service port must be a number between 1 and 65535.");
    }

    const entryPoints = body.traefikEntryPoints?.trim() || globalSettings?.defaultTraefikEntryPoints || "websecure";
    const certResolver = body.traefikCertResolver?.trim() || globalSettings?.defaultTraefikCertResolver || "letsencrypt";
    const network = body.traefikNetwork?.trim() || globalSettings?.defaultTraefikNetwork || "proxy";
    const service = normalizeOptionalName(body.traefikService);
    const wildcardDomain = body.traefikWildcardDomain?.trim();

    if (!/^[a-zA-Z0-9._,-]+$/.test(entryPoints)) {
        throw new Error("Traefik entry points can only contain letters, numbers, dots, underscores, hyphens, and commas.");
    }

    if (!/^[a-zA-Z0-9._-]+$/.test(certResolver)) {
        throw new Error("Traefik cert resolver can only contain letters, numbers, dots, underscores, and hyphens.");
    }

    if (!/^[a-zA-Z0-9._-]+$/.test(network)) {
        throw new Error("Traefik network can only contain letters, numbers, dots, underscores, and hyphens.");
    }

    if (body.traefikWildcardCertificate && !wildcardDomain) {
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
        websocket: Boolean(body.traefikWebsocket),
        wildcardCertificate: Boolean(body.traefikWildcardCertificate),
        ...(wildcardDomain ? { wildcardDomain } : {}),
        removePublishedPorts: body.traefikRemovePublishedPorts !== false
    };
}
