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
    traefik?: TraefikSettings;
}

export type ProjectConfig = Record<string, ProjectSettings>;

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

export interface ServerRecord {
    id: string;
    name: string;
    kind: "local" | "remote";
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
