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
}

export interface ServerCapabilities {
    traefik: {
        available: boolean;
        containerCount: number;
        networkPresent: boolean;
        checkedAt: string;
    };
}
