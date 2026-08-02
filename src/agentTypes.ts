import { CheckoutCleanupResult } from "./checkoutCleanup.js";
import { ImportedCompose } from "./composeImport.js";
import { DeploymentHooks, RuntimeLogHooks, RuntimeLogStream } from "./deploy.js";
import { CheckoutBindMountInspection, ComposeInspection, ComposeValidation, GlobalSettings, ProjectSettings, RuntimeActionResult, RuntimeLogs, RuntimeServiceAction, RuntimeStatus, ServerCapabilities, TraefikConfigBackup, TraefikConfigValidation, TraefikDiagnostics } from "./types.js";

export type AgentJobType = "deploy" | "importCompose" | "inspectCompose" | "validateCompose" | "stop" | "deleteCheckout" | "inspectCheckoutBindMounts" | "detectTraefik" | "backupTraefik" | "validateTraefik" | "diagnoseTraefik" | "inspectStatus" | "runtimeLogs" | "runtimeLogsFollow" | "runtimeAction" | "runtimeActionFollow";

export interface DeployJobPayload {
    projectName: string;
    appSettings: ProjectSettings;
    globalSettings: GlobalSettings;
}

export interface ImportComposeJobPayload extends DeployJobPayload {}

export interface InspectComposeJobPayload extends DeployJobPayload {}

export interface ValidateComposeJobPayload extends DeployJobPayload {}

export interface StopJobPayload extends DeployJobPayload {}

export interface InspectStatusJobPayload extends DeployJobPayload {}

export interface RuntimeLogsJobPayload extends DeployJobPayload {
    service: string;
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

export interface DetectTraefikJobPayload {
    serverId?: string;
    globalSettings: GlobalSettings;
}

export interface DiagnoseTraefikJobPayload extends DeployJobPayload {}

export interface AgentJobRequest {
    jobType: AgentJobType;
    payload: DeployJobPayload | ImportComposeJobPayload | InspectComposeJobPayload | ValidateComposeJobPayload | StopJobPayload | InspectStatusJobPayload | RuntimeLogsJobPayload | RuntimeActionJobPayload | DeleteCheckoutJobPayload | InspectCheckoutBindMountsJobPayload | DetectTraefikJobPayload | DiagnoseTraefikJobPayload;
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
    reconnectDeploymentLog?(jobId: string, streamToken: string, hooks?: DeploymentHooks): RuntimeLogStream;
    stopProject(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings): Promise<string>;
    importCompose(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings): Promise<ImportedCompose>;
    inspectCompose(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings): Promise<ComposeInspection>;
    validateCompose(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings): Promise<ComposeValidation>;
    deleteCheckout(checkoutPath: string): Promise<CheckoutCleanupResult>;
    inspectCheckoutBindMounts(checkoutPath: string): Promise<CheckoutBindMountInspection>;
    detectTraefik(globalSettings: GlobalSettings): Promise<ServerCapabilities["traefik"]>;
    backupTraefik(serverId: string, globalSettings: GlobalSettings): Promise<TraefikConfigBackup>;
    validateTraefik(serverId: string, globalSettings: GlobalSettings): Promise<TraefikConfigValidation>;
    diagnoseTraefik(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings): Promise<TraefikDiagnostics>;
    inspectStatus(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings): Promise<RuntimeStatus>;
    runtimeLogs(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings, service: string, tail: number): Promise<RuntimeLogs>;
    followRuntimeLogs(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings, service: string, tail: number, hooks?: RuntimeLogHooks): Promise<RuntimeLogStream>;
    runtimeAction(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings, service: string, action: RuntimeServiceAction): Promise<RuntimeActionResult>;
    followRuntimeAction(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings, service: string, action: RuntimeServiceAction, hooks?: RuntimeLogHooks): Promise<RuntimeLogStream> | RuntimeLogStream;
}
