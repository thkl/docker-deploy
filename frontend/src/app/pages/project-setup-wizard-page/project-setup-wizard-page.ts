import { Component, computed, effect, inject, OnDestroy, OnInit, signal, WritableSignal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom, Subscription } from 'rxjs';
import { DeploymentRecord, GlobalSettings, ProjectPayload } from '../../models/project';
import { DeploymentStreamService } from '../../services/deployment-stream';
import { ProjectApi } from '../../services/project-api';
import { ProjectStore } from '../../state/project-store';

type WizardStep = 0 | 1 | 2 | 3;
type SourceType = 'git' | 'image';
type DatabaseType = 'none' | 'postgres' | 'mariadb';
type VolumeKind = 'volume' | 'bind';

interface SetupVolume {
  id: number;
  kind: VolumeKind;
  source: string;
  target: string;
}

const defaultGlobalSettings: GlobalSettings = {
  dataRoot: '/root/docker-apps',
  updaterInternalUrl: '',
  defaultTraefikNetwork: 'proxy',
  defaultTraefikEntryPoints: 'websecure',
  defaultTraefikCertResolver: 'letsencrypt',
  traefikDomains: [],
  sshKeyPath: '~/.ssh',
  cleanupAfterDeploy: false,
  autoBackupEnabled: false,
  autoBackupCron: '0 3 * * *',
  autoBackupPath: '/root/docker-apps/.updater/backups',
  registryAddress: '',
  registryUsername: '',
  registryPassword: '',
  releaseSnapshotLimit: 20,
  notifications: {
    enabled: false,
    healthPollingEnabled: true,
    healthPollingIntervalSeconds: 60,
    events: {
      deploymentStarted: true,
      deploymentSucceeded: true,
      deploymentFailed: true,
      serviceDown: true,
    },
    channels: [],
  },
};

@Component({
  selector: 'app-project-setup-wizard-page',
  imports: [RouterLink],
  templateUrl: './project-setup-wizard-page.html',
  styleUrl: './project-setup-wizard-page.scss',
})
export class ProjectSetupWizardPage implements OnInit, OnDestroy {
  protected readonly store = inject(ProjectStore);
  private readonly api = inject(ProjectApi);
  private readonly router = inject(Router);
  private readonly deploymentStream = inject(DeploymentStreamService);

  protected readonly step = signal<WizardStep>(0);
  protected readonly steps = ['Application', 'Data', 'Traffic', 'Review'];
  protected readonly sourceType = signal<SourceType>('git');
  protected readonly projectName = signal('');
  protected readonly repositoryUrl = signal('');
  protected readonly gitToken = signal('');
  protected readonly image = signal('');
  protected readonly serviceName = signal('app');
  protected readonly containerPort = signal('3000');
  protected readonly selectedServerId = signal('local');
  protected readonly database = signal<DatabaseType>('none');
  protected readonly databaseName = signal('app');
  protected readonly databaseUser = signal('app');
  protected readonly databasePassword = signal('');
  protected readonly databaseRootPassword = signal('');
  protected readonly databaseUrlEnvName = signal('DATABASE_URL');
  protected readonly separateDatabaseVariables = signal(false);
  protected readonly databaseHostEnvName = signal('DB_HOST');
  protected readonly databasePortEnvName = signal('DB_PORT');
  protected readonly databaseNameEnvName = signal('DB_DATABASE');
  protected readonly databaseUserEnvName = signal('DB_USER');
  protected readonly databasePasswordEnvName = signal('DB_PASSWORD');
  protected readonly volumes = signal<SetupVolume[]>([]);
  protected readonly traefikEnabled = signal(false);
  protected readonly hostname = signal('');
  protected readonly selectedDomain = signal('');
  protected readonly customHostname = signal(false);
  protected readonly traefikNetwork = signal('proxy');
  protected readonly traefikNetworkCustomized = signal(false);
  protected readonly wildcardCertificate = signal(false);
  protected readonly wildcardDomain = signal('');
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  protected readonly deploymentError = signal('');
  protected readonly savedProjectId = signal('');
  protected readonly deploymentState = signal<'idle' | 'starting' | 'running' | 'succeeded' | 'failed'>('idle');
  protected readonly deployment = signal<DeploymentRecord | null>(null);
  protected readonly globalSettings = signal<GlobalSettings>(defaultGlobalSettings);
  protected readonly availableDomains = computed(() => this.globalSettings().traefikDomains ?? []);
  protected readonly detectedTraefikNetwork = computed(() => {
    const server = this.store.servers().find((candidate) => candidate.id === this.selectedServerId());
    return server?.capabilities?.traefik.dockerProviderNetwork || server?.capabilities?.traefik.networks?.[0] || '';
  });
  protected readonly traefikRoutingWarning = computed(() => {
    if (!this.traefikEnabled()) return '';
    const server = this.store.servers().find((candidate) => candidate.id === this.selectedServerId());
    if (server?.kind !== 'remote') return '';

    const traefik = server.capabilities?.traefik;
    if (!traefik) return '';
    if (traefik?.providerMode === 'swarm') {
      return 'Traefik on this agent detects Swarm services, but this wizard creates a Compose app. Traefik will ignore its container labels. Enable the Docker provider on this host or use Advanced setup to deploy as a Swarm stack from a manager.';
    }
    if (!traefik?.available) {
      return 'No Traefik workload was detected on this agent. With standalone Docker, Traefik must run on this same host and share the selected network. If Traefik runs elsewhere, use Swarm or publish a host port and configure an upstream route to this node.';
    }
    if (!traefik.providerMode || traefik.providerMode === 'unknown') {
      return 'Traefik is detected on this agent, but its provider could not be identified. Compose routing requires the Docker provider; a Swarm-only provider ignores Compose container labels.';
    }

    const providerNetwork = traefik.dockerProviderNetwork || traefik.networks?.[0];
    if (providerNetwork && providerNetwork !== this.traefikNetwork()) {
      return `Traefik reports ${providerNetwork} as its Docker provider network, but this project uses ${this.traefikNetwork()}. Use the detected network so Traefik can reach the app.`;
    }
    return '';
  });
  protected readonly publicUrl = computed(() => {
    const hostname = this.hostname().trim();
    return this.traefikEnabled() && hostname ? `https://${hostname}` : '';
  });
  protected readonly suggestedHostname = computed(() => {
    const name = projectHostnameLabel(this.projectName());
    const domain = this.selectedDomain();
    return name && domain ? `${name}.${domain}` : '';
  });
  protected readonly deploymentProgress = computed(() => {
    const state = this.deploymentState();
    if (state === 'succeeded' || state === 'failed') return 100;
    if (state === 'starting') return 5;

    switch (this.deployment()?.phase) {
      case 'queued': return 8;
      case 'dispatching': return 20;
      case 'running': return 50;
      case 'reconnecting': return 62;
      case 'reconciling': return 78;
      case 'cleanup': return 90;
      case 'succeeded': return 100;
      case 'failed':
      case 'canceled': return 100;
      default: return state === 'running' ? 45 : 0;
    }
  });
  protected readonly lastLogLine = computed(() => {
    const deployment = this.deployment();
    const log = deployment?.log || deployment?.targets?.map((target) => target.log).filter(Boolean).join('\n') || '';
    return log.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) || 'Waiting for deployment output…';
  });

  private nextVolumeId = 1;
  private deploymentSubscription?: Subscription;

  constructor() {
    effect(() => {
      const servers = this.store.servers();
      const selected = this.selectedServerId();
      if (servers.length && !servers.some((server) => server.id === selected)) {
        this.selectedServerId.set(servers[0].id);
      }
      if (!this.traefikNetworkCustomized()) {
        const server = servers.find((candidate) => candidate.id === this.selectedServerId());
        const detected = server?.capabilities?.traefik.dockerProviderNetwork || server?.capabilities?.traefik.networks?.[0];
        this.traefikNetwork.set(detected || this.globalSettings().defaultTraefikNetwork || 'proxy');
      }
    });
  }

  ngOnInit() {
    this.store.selectProject('');
    this.store.loadServers();
    this.api.getGlobalSettings().subscribe({
      next: (settings) => {
        this.globalSettings.set(settings);
        const domains = settings.traefikDomains ?? [];
        if (domains.length && !this.customHostname()) {
          this.selectedDomain.set(domains[0].toLowerCase());
          this.hostname.set(this.suggestedHostname());
        }
      },
    });
  }

  ngOnDestroy() {
    this.deploymentSubscription?.unsubscribe();
  }

  protected updateText(field: WritableSignal<string>, event: Event) {
    field.set((event.target as HTMLInputElement).value);
  }

  protected updateProjectName(event: Event) {
    this.projectName.set((event.target as HTMLInputElement).value);
    if (!this.customHostname()) {
      this.hostname.set(this.suggestedHostname());
    }
  }

  protected updateHostname(event: Event) {
    const value = (event.target as HTMLInputElement).value.trim();
    this.hostname.set(value.replace(/^https?:\/\//i, '').replace(/\/+$/, ''));
    this.customHostname.set(true);
    this.error.set('');
  }

  protected selectTrafficDomain(event: Event) {
    const domain = (event.target as HTMLSelectElement).value;
    if (domain === '__custom__') {
      this.customHostname.set(true);
      return;
    }

    const previousDomain = this.selectedDomain();
    this.selectedDomain.set(domain);
    this.customHostname.set(false);
    this.hostname.set(this.suggestedHostname());
    if (this.wildcardCertificate() && (!this.wildcardDomain() || this.wildcardDomain() === previousDomain)) {
      this.wildcardDomain.set(domain);
    }
    this.error.set('');
  }

  protected hostnameSuggestionLabel(domain: string) {
    return `https://${projectHostnameLabel(this.projectName()) || 'project'}.${domain}`;
  }

  protected selectSource(source: SourceType) {
    this.sourceType.set(source);
    this.error.set('');
  }

  protected selectServer(event: Event) {
    this.selectedServerId.set((event.target as HTMLSelectElement).value || 'local');
    this.traefikNetworkCustomized.set(false);
  }

  protected updateTraefikNetwork(event: Event) {
    this.traefikNetwork.set((event.target as HTMLInputElement).value);
    this.traefikNetworkCustomized.set(true);
    this.error.set('');
  }

  protected toggleTraefik(event: Event) {
    this.traefikEnabled.set((event.target as HTMLInputElement).checked);
    this.error.set('');
  }

  protected toggleWildcardCertificate(event: Event) {
    const enabled = (event.target as HTMLInputElement).checked;
    this.wildcardCertificate.set(enabled);
    if (enabled && !this.wildcardDomain() && this.selectedDomain()) {
      this.wildcardDomain.set(this.selectedDomain());
    }
    this.error.set('');
  }

  protected toggleSeparateDatabaseVariables(event: Event) {
    this.separateDatabaseVariables.set((event.target as HTMLInputElement).checked);
    this.error.set('');
  }

  protected selectDatabase(event: Event) {
    const database = (event.target as HTMLSelectElement).value as DatabaseType;
    this.database.set(database);
    if (database !== 'none' && (!this.databasePassword() || !this.databaseRootPassword())) {
      this.generateDatabaseCredentials();
    }
    this.error.set('');
  }

  protected generateDatabaseCredentials() {
    this.databasePassword.set(randomPassword());
    this.databaseRootPassword.set(randomPassword());
    this.error.set('');
  }

  protected addVolume() {
    const count = this.volumes().length + 1;
    this.volumes.update((volumes) => [
      ...volumes,
      {
        id: this.nextVolumeId++,
        kind: 'volume',
        source: count === 1 ? 'app-data' : `app-data-${count}`,
        target: '/app/data',
      },
    ]);
  }

  protected updateVolume(id: number, field: 'kind' | 'source' | 'target', event: Event) {
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    const value = target.value;
    this.volumes.update((volumes) => volumes.map((volume) =>
      volume.id === id ? { ...volume, [field]: value } as SetupVolume : volume,
    ));
    this.error.set('');
  }

  protected removeVolume(id: number) {
    this.volumes.update((volumes) => volumes.filter((volume) => volume.id !== id));
    this.error.set('');
  }

  protected next() {
    const message = this.validateStep(this.step());
    if (message) {
      this.error.set(message);
      return;
    }

    this.error.set('');
    this.step.update((step) => Math.min(step + 1, 3) as WizardStep);
  }

  protected back() {
    this.error.set('');
    this.step.update((step) => Math.max(step - 1, 0) as WizardStep);
  }

  protected async saveProject() {
    if (!this.validateAllSteps()) return;

    this.error.set('');
    this.saving.set(true);
    try {
      await this.ensureProjectSaved();
      await this.router.navigate(['/projects', this.savedProjectId(), 'overview']);
    } catch (error) {
      this.error.set(readApiError(error));
    } finally {
      this.saving.set(false);
    }
  }

  protected async saveAndDeploy() {
    if (!this.validateAllSteps()) return;

    this.error.set('');
    this.deploymentError.set('');
    this.saving.set(true);
    try {
      const projectId = await this.ensureProjectSaved();
      this.deploymentState.set('starting');
      this.deployment.set(null);
      this.deploymentSubscription?.unsubscribe();
      const result = await firstValueFrom(this.api.deployProject(projectId));
      this.watchDeployment(projectId, result.deploymentId);
    } catch (error) {
      this.deploymentState.set('failed');
      if (this.savedProjectId()) {
        this.deploymentError.set(readApiError(error));
      } else {
        this.error.set(readApiError(error));
      }
    } finally {
      this.saving.set(false);
    }
  }

  protected async deployAgain() {
    if (!this.savedProjectId()) return;
    this.deploymentError.set('');
    this.deployment.set(null);
    this.saving.set(true);
    this.deploymentState.set('starting');
    try {
      this.deploymentSubscription?.unsubscribe();
      const result = await firstValueFrom(this.api.deployProject(this.savedProjectId()));
      this.watchDeployment(this.savedProjectId(), result.deploymentId);
    } catch (error) {
      this.deploymentState.set('failed');
      this.deploymentError.set(readApiError(error));
    } finally {
      this.saving.set(false);
    }
  }

  protected deploymentStatusLabel() {
    switch (this.deploymentState()) {
      case 'starting': return 'Starting deployment';
      case 'succeeded': return 'Deployment succeeded';
      case 'failed': return 'Deployment failed';
      case 'running': {
        const phase = this.deployment()?.phase;
        return phase ? phase.charAt(0).toUpperCase() + phase.slice(1) : 'Deployment running';
      }
      default: return 'Deployment';
    }
  }

  private validateAllSteps() {
    for (const step of [0, 1, 2] as const) {
      const message = this.validateStep(step);
      if (message) {
        this.step.set(step);
        this.error.set(message);
        return false;
      }
    }

    this.error.set('');
    return true;
  }

  private async ensureProjectSaved() {
    if (this.savedProjectId()) return this.savedProjectId();

    const result = await firstValueFrom(this.api.createProject(this.buildPayload()));
    const projectId = result.id || result.name || this.projectName().trim();
    this.savedProjectId.set(projectId);
    this.store.selectProject(projectId);
    this.store.loadProjects();
    return projectId;
  }

  private watchDeployment(projectRef: string, deploymentId: string) {
    this.deploymentState.set('running');
    this.deploymentSubscription = this.deploymentStream.streamLatest(projectRef).subscribe({
      next: (deployment) => {
        if (!deployment || (deployment.id !== deploymentId && !deployment.targets?.some((target) => target.id === deploymentId))) return;
        this.deployment.set(deployment);
        if (deployment.status === 'succeeded') {
          this.deploymentState.set('succeeded');
          this.store.loadProjects();
        } else if (deployment.status === 'failed' || deployment.phase === 'canceled') {
          this.deploymentState.set('failed');
          this.deploymentError.set(deployment.error || (deployment.phase === 'canceled' ? 'Deployment was canceled.' : 'Deployment failed.'));
        } else {
          this.deploymentState.set('running');
        }
      },
      error: () => {
        this.deploymentError.set('Could not read deployment progress. The deployment may still be running.');
      },
    });
  }

  protected databaseLabel() {
    return this.database() === 'postgres'
      ? 'PostgreSQL'
      : this.database() === 'mariadb'
        ? 'MariaDB'
        : 'No database service';
  }

  protected selectedServerName() {
    return this.store.servers().find((server) => server.id === this.selectedServerId())?.name || 'Local Docker host';
  }

  protected composePreview() {
    return this.buildComposeOverride();
  }

  protected connectionUri() {
    const password = encodeURIComponent(this.databasePassword());
    const user = encodeURIComponent(this.databaseUser());
    const database = encodeURIComponent(this.databaseName());
    return this.database() === 'postgres'
      ? `postgresql://${user}:${password}@database:5432/${database}`
      : `mysql://${user}:${password}@database:3306/${database}`;
  }

  protected volumeLabel(volume: SetupVolume) {
    return volume.kind === 'volume' ? `Named volume ${volume.source}` : `Bind ${volume.source}`;
  }

  protected trackVolume(_index: number, volume: SetupVolume) {
    return volume.id;
  }

  private validateStep(step: WizardStep) {
    if (step === 0) {
      const name = this.projectName().trim();
      if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
        return 'Enter a project name using letters, numbers, dots, underscores, or hyphens.';
      }
      if (this.sourceType() === 'git' && !this.repositoryUrl().trim()) {
        return 'Enter the Git repository URL.';
      }
      if (this.sourceType() === 'image' && !this.image().trim()) {
        return 'Enter the Docker image name, for example nginx:alpine.';
      }
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(this.serviceName().trim())) {
        return 'Enter a valid Compose service name.';
      }
      if (this.database() !== 'none' && this.serviceName().trim() === 'database') {
        return 'Use a different application service name because “database” is reserved for the database service.';
      }
      if (this.containerPort().trim() && !validPort(this.containerPort())) {
        return 'Enter a container port between 1 and 65535.';
      }
    }

    if (step === 1) {
      for (const volume of this.volumes()) {
        if (volume.kind === 'volume' && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(volume.source.trim())) {
          return 'Named volumes need a name using letters, numbers, dots, underscores, or hyphens.';
        }
        if (volume.kind === 'bind' && !/^\/[^\r\n]*$/.test(volume.source.trim())) {
          return 'Bind mounts need an absolute path on the target Docker host.';
        }
        if (!/^\/[^\r\n:]*$/.test(volume.target.trim())) {
          return 'Each mount target needs an absolute container path, such as /app/data.';
        }
      }

      if (this.database() !== 'none') {
        if (!/^[a-zA-Z0-9_]+$/.test(this.databaseName().trim()) || !/^[a-zA-Z0-9_]+$/.test(this.databaseUser().trim())) {
          return 'Database and user names can only contain letters, numbers, and underscores.';
        }
        if (!this.databasePassword().trim()) {
          return 'Set a database password or generate one before continuing.';
        }
        const variableNames = [this.databaseUrlEnvName().trim()];
        if (this.separateDatabaseVariables()) {
          variableNames.push(
            this.databaseHostEnvName().trim(),
            this.databasePortEnvName().trim(),
            this.databaseNameEnvName().trim(),
            this.databaseUserEnvName().trim(),
            this.databasePasswordEnvName().trim(),
          );
        }
        if (variableNames.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) {
          return 'Environment variable names must start with a letter or underscore and contain only letters, numbers, and underscores.';
        }
        if (new Set(variableNames.map((name) => name.toLowerCase())).size !== variableNames.length) {
          return 'Each database setting needs a different environment variable name.';
        }
      }
    }

    if (step === 2 && this.traefikEnabled()) {
      if (!validHostname(this.hostname().trim())) {
        return 'Enter a hostname using letters, numbers, dots, and hyphens.';
      }
      if (!validPort(this.containerPort())) {
        return 'Enter the application’s internal container port between 1 and 65535.';
      }
      if (!/^[a-zA-Z0-9._-]+$/.test(this.traefikNetwork().trim())) {
        return 'Enter a Docker network name using letters, numbers, dots, underscores, or hyphens.';
      }
      if (this.wildcardCertificate()) {
        if (!validHostname(this.wildcardDomain().trim())) {
          return 'Enter a wildcard certificate base domain using letters, numbers, dots, and hyphens.';
        }
      }
    }

    return '';
  }

  private buildPayload(): ProjectPayload {
    const name = this.projectName().trim();
    const serverId = this.selectedServerId().trim() || 'local';
    const repositoryUrl = this.sourceType() === 'git' ? this.repositoryUrl().trim() : '';
    const token = this.sourceType() === 'git' ? this.gitToken().trim() : '';
    const composeOverride = this.buildComposeOverride();
    const traefikEnabled = this.traefikEnabled();
    const hostname = this.hostname().trim();
    const port = Number(this.containerPort().trim() || '3000');
    const traefikNetwork = this.traefikNetwork().trim() || this.globalSettings().defaultTraefikNetwork || 'proxy';
    const wildcardCertificate = traefikEnabled && this.wildcardCertificate();
    const wildcardDomain = wildcardCertificate ? this.wildcardDomain().trim() : '';

    return {
      name,
      serverId,
      serverIds: [serverId],
      repositoryUrl,
      token,
      deployToken: '',
      path: '',
      composeOverride,
      deploymentStrategy: 'compose',
      deploymentOnHold: false,
      traefikEnabled,
      traefikHostname: traefikEnabled ? hostname : '',
      traefikService: this.serviceName().trim(),
      traefikPort: String(port),
      traefikEntryPoints: this.globalSettings().defaultTraefikEntryPoints || 'websecure',
      traefikCertResolver: this.globalSettings().defaultTraefikCertResolver || 'letsencrypt',
      traefikNetwork,
      traefikWildcardCertificate: wildcardCertificate,
      traefikWildcardDomain: wildcardDomain,
      traefikWebsocket: false,
      traefikRemovePublishedPorts: true,
      project: { name, serverId, serverIds: [serverId], path: '' },
      git: { repositoryUrl, token },
      deployment: { deployToken: '', strategy: 'compose', onHold: false },
      compose: { override: composeOverride, envFilePath: '', envSecrets: [] },
      traefik: {
        enabled: traefikEnabled,
        ...(traefikEnabled ? {
          hostname,
          service: this.serviceName().trim(),
          port,
          entryPoints: this.globalSettings().defaultTraefikEntryPoints || 'websecure',
          certResolver: this.globalSettings().defaultTraefikCertResolver || 'letsencrypt',
          network: traefikNetwork,
          wildcardCertificate,
          wildcardDomain,
          removePublishedPorts: true,
        } : {}),
      },
    };
  }

  private buildComposeOverride() {
    const service = this.serviceName().trim();
    const lines = ['services:', `  ${yamlQuote(service)}:`];
    const traefikEnabled = this.traefikEnabled();
    const traefikNetwork = this.traefikNetwork().trim() || this.globalSettings().defaultTraefikNetwork || 'proxy';
    const internalNetwork = this.internalNetworkName();

    if (this.sourceType() === 'git') {
      lines.push('    build:', '      context: .');
    } else {
      lines.push(`    image: ${yamlQuote(this.image().trim())}`);
    }
    lines.push('    restart: unless-stopped');

    const port = this.containerPort().trim();
    if (port) {
      lines.push('    expose:', `      - ${yamlQuote(port)}`);
    }

    if (this.database() !== 'none') {
      lines.push('    depends_on:', '      - database');
      const appEnvironment: Array<[string, string]> = [
        [this.databaseUrlEnvName().trim(), this.connectionUri()],
      ];
      if (this.separateDatabaseVariables()) {
        appEnvironment.push(
          [this.databaseHostEnvName().trim(), 'database'],
          [this.databasePortEnvName().trim(), this.database() === 'postgres' ? '5432' : '3306'],
          [this.databaseNameEnvName().trim(), this.databaseName().trim()],
          [this.databaseUserEnvName().trim(), this.databaseUser().trim()],
          [this.databasePasswordEnvName().trim(), this.databasePassword()],
        );
      }
      lines.push('    environment:');
      for (const [key, value] of appEnvironment) {
        lines.push(`      ${yamlQuote(key)}: ${yamlQuote(value)}`);
      }
    }

    if (traefikEnabled) {
      lines.push('    networks:');
      if (this.database() !== 'none') {
        lines.push(`      - ${yamlQuote(internalNetwork)}`);
      }
      lines.push(`      - ${yamlQuote(traefikNetwork)}`);
      lines.push('    labels:');
      for (const [key, value] of this.traefikLabels(traefikNetwork)) {
        lines.push(`      ${yamlQuote(key)}: ${yamlQuote(value)}`);
      }
    }

    const appVolumes = this.volumes();
    if (appVolumes.length) {
      lines.push('    volumes:');
      for (const volume of appVolumes) {
        const kind = volume.kind === 'volume' ? 'volume' : 'bind';
        lines.push(`      - type: ${kind}`, `        source: ${yamlQuote(volume.source.trim())}`, `        target: ${yamlQuote(volume.target.trim())}`);
      }
    }

    if (this.database() !== 'none') {
      const databaseImage = this.database() === 'postgres' ? 'postgres:17-alpine' : 'mariadb:11.4';
      const databaseVolumeName = this.databaseVolumeName();
      const environment = this.database() === 'postgres'
        ? [
            ['POSTGRES_DB', this.databaseName().trim()],
            ['POSTGRES_USER', this.databaseUser().trim()],
            ['POSTGRES_PASSWORD', this.databasePassword()],
          ]
        : [
            ['MARIADB_DATABASE', this.databaseName().trim()],
            ['MARIADB_USER', this.databaseUser().trim()],
            ['MARIADB_PASSWORD', this.databasePassword()],
            ['MARIADB_ROOT_PASSWORD', this.databaseRootPassword()],
          ];
      lines.push(
        '  database:',
        `    image: ${databaseImage}`,
        '    restart: unless-stopped',
        '    environment:',
      );
      for (const [key, value] of environment) {
        lines.push(`      ${key}: ${yamlQuote(value)}`);
      }
      lines.push(
        '    volumes:',
        '      - type: volume',
        `        source: ${yamlQuote(databaseVolumeName)}`,
        `        target: ${yamlQuote(this.database() === 'postgres' ? '/var/lib/postgresql/data' : '/var/lib/mysql')}`,
      );
      if (traefikEnabled) {
        lines.push('    networks:', `      - ${yamlQuote(internalNetwork)}`);
      }
    }

    const namedVolumes = appVolumes.filter((volume) => volume.kind === 'volume').map((volume) => volume.source.trim());
    if (this.database() !== 'none' || namedVolumes.length) {
      lines.push('volumes:');
      for (const volumeName of new Set(namedVolumes)) {
        lines.push(`  ${yamlQuote(volumeName)}: {}`);
      }
      if (this.database() !== 'none') {
        lines.push(`  ${yamlQuote(this.databaseVolumeName())}: {}`);
      }
    }

    if (traefikEnabled) {
      lines.push('networks:');
      if (this.database() !== 'none') {
        lines.push(`  ${yamlQuote(internalNetwork)}: {}`);
      }
      lines.push(`  ${yamlQuote(traefikNetwork)}:`, '    external: true');
    }

    return lines.join('\n');
  }

  private traefikLabels(network: string) {
    const projectRouterName = this.projectName().trim().replace(/[^a-zA-Z0-9_-]/g, '-') || this.serviceName().trim();
    const entryPoints = this.globalSettings().defaultTraefikEntryPoints || 'websecure';
    const certResolver = this.globalSettings().defaultTraefikCertResolver || 'letsencrypt';
    const labels: Array<[string, string]> = [
      ['traefik.enable', 'true'],
      ['traefik.docker.network', network],
      [`traefik.http.routers.${projectRouterName}.rule`, 'Host(`' + this.hostname().trim() + '`)'],
      [`traefik.http.routers.${projectRouterName}.entrypoints`, entryPoints],
      [`traefik.http.routers.${projectRouterName}.tls`, 'true'],
      [`traefik.http.routers.${projectRouterName}.tls.certresolver`, certResolver],
      [`traefik.http.services.${projectRouterName}.loadbalancer.server.port`, this.containerPort().trim() || '80'],
    ];

    if (this.wildcardCertificate()) {
      labels.push(
        [`traefik.http.routers.${projectRouterName}.tls.domains[0].main`, this.wildcardDomain().trim()],
        [`traefik.http.routers.${projectRouterName}.tls.domains[0].sans`, `*.${this.wildcardDomain().trim()}`],
      );
    }

    return labels;
  }

  private internalNetworkName() {
    return (this.traefikNetwork().trim() || this.globalSettings().defaultTraefikNetwork || 'proxy') === 'wizard-internal'
      ? 'wizard-app-internal'
      : 'wizard-internal';
  }

  private databaseVolumeName() {
    const appVolumeNames = new Set(this.volumes().filter((volume) => volume.kind === 'volume').map((volume) => volume.source.trim()));
    let name = 'database-data';
    let suffix = 2;
    while (appVolumeNames.has(name)) {
      name = `database-data-${suffix++}`;
    }
    return name;
  }
}

function validPort(value: string) {
  const port = Number(value.trim());
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function validHostname(value: string) {
  const labels = value.toLowerCase().split('.');
  return value.length <= 253 && labels.length >= 2 && labels.every((label) =>
    label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
  );
}

function projectHostnameLabel(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63).replace(/-+$/g, '');
}

function yamlQuote(value: string) {
  return JSON.stringify(value);
}

function randomPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789_-';
  const bytes = new Uint8Array(28);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

function readApiError(error: unknown) {
  const apiError = (error as { error?: { error?: string } }).error?.error;
  return apiError || 'Could not save or deploy project.';
}
