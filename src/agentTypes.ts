import { CheckoutCleanupResult } from "./checkoutCleanup.js";
import { ImportedCompose } from "./composeImport.js";
import { DeploymentHooks, RuntimeLogHooks, RuntimeLogStream } from "./deploy.js";
import { CapturedReleaseSnapshot, CheckoutBindMountInspection, ComposeInspection, ComposeValidation, ContainerInventory, ContainerLogs, DockerTopology, GlobalSettings, PathBrowseResult, ProjectReleaseSnapshot, ProjectSettings, RegistryLoginCheck, RuntimeActionResult, RuntimeLogs, RuntimeServiceAction, RuntimeStatus, ServerCapabilities, TraefikConfigApplyResult, TraefikConfigBackup, TraefikConfigValidation, TraefikDefaultsPayload, TraefikDiagnostics } from "./types.js";

export type AgentJobType = "deploy" | "deployReleaseSnapshot" | "captureReleaseSnapshot" | "importCompose" | "inspectCompose" | "validateCompose" | "stop" | "deleteCheckout" | "inspectCheckoutBindMounts" | "inspectDocker" | "testRegistry" | "browsePath" | "detectTraefik" | "backupTraefik" | "validateTraefik" | "applyTraefikDefaults" | "diagnoseTraefik" | "inspectStatus" | "runtimeLogs" | "runtimeLogsFollow" | "inspectContainers" | "containerLogs" | "containerLogsFollow" | "containerStatsFollow" | "runtimeAction" | "runtimeActionFollow";

export interface DeployJobPayload {
    projectName: string;
    appSettings: ProjectSettings;
    globalSettings: GlobalSettings;
}

export interface ImportComposeJobPayload extends DeployJobPayload {}

export interface InspectComposeJobPayload extends DeployJobPayload {}

export interface ValidateComposeJobPayload extends DeployJobPayload {}

export interface StopJobPayload extends DeployJobPayload {
    deleteVolumes?: boolean;
    removeStack?: boolean;
}

export interface InspectStatusJobPayload extends DeployJobPayload {}

export interface RuntimeLogsJobPayload extends DeployJobPayload {
    service: string;
    tail: number;
}

export interface InspectContainersJobPayload {}

export interface ContainerLogsJobPayload {
    containerId: string;
    tail: number;
}

export interface RuntimeActionJobPayload extends DeployJobPayload {
    service: string;
    action: RuntimeServiceAction;
}

export interface DeleteCheckoutJobPayload {
    checkoutPath: string;
}

export interface InspectCheckoutBindMountsJobPayload {
    checkoutPath: string;
}

export interface BrowsePathJobPayload {
    path: string;
}

export interface ReleaseSnapshotJobPayload {
    release: ProjectReleaseSnapshot;
    globalSettings: GlobalSettings;
}

export interface DetectTraefikJobPayload {
    serverId?: string;
    globalSettings: GlobalSettings;
}

export interface TestRegistryJobPayload {
    globalSettings: GlobalSettings;
}

export interface ApplyTraefikDefaultsJobPayload extends DetectTraefikJobPayload {
    defaults: TraefikDefaultsPayload;
}

export interface DiagnoseTraefikJobPayload extends DeployJobPayload {}

export interface AgentJobRequest {
    jobType: AgentJobType;
    payload: DeployJobPayload | ReleaseSnapshotJobPayload | ImportComposeJobPayload | InspectComposeJobPayload | ValidateComposeJobPayload | StopJobPayload | InspectStatusJobPayload | RuntimeLogsJobPayload | InspectContainersJobPayload | ContainerLogsJobPayload | RuntimeActionJobPayload | DeleteCheckoutJobPayload | InspectCheckoutBindMountsJobPayload | BrowsePathJobPayload | DetectTraefikJobPayload | TestRegistryJobPayload | ApplyTraefikDefaultsJobPayload | DiagnoseTraefikJobPayload;
}

export interface AgentJobAccepted {
    jobId: string;
    streamToken: string;
    status: "accepted";
}

export interface AgentLogFrame {
    stream: "stdout" | "stderr" | "status";
    chunk: string;
    done?: boolean;
    success?: boolean;
    error?: string;
}

export interface AgentClient {
    deployProject(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings, hooks?: DeploymentHooks): RuntimeLogStream | Promise<RuntimeLogStream | void> | void;
    deployReleaseSnapshot(release: ProjectReleaseSnapshot, globalSettings: GlobalSettings, hooks?: DeploymentHooks): RuntimeLogStream | Promise<RuntimeLogStream | void> | void;
    captureReleaseSnapshot(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings): Promise<CapturedReleaseSnapshot>;
    reconnectDeploymentLog?(jobId: string, streamToken: string, hooks?: DeploymentHooks): RuntimeLogStream;
    stopProject(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings, options?: { deleteVolumes?: boolean; removeStack?: boolean }): Promise<string>;
    importCompose(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings): Promise<ImportedCompose>;
    inspectCompose(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings): Promise<ComposeInspection>;
    validateCompose(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings): Promise<ComposeValidation>;
    deleteCheckout(checkoutPath: string): Promise<CheckoutCleanupResult>;
    inspectCheckoutBindMounts(checkoutPath: string): Promise<CheckoutBindMountInspection>;
    inspectDocker(): Promise<DockerTopology>;
    testRegistry(globalSettings: GlobalSettings): Promise<RegistryLoginCheck>;
    browsePath(path: string): Promise<PathBrowseResult>;
    detectTraefik(globalSettings: GlobalSettings): Promise<ServerCapabilities["traefik"]>;
    backupTraefik(serverId: string, globalSettings: GlobalSettings): Promise<TraefikConfigBackup>;
    validateTraefik(serverId: string, globalSettings: GlobalSettings): Promise<TraefikConfigValidation>;
    applyTraefikDefaults(serverId: string, globalSettings: GlobalSettings, defaults: TraefikDefaultsPayload): Promise<TraefikConfigApplyResult>;
    diagnoseTraefik(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings): Promise<TraefikDiagnostics>;
    inspectStatus(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings): Promise<RuntimeStatus>;
    runtimeLogs(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings, service: string, tail: number): Promise<RuntimeLogs>;
    followRuntimeLogs(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings, service: string, tail: number, hooks?: RuntimeLogHooks): Promise<RuntimeLogStream>;
    inspectContainers(): Promise<ContainerInventory>;
    followContainerStats(hooks?: RuntimeLogHooks): Promise<RuntimeLogStream>;
    containerLogs(containerId: string, tail: number): Promise<ContainerLogs>;
    followContainerLogs(containerId: string, tail: number, hooks?: RuntimeLogHooks): Promise<RuntimeLogStream>;
    runtimeAction(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings, service: string, action: RuntimeServiceAction): Promise<RuntimeActionResult>;
    followRuntimeAction(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings, service: string, action: RuntimeServiceAction, hooks?: RuntimeLogHooks): Promise<RuntimeLogStream> | RuntimeLogStream;
}
