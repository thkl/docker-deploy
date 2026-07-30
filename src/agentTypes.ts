import { CheckoutCleanupResult } from "./checkoutCleanup.js";
import { ImportedCompose } from "./composeImport.js";
import { DeploymentHooks } from "./deploy.js";
import { GlobalSettings, ProjectSettings, RuntimeLogs, RuntimeStatus, ServerCapabilities } from "./types.js";

export type AgentJobType = "deploy" | "importCompose" | "stop" | "deleteCheckout" | "detectTraefik" | "inspectStatus" | "runtimeLogs";

export interface DeployJobPayload {
    projectName: string;
    appSettings: ProjectSettings;
    globalSettings: GlobalSettings;
}

export interface ImportComposeJobPayload extends DeployJobPayload {}

export interface StopJobPayload extends DeployJobPayload {}

export interface InspectStatusJobPayload extends DeployJobPayload {}

export interface RuntimeLogsJobPayload extends DeployJobPayload {
    service: string;
    tail: number;
}

export interface DeleteCheckoutJobPayload {
    checkoutPath: string;
}

export interface DetectTraefikJobPayload {
    globalSettings: GlobalSettings;
}

export interface AgentJobRequest {
    jobType: AgentJobType;
    payload: DeployJobPayload | ImportComposeJobPayload | StopJobPayload | InspectStatusJobPayload | RuntimeLogsJobPayload | DeleteCheckoutJobPayload | DetectTraefikJobPayload;
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
    deployProject(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings, hooks?: DeploymentHooks): void | Promise<void>;
    stopProject(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings): Promise<string>;
    importCompose(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings): Promise<ImportedCompose>;
    deleteCheckout(checkoutPath: string): Promise<CheckoutCleanupResult>;
    detectTraefik(globalSettings: GlobalSettings): Promise<ServerCapabilities["traefik"]>;
    inspectStatus(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings): Promise<RuntimeStatus>;
    runtimeLogs(projectName: string, appSettings: ProjectSettings, globalSettings: GlobalSettings, service: string, tail: number): Promise<RuntimeLogs>;
}
