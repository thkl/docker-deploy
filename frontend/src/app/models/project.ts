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
  serverId?: string;
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
  serverId?: string;
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
  serverId?: string;
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

export interface DeleteProjectPayload {
  confirmationName: string;
  stopContainers: boolean;
  deleteCheckout: boolean;
  deleteDeploymentHistory: boolean;
}

export interface DeleteProjectResult {
  deleted: boolean;
  actions: string[];
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

export interface ServerRecord {
  id: string;
  name: string;
  kind: 'local' | 'remote';
  baseUrl?: string;
  agentPublicEncryptionKey?: string;
  agentPublicSigningKey?: string;
  status?: 'online' | 'offline' | 'unpaired';
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
