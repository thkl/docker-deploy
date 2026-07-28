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
    token: string;
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
    token?: string;
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
