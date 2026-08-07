import { AppDatabase, runDatabaseTransaction } from "./database.js";
import { decryptSecret, encryptSecret } from "./secretStore.js";
import { GlobalSettings, GlobalSettingsPayload } from "./types.js";

export const defaultGlobalSettings: GlobalSettings = {
    dataRoot: "/root/docker-apps",
    defaultTraefikNetwork: "proxy",
    defaultTraefikEntryPoints: "websecure",
    defaultTraefikCertResolver: "letsencrypt",
    sshKeyPath: "~/.ssh",
    cleanupAfterDeploy: false,
    registryAddress: "",
    registryUsername: "",
    registryPassword: ""
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

        return normalizeGlobalSettings({ ...defaultGlobalSettings, ...stored, registryPassword: decryptSecret(stored.registryPassword) ?? "" });
    }

    /**
     * Normalizes and persists global settings.
     */
    writeSettings(payload: GlobalSettingsPayload) {
        const existing = this.readSettings();
        const settings = normalizeGlobalSettings({
            ...payload,
            registryPassword: shouldKeepExistingSecret(payload.registryPassword) ? existing.registryPassword : payload.registryPassword
        });
        runDatabaseTransaction(this.database, () => {
            for (const [key, value] of Object.entries(settings)) {
                const storedValue = key === "registryPassword" ? encryptSecret(String(value || "")) : value;
                this.database.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, JSON.stringify(storedValue));
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
    const registryAddress = normalizeRegistryAddress(payload.registryAddress);
    const registryUsername = payload.registryUsername?.trim() ?? "";
    const registryPassword = shouldKeepExistingSecret(payload.registryPassword) ? "" : payload.registryPassword?.trim() ?? "";

    if (!sshKeyPath.startsWith("/") && !sshKeyPath.startsWith("~/")) {
        throw new Error("SSH key path must be an absolute path or start with ~/.");
    }

    return {
        dataRoot,
        defaultTraefikNetwork,
        defaultTraefikEntryPoints,
        defaultTraefikCertResolver,
        sshKeyPath,
        cleanupAfterDeploy: Boolean(payload.cleanupAfterDeploy),
        registryAddress,
        registryUsername,
        registryPassword
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

function normalizeRegistryAddress(value: string | undefined) {
    const trimmed = value?.trim();
    if (!trimmed) {
        return "";
    }

    if (/^https?:\/\//i.test(trimmed)) {
        throw new Error("Registry address should not include http:// or https://.");
    }

    if (!/^[a-zA-Z0-9._:-]+(?:\/[a-zA-Z0-9._-]+)*$/.test(trimmed)) {
        throw new Error("Registry address can only contain host, port, and optional path characters.");
    }

    return trimmed.replace(/\/+$/, "");
}

function shouldKeepExistingSecret(value: string | undefined) {
    const trimmed = value?.trim();
    return !trimmed || /^\*+$/.test(trimmed) || /^[^*]+?\.\.\.[^*]+$/.test(trimmed);
}
