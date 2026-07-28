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

export interface ProjectSummary {
  name: string;
  path: string;
  token: string;
  deployToken: string;
  composeOverride: string;
  hasComposeOverride: boolean;
  traefik: TraefikSettings;
}

export interface ProjectPayload {
  name: string;
  token: string;
  deployToken: string;
  path: string;
  composeOverride: string;
  traefikEnabled: boolean;
  traefikHostname: string;
  traefikService: string;
  traefikPort: string;
  traefikEntryPoints: string;
  traefikCertResolver: string;
  traefikNetwork: string;
  traefikWildcardCertificate: boolean;
  traefikWildcardDomain: string;
  traefikWebsocket: boolean;
  traefikRemovePublishedPorts: boolean;
}

