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

export type DeploymentStatus = 'running' | 'succeeded' | 'failed';
export type DeploymentTrigger = 'webhook' | 'ci' | 'manual';

export interface DeploymentRecord {
  id: string;
  projectName: string;
  trigger: DeploymentTrigger;
  status: DeploymentStatus;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | string;
  error?: string;
  log: string;
}

export interface ProjectSummary {
  name: string;
  repositoryUrl: string;
  path: string;
  token: string;
  deployToken: string;
  composeOverride: string;
  hasComposeOverride: boolean;
  traefik: TraefikSettings;
  lastDeployment?: DeploymentRecord | null;
}

export interface ProjectPayload {
  name: string;
  repositoryUrl: string;
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

export interface GlobalSettings {
  dataRoot: string;
  defaultTraefikNetwork: string;
  defaultTraefikEntryPoints: string;
  defaultTraefikCertResolver: string;
  sshKeyPath: string;
  cleanupAfterDeploy: boolean;
}

export interface AuthStatus {
  required: boolean;
}
