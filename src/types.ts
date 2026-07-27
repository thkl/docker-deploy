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
}

export interface ProjectSettings {
    token: string;
    deployToken?: string;
    path?: string;
    composeOverride?: string;
    traefik?: TraefikSettings;
}

export type ProjectConfig = Record<string, ProjectSettings>;

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
}
