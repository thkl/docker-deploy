import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { GlobalSettings, GlobalSettingsPayload } from "./types.js";

const defaultSettings: GlobalSettings = {
    dataRoot: "/root/docker-apps",
    defaultTraefikNetwork: "proxy",
    defaultTraefikEntryPoints: "websecure",
    defaultTraefikCertResolver: "letsencrypt",
    sshKeyPath: "~/.ssh",
    cleanupAfterDeploy: false
};

/**
 * JSON-backed global settings store.
 *
 * These settings describe controller-wide defaults such as the checkout root,
 * Traefik defaults, SSH key mount path, and cleanup behavior.
 */
export class GlobalSettingsStore {
    constructor(private readonly settingsPath = join("./data", "settings.json")) {}

    /**
     * Reads normalized global settings, falling back to defaults when the file
     * does not exist yet.
     */
    readSettings(): GlobalSettings {
        if (!existsSync(this.settingsPath)) {
            return defaultSettings;
        }

        const content = readFileSync(this.settingsPath, "utf8").trim();
        if (!content) {
            return defaultSettings;
        }

        const parsed = JSON.parse(content);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("Global settings must be an object.");
        }

        return normalizeGlobalSettings(parsed as GlobalSettingsPayload);
    }

    /**
     * Normalizes and persists global settings.
     */
    writeSettings(payload: GlobalSettingsPayload) {
        const settings = normalizeGlobalSettings(payload);
        mkdirSync(dirname(this.settingsPath), { recursive: true });
        writeFileSync(this.settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
        return settings;
    }
}

/**
 * Applies defaults and validation to a global settings payload.
 */
export function normalizeGlobalSettings(payload: GlobalSettingsPayload): GlobalSettings {
    const dataRoot = normalizeAbsolutePath(payload.dataRoot, "Data root") || defaultSettings.dataRoot;
    const sshKeyPath = payload.sshKeyPath?.trim() || defaultSettings.sshKeyPath;
    const defaultTraefikNetwork = normalizeName(payload.defaultTraefikNetwork, "Default Traefik network") || defaultSettings.defaultTraefikNetwork;
    const defaultTraefikEntryPoints = normalizeCsvNames(payload.defaultTraefikEntryPoints, "Default Traefik entry points") || defaultSettings.defaultTraefikEntryPoints;
    const defaultTraefikCertResolver = normalizeName(payload.defaultTraefikCertResolver, "Default Traefik cert resolver") || defaultSettings.defaultTraefikCertResolver;

    if (!sshKeyPath.startsWith("/") && !sshKeyPath.startsWith("~/")) {
        throw new Error("SSH key path must be an absolute path or start with ~/.");
    }

    return {
        dataRoot,
        defaultTraefikNetwork,
        defaultTraefikEntryPoints,
        defaultTraefikCertResolver,
        sshKeyPath,
        cleanupAfterDeploy: Boolean(payload.cleanupAfterDeploy)
    };
}

/**
 * Builds the default checkout path for a project on the target host.
 */
export function defaultProjectPath(settings: GlobalSettings, repoName: string) {
    return `${settings.dataRoot.replace(/\/+$/, "")}/${repoName}`;
}

/**
 * Normalizes an optional absolute path and removes trailing slashes.
 */
function normalizeAbsolutePath(value: string | undefined, label: string) {
    const trimmed = value?.trim();
    if (!trimmed) {
        return "";
    }

    if (!trimmed.startsWith("/")) {
        throw new Error(`${label} must be an absolute path.`);
    }

    return trimmed.replace(/\/+$/, "") || "/";
}

/**
 * Normalizes one Docker/Traefik-safe name.
 */
function normalizeName(value: string | undefined, label: string) {
    const trimmed = value?.trim();
    if (!trimmed) {
        return "";
    }

    if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) {
        throw new Error(`${label} can only contain letters, numbers, dots, underscores, and hyphens.`);
    }

    return trimmed;
}

/**
 * Normalizes a comma-separated list of Docker/Traefik-safe names.
 */
function normalizeCsvNames(value: string | undefined, label: string) {
    const trimmed = value?.trim();
    if (!trimmed) {
        return "";
    }

    if (!/^[a-zA-Z0-9._,-]+$/.test(trimmed)) {
        throw new Error(`${label} can only contain letters, numbers, dots, underscores, hyphens, and commas.`);
    }

    return trimmed;
}
