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
  projectId?: string;
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
  id: string;
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
  capabilities?: ServerCapabilities;
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

export type RuntimeProjectStatus = 'running' | 'partial' | 'stopped' | 'unknown' | 'error';

export interface RuntimeServiceStatus {
  service: string;
  containerName?: string;
  containerId?: string;
  state: string;
  health?: string;
  image?: string;
  ports?: string;
  networkMode?: string;
  exposedPorts?: string[];
}

export interface RuntimeStatus {
  status: RuntimeProjectStatus;
  checkedAt: string;
  services: RuntimeServiceStatus[];
  error?: string;
}
