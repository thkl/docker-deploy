import { AppDatabase, runDatabaseTransaction } from "./database.js";
import { isValidCronExpression } from "./configAutoBackup.js";
import { decryptSecret, encryptSecret } from "./secretStore.js";
import { GlobalSettings, GlobalSettingsPayload, NotificationChannelSettings, NotificationSettings } from "./types.js";

export const defaultGlobalSettings: GlobalSettings = {
    dataRoot: "/root/docker-apps",
    defaultTraefikNetwork: "proxy",
    defaultTraefikEntryPoints: "websecure",
    defaultTraefikCertResolver: "letsencrypt",
    sshKeyPath: "~/.ssh",
    cleanupAfterDeploy: false,
    autoBackupEnabled: false,
    autoBackupCron: "0 3 * * *",
    autoBackupPath: "/root/docker-apps/.updater/backups",
    registryAddress: "",
    registryUsername: "",
    registryPassword: "",
    releaseSnapshotLimit: 20,
    notifications: {
        enabled: false,
        healthPollingEnabled: true,
        healthPollingIntervalSeconds: 60,
        events: {
            deploymentStarted: true,
            deploymentSucceeded: true,
            deploymentFailed: true,
            serviceDown: true
        },
        channels: []
    }
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

        return normalizeGlobalSettings({
            ...defaultGlobalSettings,
            ...stored,
            registryPassword: decryptSecret(stored.registryPassword) ?? "",
            notifications: decryptNotificationSecrets(normalizeNotificationSettings(stored.notifications ?? defaultGlobalSettings.notifications))
        });
    }

    /**
     * Normalizes and persists global settings.
     */
    writeSettings(payload: GlobalSettingsPayload) {
        const existing = this.readSettings();
        const settings = normalizeGlobalSettings({
            ...payload,
            registryPassword: shouldKeepExistingSecret(payload.registryPassword) ? existing.registryPassword : payload.registryPassword,
            notifications: mergeNotificationSecretPlaceholders(payload.notifications, existing.notifications)
        });
        runDatabaseTransaction(this.database, () => {
            for (const [key, value] of Object.entries(settings)) {
                const storedValue = key === "registryPassword"
                    ? encryptSecret(String(value || ""))
                    : key === "notifications"
                        ? encryptNotificationSecrets(value as NotificationSettings)
                        : value;
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
    const autoBackupCron = payload.autoBackupCron?.trim() || defaultGlobalSettings.autoBackupCron;
    const autoBackupPath = normalizeAbsolutePath(payload.autoBackupPath, "Auto backup path") || defaultGlobalSettings.autoBackupPath;
    const registryAddress = normalizeRegistryAddress(payload.registryAddress);
    const registryUsername = payload.registryUsername?.trim() ?? "";
    const registryPassword = shouldKeepExistingSecret(payload.registryPassword) ? "" : payload.registryPassword?.trim() ?? "";
    const releaseSnapshotLimit = normalizeRetentionLimit(payload.releaseSnapshotLimit, defaultGlobalSettings.releaseSnapshotLimit, "Release snapshot limit");
    const notifications = normalizeNotificationSettings(payload.notifications);

    if (!sshKeyPath.startsWith("/") && !sshKeyPath.startsWith("~/")) {
        throw new Error("SSH key path must be an absolute path or start with ~/.");
    }

    if (!isValidCronExpression(autoBackupCron)) {
        throw new Error("Auto backup cron must be a five-field cron expression.");
    }

    return {
        dataRoot,
        defaultTraefikNetwork,
        defaultTraefikEntryPoints,
        defaultTraefikCertResolver,
        sshKeyPath,
        cleanupAfterDeploy: Boolean(payload.cleanupAfterDeploy),
        autoBackupEnabled: Boolean(payload.autoBackupEnabled),
        autoBackupCron,
        autoBackupPath,
        registryAddress,
        registryUsername,
        registryPassword,
        releaseSnapshotLimit,
        notifications
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

function normalizeRetentionLimit(value: number | undefined, fallback: number, label: string) {
    const parsed = Number(value ?? fallback);
    if (!Number.isFinite(parsed)) {
        throw new Error(`${label} must be a number.`);
    }
    const normalized = Math.trunc(parsed);
    if (normalized < 1 || normalized > 200) {
        throw new Error(`${label} must be between 1 and 200.`);
    }
    return normalized;
}

function normalizeNotificationSettings(payload: GlobalSettingsPayload["notifications"]): NotificationSettings {
    const events = payload?.events ?? {};
    const interval = Number(payload?.healthPollingIntervalSeconds ?? 60);
    return {
        enabled: Boolean(payload?.enabled),
        healthPollingEnabled: payload?.healthPollingEnabled !== false,
        healthPollingIntervalSeconds: Number.isFinite(interval) ? Math.max(15, Math.min(Math.round(interval), 3600)) : 60,
        events: {
            deploymentStarted: events.deploymentStarted !== false,
            deploymentSucceeded: events.deploymentSucceeded !== false,
            deploymentFailed: events.deploymentFailed !== false,
            serviceDown: events.serviceDown !== false
        },
        channels: (payload?.channels ?? []).map((channel, index) => normalizeNotificationChannel(channel, index))
    };
}

function normalizeNotificationChannel(channel: Partial<NotificationChannelSettings>, index: number): NotificationChannelSettings {
    const type = channel.type === "pushover" || channel.type === "email" ? channel.type : "slack";
    const smtpPort = Number(channel.smtpPort || (channel.smtpSecure ? 465 : 587));
    return {
        id: channel.id?.trim() || `notification-${index + 1}`,
        type,
        name: channel.name?.trim() || defaultNotificationChannelName(type, index),
        enabled: channel.enabled !== false,
        slackWebhookUrl: channel.slackWebhookUrl?.trim() ?? "",
        pushoverToken: channel.pushoverToken?.trim() ?? "",
        pushoverUser: channel.pushoverUser?.trim() ?? "",
        emailTo: channel.emailTo?.trim() ?? "",
        emailFrom: channel.emailFrom?.trim() ?? "",
        smtpHost: channel.smtpHost?.trim() ?? "",
        smtpPort: Number.isFinite(smtpPort) ? smtpPort : 587,
        smtpSecure: Boolean(channel.smtpSecure),
        smtpUsername: channel.smtpUsername?.trim() ?? "",
        smtpPassword: channel.smtpPassword?.trim() ?? ""
    };
}

function defaultNotificationChannelName(type: NotificationChannelSettings["type"], index: number) {
    const label = type === "slack" ? "Slack" : type === "pushover" ? "Pushover" : "Email";
    return `${label} ${index + 1}`;
}

function mergeNotificationSecretPlaceholders(payload: GlobalSettingsPayload["notifications"], existing: NotificationSettings) {
    if (!payload) {
        return existing;
    }

    const existingById = new Map(existing.channels.map((channel) => [channel.id, channel]));
    return {
        ...payload,
        channels: (payload.channels ?? []).map((channel) => {
            const existingChannel = channel.id ? existingById.get(channel.id) : undefined;
            return {
                ...channel,
                slackWebhookUrl: shouldKeepExistingSecret(channel.slackWebhookUrl) ? existingChannel?.slackWebhookUrl ?? "" : channel.slackWebhookUrl,
                pushoverToken: shouldKeepExistingSecret(channel.pushoverToken) ? existingChannel?.pushoverToken ?? "" : channel.pushoverToken,
                pushoverUser: shouldKeepExistingSecret(channel.pushoverUser) ? existingChannel?.pushoverUser ?? "" : channel.pushoverUser,
                smtpPassword: shouldKeepExistingSecret(channel.smtpPassword) ? existingChannel?.smtpPassword ?? "" : channel.smtpPassword
            };
        })
    };
}

function encryptNotificationSecrets(settings: NotificationSettings) {
    return {
        ...settings,
        channels: settings.channels.map((channel) => ({
            ...channel,
            slackWebhookUrl: encryptSecret(channel.slackWebhookUrl) ?? "",
            pushoverToken: encryptSecret(channel.pushoverToken) ?? "",
            pushoverUser: encryptSecret(channel.pushoverUser) ?? "",
            smtpPassword: encryptSecret(channel.smtpPassword) ?? ""
        }))
    };
}

function decryptNotificationSecrets(settings: NotificationSettings) {
    return {
        ...defaultGlobalSettings.notifications,
        ...settings,
        channels: (settings.channels ?? []).map((channel) => ({
            ...channel,
            slackWebhookUrl: decryptSecret(channel.slackWebhookUrl) ?? "",
            pushoverToken: decryptSecret(channel.pushoverToken) ?? "",
            pushoverUser: decryptSecret(channel.pushoverUser) ?? "",
            smtpPassword: decryptSecret(channel.smtpPassword) ?? ""
        }))
    };
}
