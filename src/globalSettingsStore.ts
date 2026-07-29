import { AppDatabase, runDatabaseTransaction } from "./database.js";
import { GlobalSettings, GlobalSettingsPayload } from "./types.js";

export const defaultGlobalSettings: GlobalSettings = {
    dataRoot: "/root/docker-apps",
    defaultTraefikNetwork: "proxy",
    defaultTraefikEntryPoints: "websecure",
    defaultTraefikCertResolver: "letsencrypt",
    sshKeyPath: "~/.ssh",
    cleanupAfterDeploy: false
};

/**
 * SQLite-backed global settings store.
 *
 * These settings describe controller-wide defaults such as the checkout root,
 * Traefik defaults, SSH key mount path, and cleanup behavior.
 */
export class GlobalSettingsStore {
    constructor(private readonly database = new AppDatabase().connection) {}

    /**
     * Reads normalized global settings, falling back to defaults when the file
     * does not exist yet.
     */
    readSettings(): GlobalSettings {
        const rows = this.database.prepare("SELECT key, value FROM settings").all() as unknown as Array<{ key: keyof GlobalSettings; value: string }>;
        const stored = rows.reduce<GlobalSettingsPayload>((settings, row) => {
            settings[row.key] = JSON.parse(row.value);
            return settings;
        }, {});

        return normalizeGlobalSettings({ ...defaultGlobalSettings, ...stored });
    }

    /**
     * Normalizes and persists global settings.
     */
    writeSettings(payload: GlobalSettingsPayload) {
        const settings = normalizeGlobalSettings(payload);
        runDatabaseTransaction(this.database, () => {
            for (const [key, value] of Object.entries(settings)) {
                this.database.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, JSON.stringify(value));
            }
        });
        return settings;
    }
}

/**
 * Applies defaults and validation to a global settings payload.
 */
export function normalizeGlobalSettings(payload: GlobalSettingsPayload): GlobalSettings {
    const dataRoot = normalizeAbsolutePath(payload.dataRoot, "Data root") || defaultGlobalSettings.dataRoot;
    const sshKeyPath = payload.sshKeyPath?.trim() || defaultGlobalSettings.sshKeyPath;
    const defaultTraefikNetwork = normalizeName(payload.defaultTraefikNetwork, "Default Traefik network") || defaultGlobalSettings.defaultTraefikNetwork;
    const defaultTraefikEntryPoints = normalizeCsvNames(payload.defaultTraefikEntryPoints, "Default Traefik entry points") || defaultGlobalSettings.defaultTraefikEntryPoints;
    const defaultTraefikCertResolver = normalizeName(payload.defaultTraefikCertResolver, "Default Traefik cert resolver") || defaultGlobalSettings.defaultTraefikCertResolver;

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
