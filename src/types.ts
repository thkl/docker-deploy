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

export interface ScaleToZeroSettings {
    enabled: boolean;
    services: string[];
    idleTimeoutSeconds: number;
    startupTimeoutSeconds: number;
    wakeAddress?: string;
    wakeToken?: string;
}

export type DeploymentStrategy = "compose" | "swarm";

export interface ProjectSettings {
    id?: string;
    serverId?: string;
    serverIds?: string[];
    token?: string;
    repositoryUrl?: string;
    deployToken?: string;
    path?: string;
    envFilePath?: string;
    deploymentOnHold?: boolean;
    composeOverride?: string;
    envSecrets?: ProjectEnvironmentSecret[];
    deploymentStrategy?: DeploymentStrategy;
    scaleToZero?: ScaleToZeroSettings;
    registry?: ProjectRegistrySettings;
    notifications?: ProjectNotificationSettings;
    traefik?: TraefikSettings;
}

export type ProjectConfig = Record<string, ProjectSettings>;

export type ProjectEnvironmentSecretMode = "docker_secret" | "env";
export type ProjectEnvironmentSecretSource = "inline" | "vault";
export type ProjectEnvironmentSecretExposure = "file" | "env";

export interface ProjectEnvironmentSecret {
    service: string;
    key: string;
    value?: string;
    mode: ProjectEnvironmentSecretMode;
    source?: ProjectEnvironmentSecretSource;
    vaultSecretId?: string;
    exposure?: ProjectEnvironmentSecretExposure;
    helperCommand?: string;
}

export interface VaultSecret {
    id: string;
    namespace: string;
    key: string;
    description?: string;
    value?: string;
    createdAt: string;
    updatedAt: string;
    referencedByProjects?: string[];
}

export interface VaultSecretPayload {
    namespace?: string;
    key?: string;
    description?: string;
    value?: string;
}

export interface GlobalSettings {
    dataRoot: string;
    updaterInternalUrl: string;
    defaultTraefikNetwork: string;
    defaultTraefikEntryPoints: string;
    defaultTraefikCertResolver: string;
    traefikDomains: string[];
    sshKeyPath: string;
    cleanupAfterDeploy: boolean;
    autoBackupEnabled: boolean;
    autoBackupCron: string;
    autoBackupPath: string;
    registryAddress: string;
    registryUsername: string;
    registryPassword?: string;
    releaseSnapshotLimit: number;
    notifications: NotificationSettings;
}

export interface GlobalSettingsPayload {
    dataRoot?: string;
    updaterInternalUrl?: string;
    defaultTraefikNetwork?: string;
    defaultTraefikEntryPoints?: string;
    defaultTraefikCertResolver?: string;
    traefikDomains?: string[];
    sshKeyPath?: string;
    cleanupAfterDeploy?: boolean;
    autoBackupEnabled?: boolean;
    autoBackupCron?: string;
    autoBackupPath?: string;
    registryAddress?: string;
    registryUsername?: string;
    registryPassword?: string;
    releaseSnapshotLimit?: number;
    notifications?: NotificationSettingsPayload;
}

export type NotificationEventType = "deployment.started" | "deployment.succeeded" | "deployment.failed" | "service.down";
export type NotificationChannelType = "slack" | "pushover" | "email";

export interface NotificationEventSettings {
    deploymentStarted: boolean;
    deploymentSucceeded: boolean;
    deploymentFailed: boolean;
    serviceDown: boolean;
}

export interface NotificationChannelSettings {
    id: string;
    type: NotificationChannelType;
    name: string;
    enabled: boolean;
    slackWebhookUrl?: string;
    pushoverToken?: string;
    pushoverUser?: string;
    emailTo?: string;
    emailFrom?: string;
    smtpHost?: string;
    smtpPort?: number;
    smtpSecure?: boolean;
    smtpUsername?: string;
    smtpPassword?: string;
}

export interface NotificationSettings {
    enabled: boolean;
    healthPollingEnabled: boolean;
    healthPollingIntervalSeconds: number;
    events: NotificationEventSettings;
    channels: NotificationChannelSettings[];
}

export interface NotificationSettingsPayload {
    enabled?: boolean;
    healthPollingEnabled?: boolean;
    healthPollingIntervalSeconds?: number;
    events?: Partial<NotificationEventSettings>;
    channels?: Partial<NotificationChannelSettings>[];
}

export type NotificationDeliveryStatus = "sent" | "failed" | "skipped";

export interface NotificationDeliveryRecord {
    id: string;
    event: NotificationEventType;
    deploymentId?: string;
    channelId?: string;
    channelName?: string;
    channelType?: NotificationChannelType;
    projectId?: string;
    projectName?: string;
    service?: string;
    title: string;
    body: string;
    status: NotificationDeliveryStatus;
    error?: string;
    dedupeKey?: string;
    createdAt: string;
}

export interface ProjectRegistrySettings {
    publish: boolean;
    deployFromRegistry: boolean;
    imageNamespace?: string;
    imageTag?: string;
}

export interface ProjectNotificationSettings {
    useGlobal: boolean;
    enabled: boolean;
    channelIds: string[];
    events: NotificationEventSettings;
}

export interface ReleaseSnapshotImage {
    service: string;
    image: string;
}

export interface ProjectReleaseSnapshot {
    id: string;
    projectId?: string;
    projectName: string;
    deploymentId: string;
    runId?: string;
    serverId: string;
    composeProjectName: string;
    projectPath: string;
    deploymentStrategy: DeploymentStrategy;
    composeYaml: string;
    gitSha?: string;
    images: ReleaseSnapshotImage[];
    buildServices: string[];
    sourceCheckoutRequired?: boolean;
    createdAt: string;
    rollbackAvailable: boolean;
    rollbackUnavailableReason?: string;
}

export interface CapturedReleaseSnapshot {
    serverId: string;
    composeProjectName: string;
    projectPath: string;
    deploymentStrategy: DeploymentStrategy;
    composeYaml: string;
    gitSha?: string;
    images: ReleaseSnapshotImage[];
    buildServices: string[];
    sourceCheckoutRequired?: boolean;
}

export type ProjectPreflightStatus = "pass" | "warn" | "fail";

export interface ProjectPreflightCheck {
    key: string;
    label: string;
    status: ProjectPreflightStatus;
    detail: string;
    description?: string;
    recommendation?: string;
    target?: string;
}

export interface ProjectPreflightTarget {
    serverId: string;
    status: ProjectPreflightStatus;
    checks: ProjectPreflightCheck[];
}

export interface ProjectPreflightResult {
    projectId?: string;
    projectName: string;
    checkedAt: string;
    status: ProjectPreflightStatus;
    checks: ProjectPreflightCheck[];
    targets: ProjectPreflightTarget[];
}

export interface RegistryLoginCheck {
    checkedAt: string;
    ok: boolean;
    skipped: boolean;
    detail: string;
}

export interface TraefikDefaultsPayload {
    network?: string;
    entryPoints?: string;
    certResolver?: string;
    acmeEmail?: string;
    acmeStorage?: string;
    wildcardDomain?: string;
    applyToServer?: boolean;
}

export interface PathBrowseEntry {
    name: string;
    path: string;
    type: "directory" | "file";
    writable?: boolean;
    size?: number;
}

export interface PathBrowseResult {
    path: string;
    parent: string;
    entries: PathBrowseEntry[];
}

export interface ProjectPayload {
    name?: string;
    serverId?: string;
    serverIds?: string[];
    token?: string;
    repositoryUrl?: string;
    deployToken?: string;
    path?: string;
    envFilePath?: string;
    deploymentOnHold?: boolean;
    composeOverride?: string;
    envSecrets?: ProjectEnvironmentSecret[];
    deploymentStrategy?: DeploymentStrategy;
    scaleToZero?: Partial<ScaleToZeroSettings>;
    registryPublish?: boolean;
    registryDeployFromRegistry?: boolean;
    registryImageNamespace?: string;
    registryImageTag?: string;
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
    project?: {
        name?: string;
        serverId?: string;
        serverIds?: string[];
        path?: string;
    };
    git?: {
        repositoryUrl?: string;
        token?: string;
    };
    deployment?: {
        deployToken?: string;
        strategy?: DeploymentStrategy;
        deploymentStrategy?: DeploymentStrategy;
        onHold?: boolean;
    };
    registry?: Partial<ProjectRegistrySettings>;
    notifications?: Partial<ProjectNotificationSettings>;
    compose?: {
        override?: string;
        envFilePath?: string;
        envSecrets?: ProjectEnvironmentSecret[];
    };
    traefik?: Partial<TraefikSettings> & {
        port?: string | number;
    };
}

export interface DeleteProjectPayload {
    confirmationName?: string;
    stopContainers?: boolean;
    deleteVolumes?: boolean;
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
    docker: DockerTopology;
    traefik: {
        available: boolean;
        containerCount: number;
        networkPresent: boolean;
        checkedAt: string;
        providerMode?: "docker" | "swarm" | "mixed" | "unknown";
        containers?: TraefikContainerInventory[];
        networks?: string[];
        networkDetails?: DockerNetworkInventory[];
        entryPoints?: string[];
        certResolvers?: string[];
        dockerProviderNetwork?: string;
        acmeStorage?: string;
        staticConfigPaths?: string[];
        dynamicConfigPaths?: string[];
    };
    system?: ServerSystemMetrics;
}

export interface DockerTopology {
    checkedAt: string;
    available: boolean;
    mode: "standalone" | "swarm-manager" | "swarm-worker" | "swarm-inactive" | "unknown";
    swarmLocalNodeState?: string;
    swarmControlAvailable?: boolean;
    nodeId?: string;
    error?: string;
}

export interface DockerNetworkInventory {
    id?: string;
    name: string;
    driver?: string;
    scope?: string;
    attachable?: boolean;
    ingress?: boolean;
}

export interface TraefikContainerInventory {
    kind?: "container" | "service";
    id?: string;
    name?: string;
    image?: string;
    state?: string;
    replicas?: string;
    ports?: string;
    networks: string[];
    mounts: Array<{
        source: string;
        target: string;
    }>;
    configArgs: string[];
}

export interface TraefikConfigBackup {
    serverId: string;
    createdAt: string;
    inventory: ServerCapabilities["traefik"];
    files: TraefikConfigBackupFile[];
}

export interface TraefikConfigBackupFile {
    containerId?: string;
    containerName?: string;
    source: string;
    mountTarget?: string;
    path: string;
    kind: "static" | "dynamic" | "other";
    content: string;
    truncated: boolean;
    error?: string;
}

export interface TraefikConfigValidation {
    serverId: string;
    checkedAt: string;
    status: TraefikDiagnosticStatus;
    inventory: ServerCapabilities["traefik"];
    checks: TraefikConfigValidationCheck[];
}

export interface TraefikConfigValidationCheck {
    key: string;
    label: string;
    status: TraefikDiagnosticStatus;
    detail: string;
    output?: string;
}

export interface TraefikConfigApplyResult {
    serverId: string;
    appliedAt: string;
    changed: boolean;
    target?: {
        containerId?: string;
        containerName?: string;
        source: string;
        path: string;
        kind: "static" | "dynamic" | "other";
    };
    backup?: TraefikConfigBackupFile;
    validation: TraefikConfigValidation;
    actions: string[];
}

export interface TraefikImpactPreview {
    serverId: string;
    checkedAt: string;
    defaults: {
        network: string;
        entryPoints: string;
        certResolver: string;
    };
    projectCount: number;
    projects: TraefikAffectedProject[];
}

export interface TraefikAffectedProject {
    id?: string;
    name: string;
    hostname?: string;
    service?: string;
    port?: number;
    network: string;
    entryPoints: string;
    certResolver: string;
    wildcardDomain?: string;
    usesDefaultNetwork: boolean;
    usesDefaultEntryPoints: boolean;
    usesDefaultCertResolver: boolean;
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
    scaleToZero?: ScaleToZeroRuntimeStatus;
    error?: string;
}

export type ScaleToZeroRuntimeState = "running" | "idle" | "suspended" | "waking" | "error";

export interface ScaleToZeroRuntimeStatus {
    state: ScaleToZeroRuntimeState;
    checkedAt: string;
    idleSince?: string;
    lastRequestAt?: string;
    suspendedSince?: string;
    lastWakeAt?: string;
    error?: string;
}

export interface RuntimeLogs {
    service: string;
    containerId: string;
    tail: number;
    checkedAt: string;
    output: string;
}

export interface ContainerRecord {
    id: string;
    name: string;
    image: string;
    state: string;
    health?: string;
    healthDetails?: string;
    restartCount: number;
    createdAt: string;
    startedAt?: string;
    ports?: string;
    composeProject?: string;
    composeService?: string;
    cpuPercent?: number;
    memoryUsage?: string;
    memoryPercent?: number;
    networkIo?: string;
    blockIo?: string;
    processCount?: number;
}

export interface ContainerStatsSample {
    id: string;
    name: string;
    checkedAt: string;
    cpuPercent?: number;
    memoryUsage?: string;
    memoryPercent?: number;
    networkIo?: string;
    blockIo?: string;
    processCount?: number;
}

export interface ContainerInventory {
    checkedAt: string;
    containers: ContainerRecord[];
}

export interface ContainerLogs {
    containerId: string;
    tail: number;
    checkedAt: string;
    output: string;
}

export type RuntimeServiceAction = "restart" | "start" | "stop" | "pause" | "unpause" | "recreate" | "pull";

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
