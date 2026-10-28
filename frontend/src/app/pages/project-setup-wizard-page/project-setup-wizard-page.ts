import { Component, effect, inject, OnInit, signal, WritableSignal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { GlobalSettings, ProjectPayload } from '../../models/project';
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
export class ProjectSetupWizardPage implements OnInit {
  protected readonly store = inject(ProjectStore);
  private readonly api = inject(ProjectApi);
  private readonly router = inject(Router);

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
  protected readonly volumes = signal<SetupVolume[]>([]);
  protected readonly traefikEnabled = signal(false);
  protected readonly hostname = signal('');
  protected readonly traefikNetwork = signal('proxy');
  protected readonly wildcardCertificate = signal(false);
  protected readonly wildcardDomain = signal('');
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  protected readonly globalSettings = signal<GlobalSettings>(defaultGlobalSettings);

  private nextVolumeId = 1;

  constructor() {
    effect(() => {
      const servers = this.store.servers();
      const selected = this.selectedServerId();
      if (servers.length && !servers.some((server) => server.id === selected)) {
        this.selectedServerId.set(servers[0].id);
      }
    });
  }

  ngOnInit() {
    this.store.selectProject('');
    this.store.loadServers();
    this.api.getGlobalSettings().subscribe({
      next: (settings) => {
        this.globalSettings.set(settings);
        this.traefikNetwork.set(settings.defaultTraefikNetwork || 'proxy');
      },
    });
  }

  protected updateText(field: WritableSignal<string>, event: Event) {
    field.set((event.target as HTMLInputElement).value);
  }

  protected selectSource(source: SourceType) {
    this.sourceType.set(source);
    this.error.set('');
  }

  protected selectServer(event: Event) {
    this.selectedServerId.set((event.target as HTMLSelectElement).value || 'local');
  }

  protected toggleTraefik(event: Event) {
    this.traefikEnabled.set((event.target as HTMLInputElement).checked);
    this.error.set('');
  }

  protected toggleWildcardCertificate(event: Event) {
    this.wildcardCertificate.set((event.target as HTMLInputElement).checked);
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

  protected async createProject() {
    for (const step of [0, 1, 2] as const) {
      const message = this.validateStep(step);
      if (message) {
        this.step.set(step);
        this.error.set(message);
        return;
      }
    }

    this.error.set('');
    this.saving.set(true);
    try {
      const payload = this.buildPayload();
      const result = await firstValueFrom(this.api.createProject(payload));
      const projectId = result.id || result.name || this.projectName().trim();
      this.store.selectProject(projectId);
      this.store.loadProjects();
      await this.router.navigate(['/projects', projectId, 'overview']);
    } catch (error) {
      this.error.set(readApiError(error));
    } finally {
      this.saving.set(false);
    }
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
      }
    }

    if (step === 2 && this.traefikEnabled()) {
      if (!/^[a-zA-Z0-9.-]+$/.test(this.hostname().trim())) {
        return 'Enter a hostname using letters, numbers, dots, and hyphens.';
      }
      if (!validPort(this.containerPort())) {
        return 'Enter the application’s internal container port between 1 and 65535.';
      }
      if (!/^[a-zA-Z0-9._-]+$/.test(this.traefikNetwork().trim())) {
        return 'Enter a Docker network name using letters, numbers, dots, underscores, or hyphens.';
      }
      if (this.wildcardCertificate()) {
        if (!/^[a-zA-Z0-9.-]+$/.test(this.wildcardDomain().trim())) {
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
      lines.push('    environment:', `      DATABASE_URL: ${yamlQuote(this.connectionUri())}`);
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
  return apiError || 'Could not create project.';
}
