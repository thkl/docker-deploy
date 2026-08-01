import { Request } from "express";

export interface AuthenticatedRequest extends Request {
    rawBody?: Buffer;
}

export interface TraefikSettings {
    enabled: boolean;
    hostname?: string;
    service?: string;
    port?: number;
    entryPoints?: string;
    certResolver?: string;
    network?: string;
    websocket?: boolean;
    wildcardCertificate?: boolean;
    wildcardDomain?: string;
    removePublishedPorts?: boolean;
}

export interface ProjectSettings {
    id?: string;
    serverId?: string;
    token?: string;
    repositoryUrl?: string;
    deployToken?: string;
    path?: string;
    composeOverride?: string;
    envSecrets?: ProjectEnvironmentSecret[];
    traefik?: TraefikSettings;
}

export type ProjectConfig = Record<string, ProjectSettings>;

export type ProjectEnvironmentSecretMode = "docker_secret" | "env";

export interface ProjectEnvironmentSecret {
    service: string;
    key: string;
    value: string;
    mode: ProjectEnvironmentSecretMode;
}

export interface GlobalSettings {
    dataRoot: string;
    defaultTraefikNetwork: string;
    defaultTraefikEntryPoints: string;
    defaultTraefikCertResolver: string;
    sshKeyPath: string;
    cleanupAfterDeploy: boolean;
}

export interface GlobalSettingsPayload {
    dataRoot?: string;
    defaultTraefikNetwork?: string;
    defaultTraefikEntryPoints?: string;
    defaultTraefikCertResolver?: string;
    sshKeyPath?: string;
    cleanupAfterDeploy?: boolean;
}

export interface ProjectPayload {
    name?: string;
    serverId?: string;
    token?: string;
    repositoryUrl?: string;
    deployToken?: string;
    path?: string;
    composeOverride?: string;
    envSecrets?: ProjectEnvironmentSecret[];
    traefikEnabled?: boolean;
    traefikHostname?: string;
    traefikService?: string;
    traefikPort?: string | number;
    traefikEntryPoints?: string;
    traefikCertResolver?: string;
    traefikNetwork?: string;
    traefikWebsocket?: boolean;
    traefikWildcardCertificate?: boolean;
    traefikWildcardDomain?: string;
    traefikRemovePublishedPorts?: boolean;
}

export interface DeleteProjectPayload {
    confirmationName?: string;
    stopContainers?: boolean;
    deleteCheckout?: boolean;
    deleteDeploymentHistory?: boolean;
}

export type WebhookEventStatus = "dispatched" | "ignored" | "error";

export interface WebhookEventRecord {
    id: string;
    projectId?: string;
    projectName?: string;
    source: string;
    eventType?: string;
    status: WebhookEventStatus;
    reason: string;
    candidates: string[];
    deploymentId?: string;
    receivedAt: string;
}

export interface ServerRecord {
    id: string;
    name: string;
    kind: "local" | "remote";
    agentServerId?: string;
    baseUrl?: string;
    agentPublicEncryptionKey?: string;
    agentPublicSigningKey?: string;
    controllerPublicEncryptionKey?: string;
    controllerPublicSigningKey?: string;
    status?: "online" | "offline" | "unpaired";
    lastSeenAt?: string;
    pairedAt?: string;
    agentVersion?: string;
    activeJobs?: ServerActiveJob[];
    lastHealthError?: string;
    capabilities?: ServerCapabilities;
    createdAt: string;
    updatedAt: string;
}

export interface ServerPayload {
    id?: string;
    name?: string;
    agentServerId?: string;
    baseUrl?: string;
    agentPublicEncryptionKey?: string;
    agentPublicSigningKey?: string;
    pairingToken?: string;
    capabilities?: ServerCapabilities;
}

export interface ServerActiveJob {
    id: string;
    type: string;
    startedAt: string;
}

export interface ServerCapabilities {
    traefik: {
        available: boolean;
        containerCount: number;
        networkPresent: boolean;
        checkedAt: string;
        containers?: TraefikContainerInventory[];
        networks?: string[];
        entryPoints?: string[];
        certResolvers?: string[];
        dockerProviderNetwork?: string;
        acmeStorage?: string;
        staticConfigPaths?: string[];
        dynamicConfigPaths?: string[];
    };
    system?: ServerSystemMetrics;
}

export interface TraefikContainerInventory {
    id?: string;
    name?: string;
    image?: string;
    state?: string;
    ports?: string;
    networks: string[];
    mounts: Array<{
        source: string;
        target: string;
    }>;
    configArgs: string[];
}

export interface ServerSystemMetrics {
    checkedAt: string;
    loadAverage: number[];
    cpuCount: number;
    memory: {
        totalBytes: number;
        usedBytes: number;
        freeBytes: number;
    };
    disk?: {
        path: string;
        totalBytes: number;
        usedBytes: number;
        availableBytes: number;
        usedPercent: number;
    };
}

export type RuntimeProjectStatus = "running" | "partial" | "stopped" | "unknown" | "error";

export interface RuntimeServiceStatus {
    service: string;
    containerName?: string;
    containerId?: string;
    state: string;
    health?: string;
    image?: string;
    ports?: string;
    networkMode?: string;
    exposedPorts?: string[];
    networks?: string[];
}

export interface RuntimeStatus {
    status: RuntimeProjectStatus;
    checkedAt: string;
    services: RuntimeServiceStatus[];
    error?: string;
}

export interface RuntimeLogs {
    service: string;
    containerId: string;
    tail: number;
    checkedAt: string;
    output: string;
}

export type RuntimeServiceAction = "restart" | "start" | "stop" | "recreate" | "pull";

export interface RuntimeActionResult {
    service: string;
    action: RuntimeServiceAction;
    checkedAt: string;
    output: string;
}

export interface CheckoutBindMountReference {
    containerName?: string;
    containerId?: string;
    source: string;
    target: string;
}

export interface CheckoutBindMountInspection {
    checkoutPath: string;
    checkedAt: string;
    references: CheckoutBindMountReference[];
}

export type TraefikDiagnosticStatus = "pass" | "warn" | "fail";

export interface TraefikDiagnosticCheck {
    key: string;
    label: string;
    status: TraefikDiagnosticStatus;
    detail: string;
}

export interface TraefikDiagnostics {
    status: TraefikDiagnosticStatus;
    checkedAt: string;
    hostname?: string;
    service?: string;
    port?: number;
    network?: string;
    checks: TraefikDiagnosticCheck[];
    error?: string;
}

export interface ComposeInspection {
    composeFile: string;
    source: "repository" | "storedOverride";
    checkedAt: string;
    services: ComposeServiceInspection[];
    networks: ComposeResourceInspection[];
    volumes: ComposeResourceInspection[];
    unsafeRelativeBindMounts: number;
    storageMappings: ComposeStorageMapping[];
    storageOverridePreview?: string;
}

export interface ComposeServiceInspection {
    name: string;
    image?: string;
    build?: string;
    command?: string;
    restart?: string;
    ports: ComposePortInspection[];
    expose: string[];
    mounts: ComposeMountInspection[];
    networks: string[];
    dependsOn: string[];
    environmentKeys: string[];
}

export interface ComposePortInspection {
    target?: string;
    published?: string;
    protocol?: string;
    mode?: string;
    raw: string;
}

export interface ComposeMountInspection {
    type: string;
    source?: string;
    target?: string;
    readOnly: boolean;
    relative: boolean;
    safeForCleanup: boolean;
    raw: string;
}

export interface ComposeStorageMapping {
    service: string;
    source: string;
    target: string;
    readOnly: boolean;
    suggestedHostPath: string;
    suggestedMount: string;
}

export interface ComposeResourceInspection {
    name: string;
    external: boolean;
}

export interface ComposeValidation {
    valid: boolean;
    checkedAt: string;
    source: "repository" | "storedOverride";
    composeFile?: string;
    effectiveYaml?: string;
    warnings: string[];
    error?: string;
}
