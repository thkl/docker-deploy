import { CheckoutCleanupResult } from "./checkoutCleanup.js";
import { ImportedCompose } from "./composeImport.js";
import { DeploymentHooks } from "./deploy.js";
import { GlobalSettings, ProjectSettings, ServerCapabilities } from "./types.js";

export type AgentJobType = "deploy" | "importCompose" | "stop" | "deleteCheckout" | "detectTraefik";

export interface DeployJobPayload {
    projectName: string;
    appSettings: ProjectSettings;
    globalSettings: GlobalSettings;
}

export interface ImportComposeJobPayload extends DeployJobPayload {}

export interface StopJobPayload extends DeployJobPayload {}

export interface DeleteCheckoutJobPayload {
    checkoutPath: string;
}

export interface DetectTraefikJobPayload {
    globalSettings: GlobalSettings;
}

export interface AgentJobRequest {
    jobType: AgentJobType;
    payload: DeployJobPayload | ImportComposeJobPayload | StopJobPayload | DeleteCheckoutJobPayload | DetectTraefikJobPayload;
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
}
