import { Component, computed, effect, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ComposeInspection, ComposeServiceInspection, ComposeValidation, DeploymentStrategy, GlobalSettings, PathBrowseResult, ProjectEnvironmentSecret, ProjectEnvironmentSecretExposure, ProjectEnvironmentSecretMode, ProjectEnvironmentSecretSource, ProjectPayload, ProjectSummary, ServerRecord, TraefikDiagnostics } from '../../models/project';
import { ProjectApi } from '../../services/project-api';
import { ProjectStore } from '../../state/project-store';
import { ProjectSettingsPageStore } from './project-settings-page.store';
import { ProjectSettingsSecretsSection } from './project-settings-secrets-section';

interface ComposeBuilderService {
  id: number;
  name: string;
  image: string;
  build: string;
  dockerfile: string;
  buildTarget: string;
  containerName: string;
  command: string;
  restart: string;
  networkMode: string;
  init: boolean;
  healthcheckMode: ComposeHealthcheckMode;
  healthcheckHttpUrl: string;
  healthcheckCommand: string;
  healthcheckInterval: string;
  healthcheckTimeout: string;
  healthcheckRetries: string;
  healthcheckStartPeriod: string;
  healthcheckExtra: string;
  ports: string;
  expose: string;
  environment: string;
  secretEnvironment: ComposeSecretEnvironmentEntry[];
  secretHelperCommand: string;
  volumes: string;
  networks: string;
  dependsOn: string;
  dependsOnAdvanced: string;
  deployMode: string;
  deployReplicas: string;
  deployPlacementConstraints: string;
  deployAdvanced: string;
  deployLabels: string;
  profiles: string;
  extra: string;
}

type ComposeHealthcheckMode = '' | 'http' | 'command' | 'disabled';

interface ComposeBuilderNetwork {
  id: number;
  name: string;
  external: boolean;
  driver: string;
  extra: string;
}

interface ComposeBuilderVolume {
  id: number;
  name: string;
  external: boolean;
  driver: string;
  driverOpts: ComposeKeyValueEntry[];
  extra: string;
}

type ComposeBuilderListField = 'ports' | 'expose' | 'volumes' | 'networks' | 'dependsOn' | 'profiles';
type ComposeBuilderRenderableService = Omit<ComposeBuilderService, 'id'> & { id?: number };
type ComposeBuilderRenderableNetwork = Omit<ComposeBuilderNetwork, 'id'> & { id?: number };
type ComposeBuilderRenderableVolume = Omit<ComposeBuilderVolume, 'id'> & { id?: number };

interface ComposeEnvironmentEntry {
  key: string;
  value: string;
}

interface ComposeKeyValueEntry {
  key: string;
  value: string;
}

interface ComposeVolumeMountEntry {
  kind: 'volume' | 'bind';
  source: string;
  target: string;
  mode: string;
}

interface ComposeSecretEnvironmentEntry extends ComposeEnvironmentEntry {
  mode: ProjectEnvironmentSecretMode;
  source: ProjectEnvironmentSecretSource;
  vaultSecretId: string;
  exposure: ProjectEnvironmentSecretExposure;
}

interface ComposeTraefikSettings {
  enabled: boolean;
  projectName: string;
  hostname: string;
  service: string;
  port: string;
  entryPoints: string;
  certResolver: string;
  network: string;
  wildcardCertificate: boolean;
  wildcardDomain: string;
  websocket: boolean;
  removePublishedPorts: boolean;
  deploymentStrategy: DeploymentStrategy;
}

interface StrategySummary {
  label: string;
  reason: string;
  details: string[];
}

@Component({
  selector: 'app-project-settings-page',
  imports: [ReactiveFormsModule, ProjectSettingsSecretsSection],
  templateUrl: './project-settings-page.html',
  styleUrl: './project-settings-page.scss',
  providers: [ProjectSettingsPageStore],
})
export class ProjectSettingsPage implements OnInit {
  protected readonly store = inject(ProjectStore);
  private readonly api = inject(ProjectApi);
  private readonly fb = inject(NonNullableFormBuilder);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly settingsState = inject(ProjectSettingsPageStore);

  protected readonly isNew = signal(true);
  protected readonly currentName = signal('');
  protected readonly saving = signal<'save' | 'deploy' | ''>('');
  protected readonly importingCompose = signal(false);
  protected readonly exportingProject = signal(false);
  protected readonly importingProject = signal(false);
  protected readonly inspectingCompose = signal(false);
  protected readonly validatingCompose = signal(false);
  protected readonly diagnosingTraefik = signal(false);
  protected readonly composeInspection = signal<ComposeInspection | null>(null);
  protected readonly composeValidation = signal<ComposeValidation | null>(null);
  protected readonly traefikDiagnostics = signal<TraefikDiagnostics | null>(null);
  protected readonly composeMode = signal<'builder' | 'yaml'>('builder');
  protected readonly builderSection = signal<'services' | 'secrets' | 'networks' | 'volumes' | 'traefik'>('services');
  protected readonly browsingHostPath = signal(false);
  protected readonly hostPathBrowserError = signal('');
  protected readonly hostPathBrowser = signal<{ serviceId: number; index: number; result: PathBrowseResult } | null>(null);
  protected readonly builderServices = this.settingsState.builderServices;
  protected readonly builderNetworks = signal<ComposeBuilderNetwork[]>([]);
  protected readonly builderVolumes = signal<ComposeBuilderVolume[]>([]);
  protected readonly message = this.settingsState.message;
  protected readonly error = this.settingsState.error;
  protected readonly traefikEnabled = signal(false);
  protected readonly wildcardCertificate = signal(false);
  protected readonly deploymentStrategy = signal<DeploymentStrategy>('compose');
  protected readonly registryDeployFromRegistry = signal(false);
  protected readonly repositoryUrl = signal('');
  protected readonly isSwarmMode = computed(() => this.deploymentStrategy() === 'swarm');
  protected readonly buildContextAvailable = computed(() => Boolean(this.repositoryUrl().trim()));
  protected readonly buildFieldDisabled = computed(() => !this.buildContextAvailable() || (this.isSwarmMode() && !this.registryDeployFromRegistry()));
  private readonly traefikFormRevision = signal(0);
  protected readonly selectedServerId = signal('local');
  protected readonly selectedServerIds = signal<string[]>(['local']);
  protected readonly servers = this.store.servers;
  protected readonly traefikAvailable = computed(() => {
    this.traefikFormRevision();
    const server = this.store.servers().find((candidate) => candidate.id === this.selectedServerId());
    const selectedNetwork = this.form.controls.traefikNetwork.value.trim();
    return server
      ? Boolean(server.capabilities?.traefik.available || this.builderNetworkNames().length > 0 || selectedNetwork)
      : true;
  });
  protected readonly title = computed(() => (this.isNew() ? 'New project' : `Settings for ${this.currentName()}`));
  protected readonly submitLabel = computed(() => (this.isNew() ? 'Create project' : 'Save'));
  protected readonly strategySummary = computed(() => {
    this.traefikFormRevision();
    const value = this.form.getRawValue();
    const server = this.store.servers().find((candidate) => candidate.id === this.selectedServerId()) ?? null;
    return formDeploymentStrategySummary({
      strategy: value.deploymentStrategy === 'swarm' ? 'swarm' : 'compose',
      traefikEnabled: value.traefikEnabled,
      traefikNetwork: value.traefikNetwork.trim(),
      targetCount: ensureServerSelected(this.selectedServerIds(), value.serverId.trim() || 'local').length,
      server
    });
  });
  protected readonly builderServiceNames = computed(() => this.builderServices().map((service) => service.name.trim()).filter(Boolean));
  protected readonly builderNetworkNames = computed(() => this.builderNetworks().map((network) => network.name.trim()).filter(Boolean));
  protected readonly detectedTraefikNetworkSuggestions = computed(() => {
    const known = new Set(this.builderNetworkNames());
    const server = this.store.servers().find((candidate) => candidate.id === this.selectedServerId());
    const traefik = server?.capabilities?.traefik;
    const detected = uniqueList([
      traefik?.dockerProviderNetwork,
      ...(traefik?.networks ?? []),
    ].filter(Boolean) as string[]);

    return detected.filter((network) => !known.has(network) && this.canComposeAttachToDockerNetwork(network));
  });
  protected readonly unusableTraefikNetworkSuggestions = computed(() => {
    const known = new Set(this.builderNetworkNames());
    const server = this.store.servers().find((candidate) => candidate.id === this.selectedServerId());
    const traefik = server?.capabilities?.traefik;
    const detected = uniqueList([
      traefik?.dockerProviderNetwork,
      ...(traefik?.networks ?? []),
    ].filter(Boolean) as string[]);

    return detected.filter((network) => !known.has(network) && !this.canComposeAttachToDockerNetwork(network));
  });
  protected readonly builderServiceReferences = computed(() => {
    const refs = new Map<string, string[]>();
    for (const service of this.builderServices()) {
      const serviceName = service.name.trim();
      if (!serviceName) {
        continue;
      }

      for (const dependency of splitLines(service.dependsOn)) {
        refs.set(dependency, [...(refs.get(dependency) ?? []), `${serviceName} depends_on`]);
      }
    }

    const traefik = this.currentTraefikComposeSettings();
    if (traefik.enabled && traefik.service) {
      refs.set(traefik.service, [...(refs.get(traefik.service) ?? []), 'Traefik target']);
    }

    return refs;
  });
  protected readonly builderNetworkReferences = computed(() => {
    const refs = new Map<string, string[]>();
    for (const service of this.builderServices()) {
      const serviceName = service.name.trim() || 'Unnamed service';
      for (const network of splitLines(service.networks)) {
        refs.set(network, [...(refs.get(network) ?? []), `${serviceName} network`]);
      }
    }

    const traefik = this.currentTraefikComposeSettings();
    if (traefik.enabled && traefik.network) {
      refs.set(traefik.network, [...(refs.get(traefik.network) ?? []), 'Traefik network']);
    }

    return refs;
  });
  protected readonly builderVolumeReferences = computed(() => {
    const refs = new Map<string, string[]>();
    const volumeNames = this.builderVolumes().map((volume) => volume.name.trim()).filter(Boolean);
    for (const service of this.builderServices()) {
      const serviceName = service.name.trim() || 'Unnamed service';
      for (const mount of splitLines(service.volumes)) {
        const source = volumeMountSource(mount);
        if (source && volumeNames.includes(source)) {
          refs.set(source, [...(refs.get(source) ?? []), `${serviceName} volume`]);
        }
      }
    }

    return refs;
  });
  protected readonly builderHostVolumeMounts = computed(() => {
    const mounts: Array<{ service: string; mount: string }> = [];
    for (const service of this.builderServices()) {
      const serviceName = service.name.trim() || 'Unnamed service';
      for (const mount of splitLines(service.volumes)) {
        const source = volumeMountSource(mount);
        if (source && isHostVolumeSource(source)) {
          mounts.push({ service: serviceName, mount });
        }
      }
    }

    return mounts;
  });
  protected readonly builderDiagnostics = computed(() => this.buildBuilderDiagnostics());
  private readonly globalDefaults = signal<GlobalSettings>({
    dataRoot: '/root/docker-apps',
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
    notifications: {
      enabled: false,
      events: {
        deploymentStarted: true,
        deploymentSucceeded: true,
        deploymentFailed: true,
        serviceDown: true,
      },
      channels: [],
    },
  });

  protected readonly form = this.fb.group({
    name: ['', [Validators.required, Validators.pattern(/^[a-zA-Z0-9._-]+$/)]],
    serverId: ['local', [Validators.required]],
    repositoryUrl: [''],
    token: [''],
    deployToken: [''],
    deploymentStrategy: ['compose' as DeploymentStrategy],
    registryPublish: [false],
    registryDeployFromRegistry: [false],
    registryImageNamespace: [''],
    registryImageTag: ['latest'],
    path: [''],
    composeOverride: [''],
    traefikEnabled: [false],
    traefikHostname: [''],
    traefikService: [''],
    traefikPort: ['3000'],
    traefikEntryPoints: ['websecure'],
    traefikCertResolver: ['letsencrypt'],
    traefikNetwork: ['proxy'],
    traefikWildcardCertificate: [false],
    traefikWildcardDomain: [''],
    traefikWebsocket: [false],
    traefikRemovePublishedPorts: [true],
  });

  private patchedProjectName = '';
  private currentProjectRef = '';
  private nextBuilderId = 1;

  constructor() {
    this.form.controls.traefikEnabled.valueChanges.pipe(takeUntilDestroyed()).subscribe((enabled) => {
      this.traefikEnabled.set(enabled);
    });
    this.form.controls.traefikWildcardCertificate.valueChanges.pipe(takeUntilDestroyed()).subscribe((enabled) => {
      this.wildcardCertificate.set(enabled);
    });
    this.form.controls.deploymentStrategy.valueChanges.pipe(takeUntilDestroyed()).subscribe((strategy) => {
      this.deploymentStrategy.set(strategy === 'swarm' ? 'swarm' : 'compose');
    });
    this.form.controls.registryDeployFromRegistry.valueChanges.pipe(takeUntilDestroyed()).subscribe((enabled) => {
      this.registryDeployFromRegistry.set(enabled);
    });
    this.form.controls.repositoryUrl.valueChanges.pipe(takeUntilDestroyed()).subscribe((repositoryUrl) => {
      this.repositoryUrl.set(repositoryUrl);
    });
    for (const control of [
      this.form.controls.traefikHostname,
      this.form.controls.traefikService,
      this.form.controls.traefikPort,
      this.form.controls.traefikNetwork,
    ]) {
      control.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => {
        this.traefikFormRevision.update((revision) => revision + 1);
      });
    }
    this.form.controls.serverId.valueChanges.pipe(takeUntilDestroyed()).subscribe((serverId) => {
      this.selectedServerId.set(serverId || 'local');
      this.selectedServerIds.update((serverIds) => ensureServerSelected(serverIds, serverId || 'local'));
    });
    this.form.controls.name.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => {
      this.loadVaultSecrets();
    });

    effect(() => {
      if (this.isNew()) {
        return;
      }

      const project = this.store.selectedProject();
      if (project?.name === this.currentName() && this.patchedProjectName !== project.name) {
        this.patchFromProject(project);
      }
    });

  }

  ngOnInit() {
    this.store.loadServers();

    this.api.getGlobalSettings().subscribe({
      next: (settings) => {
        this.globalDefaults.set(settings);
        if (this.isNew()) {
          this.resetForNewProject();
        }
      },
    });

    this.route.paramMap.subscribe((params) => {
      const projectRef = params.get('name');

      this.message.set('');
      this.error.set('');
      this.composeInspection.set(null);
      this.composeValidation.set(null);
      this.traefikDiagnostics.set(null);

      if (!projectRef) {
        this.isNew.set(true);
        this.currentName.set('');
        this.currentProjectRef = '';
        this.store.selectProject('');
        this.resetForNewProject();
        this.loadVaultSecrets();
        return;
      }

      this.isNew.set(false);
      this.currentProjectRef = projectRef;
      this.store.selectProject(projectRef);
      this.currentName.set(this.currentProject()?.name ?? projectRef);
      this.patchedProjectName = '';
      this.selectedServerId.set(this.currentProject()?.serverId ?? this.form.controls.serverId.value ?? 'local');
      this.loadVaultSecrets();
    });
  }

  protected async save(mode: 'save' | 'deploy') {
    this.message.set('');
    this.error.set('');

    if (this.form.invalid) {
      this.form.markAllAsTouched();
      this.error.set('Repository name is required and can only use letters, numbers, dots, underscores, and hyphens.');
      return;
    }

    this.saving.set(mode);

    try {
      const payload = this.toPayload();
      if (!payload) {
        return;
      }
      const result = this.isNew()
        ? await firstValueFrom(this.api.createProject(payload))
        : await firstValueFrom(this.api.updateProject(this.currentProjectRef || this.currentName(), payload));
      const savedId = result.id || this.currentProjectRef;
      const savedName = result.name || payload.name;

      this.currentProjectRef = savedId;
      this.store.selectProject(savedId);
      this.store.loadProjects();

      if (mode === 'deploy') {
        this.message.set(`Saving ${savedName} and validating compose...`);
        const validation = await firstValueFrom(this.api.validateCompose(savedId));
        this.composeValidation.set(validation);
        if (!validation.valid) {
          this.error.set(validation.error || 'Docker Compose validation failed.');
          this.builderSection.set('services');
          return;
        }

        this.message.set(`Compose is valid. Starting deployment for ${savedName}...`);
        await firstValueFrom(this.api.deployProject(savedId));
      }

      await this.router.navigate(['/projects', savedId, 'overview']);
    } catch (error) {
      this.error.set(this.readApiError(error));
    } finally {
      this.saving.set('');
    }
  }

  protected exportProject() {
    const projectRef = this.currentProjectRef || this.currentProject()?.id || this.currentName();
    const projectName = this.currentProject()?.name || this.currentName() || 'project';
    if (this.isNew() || !projectRef) {
      this.error.set('Save the project before exporting it.');
      return;
    }

    this.message.set('');
    this.error.set('');
    this.exportingProject.set(true);
    this.api.exportProject(projectRef).subscribe({
      next: (content) => {
        const blob = new Blob([content], { type: 'application/yaml' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${projectName}.deploy.compose.yml`;
        link.click();
        URL.revokeObjectURL(url);
        this.message.set('Project export downloaded.');
        this.exportingProject.set(false);
      },
      error: (error) => {
        this.error.set(error?.error?.error || 'Could not export project.');
        this.exportingProject.set(false);
      },
    });
  }

  protected importProjectFile(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) {
      return;
    }

    this.message.set('');
    this.error.set('');
    this.importingProject.set(true);

    const reader = new FileReader();
    reader.onload = () => {
      this.api.importProjectCompose(String(reader.result || '')).subscribe({
        next: (payload) => {
          this.applyImportedProjectPayload(payload);
          this.message.set('Project compose imported. Review the settings, then save.');
          this.importingProject.set(false);
        },
        error: (error) => {
          this.error.set(error?.error?.error || 'Could not import project compose file.');
          this.importingProject.set(false);
        },
      });
    };
    reader.onerror = () => {
      this.error.set('Could not read project compose file.');
      this.importingProject.set(false);
    };
    reader.readAsText(file);
  }

  protected cancel() {
    const projectRef = this.currentProjectRef || this.currentProject()?.id;
    void this.router.navigate(projectRef ? ['/projects', projectRef, 'overview'] : ['/projects']);
  }

  protected importCompose() {
    this.message.set('');
    this.error.set('');

    if (this.isNew()) {
      this.error.set('Save the project before importing compose from its repository.');
      return;
    }

    this.importingCompose.set(true);
    this.api.importCompose(this.currentProjectRef).subscribe({
      next: (result) => {
        this.form.controls.composeOverride.setValue(result.compose);
        this.loadBuilderFromComposeOverride();
        this.composeMode.set('yaml');
        this.message.set(`Imported ${result.composeFile}. Review the override and save the project.`);
        this.importingCompose.set(false);
      },
      error: (error) => {
        this.error.set(error?.error?.error || 'Could not import Docker Compose file.');
        this.importingCompose.set(false);
      },
    });
  }

  protected inspectCompose() {
    this.message.set('');
    this.error.set('');

    if (this.isNew()) {
      this.error.set('Save the project before inspecting compose settings.');
      return;
    }

    this.inspectingCompose.set(true);
    this.composeInspection.set(null);
    this.api.inspectCompose(this.currentProjectRef).subscribe({
      next: (inspection) => {
        this.composeInspection.set(inspection);
        this.message.set(`Inspected ${inspection.composeFile}. Use a detected service for Traefik or review storage mounts.`);
        this.inspectingCompose.set(false);
      },
      error: (error) => {
        this.error.set(error?.error?.error || 'Could not inspect Docker Compose file.');
        this.inspectingCompose.set(false);
      },
    });
  }

  protected validateCompose() {
    this.message.set('');
    this.error.set('');

    if (this.isNew()) {
      this.error.set('Save the project before validating compose.');
      return;
    }

    if (this.form.invalid) {
      this.form.markAllAsTouched();
      this.error.set('Repository name is required and can only use letters, numbers, dots, underscores, and hyphens.');
      return;
    }

    const payload = this.toPayload();
    if (!payload) {
      return;
    }

    this.validatingCompose.set(true);
    this.composeValidation.set(null);
    this.api.validateCompose(this.currentProjectRef, payload).subscribe({
      next: (validation) => {
        this.composeValidation.set(validation);
        this.message.set(validation.valid ? 'Docker Compose validation passed.' : 'Docker Compose validation failed.');
        this.validatingCompose.set(false);
      },
      error: (error) => {
        this.error.set(error?.error?.error || 'Could not validate Docker Compose file.');
        this.validatingCompose.set(false);
      },
    });
  }

  protected diagnoseTraefik() {
    this.message.set('');
    this.error.set('');

    if (this.isNew()) {
      this.error.set('Save the project before running Traefik diagnostics.');
      return;
    }

    this.diagnosingTraefik.set(true);
    this.traefikDiagnostics.set(null);
    this.api.diagnoseTraefik(this.currentProjectRef).subscribe({
      next: (diagnostics) => {
        this.traefikDiagnostics.set(diagnostics);
        this.diagnosingTraefik.set(false);
      },
      error: (error) => {
        this.error.set(error?.error?.error || 'Could not diagnose Traefik.');
        this.diagnosingTraefik.set(false);
      },
    });
  }

  protected applyTraefikTarget(service: ComposeServiceInspection) {
    const port = this.primaryServicePort(service);
    this.form.controls.traefikService.setValue(service.name);
    if (port) {
      this.form.controls.traefikPort.setValue(port);
    }
    this.form.controls.traefikEnabled.setValue(true);
    this.message.set(`Traefik target set to ${service.name}${port ? ` on port ${port}` : ''}.`);
  }

  protected serverSelected(serverId: string) {
    return this.selectedServerIds().includes(serverId);
  }

  protected toggleServerTarget(serverId: string, event: Event) {
    const checked = (event.target as HTMLInputElement).checked;
    const current = this.selectedServerIds();
    const next = checked
      ? ensureServerSelected(current, serverId)
      : current.filter((id) => id !== serverId);
    const normalized = next.length ? next : [this.form.controls.serverId.value || 'local'];
    this.selectedServerIds.set(normalized);
    if (!normalized.includes(this.form.controls.serverId.value)) {
      this.form.controls.serverId.setValue(normalized[0] || 'local');
    }
  }

  protected primaryServicePort(service: ComposeServiceInspection) {
    return service.ports[0]?.target || service.expose[0] || '';
  }

  protected servicePortsLabel(service: ComposeServiceInspection) {
    if (service.ports.length) {
      return service.ports.map((port) => port.raw).join(', ');
    }

    return service.expose.length ? `expose ${service.expose.join(', ')}` : 'no ports';
  }

  protected serviceMountsLabel(service: ComposeServiceInspection) {
    return service.mounts.length
      ? service.mounts.map((mount) => `${mount.source || '(anonymous)'} -> ${mount.target || '(no target)'}`).join(', ')
      : 'no mounts';
  }

  protected setComposeMode(mode: 'builder' | 'yaml') {
    this.composeMode.set(mode);
  }

  protected setBuilderSection(section: 'services' | 'secrets' | 'networks' | 'volumes' | 'traefik') {
    this.builderSection.set(section);
  }

  protected addBuilderService() {
    const currentServices = this.builderServices();
    const index = currentServices.length + 1;
    const shouldCreateAppNetwork = index > 1 && this.builderNetworks().length === 0;
    const serviceNetwork = this.builderNetworks()[0]?.name || (shouldCreateAppNetwork ? 'app' : '');

    if (shouldCreateAppNetwork) {
      this.addBuilderNetwork('app');
    }

    this.builderServices.update((services) => [
      ...services.map((service) => service.networks || service.networkMode ? service : { ...service, networks: serviceNetwork }),
      {
        id: this.nextBuilderId++,
        name: index === 1 ? 'app' : `service-${index}`,
        image: '',
        build: index === 1 ? '.' : '',
        dockerfile: '',
        buildTarget: '',
        containerName: '',
        command: '',
        restart: 'unless-stopped',
        networkMode: '',
        init: false,
        healthcheckMode: '',
        healthcheckHttpUrl: 'http://localhost:3000/health',
        healthcheckCommand: '',
        healthcheckInterval: '30s',
        healthcheckTimeout: '10s',
        healthcheckRetries: '3',
        healthcheckStartPeriod: '40s',
        healthcheckExtra: '',
        ports: '',
        expose: '',
        environment: '',
        secretEnvironment: [],
        secretHelperCommand: '',
        volumes: '',
        networks: serviceNetwork,
        dependsOn: '',
        dependsOnAdvanced: '',
        deployMode: '',
        deployReplicas: '',
        deployPlacementConstraints: '',
        deployAdvanced: '',
        deployLabels: '',
        profiles: '',
        extra: ''
      }
    ]);
  }

  protected removeBuilderService(id: number) {
    this.builderServices.update((services) => services.filter((service) => service.id !== id));
  }

  protected canRemoveBuilderService(service: ComposeBuilderService) {
    return this.builderServices().length > 1 && this.builderServiceReferences().get(service.name.trim()) === undefined;
  }

  protected serviceRemoveReason(service: ComposeBuilderService) {
    if (this.builderServices().length === 1) {
      return 'At least one service is required.';
    }

    const refs = this.builderServiceReferences().get(service.name.trim()) ?? [];
    return refs.length ? `Referenced by ${refs.join(', ')}.` : '';
  }

  protected updateBuilderService(id: number, field: keyof ComposeBuilderService, event: Event) {
    if (this.isBuildField(field) && this.buildFieldDisabled()) {
      return;
    }

    const target = event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    const value = field === 'init' && target instanceof HTMLInputElement ? target.checked : target.value;
    this.builderServices.update((services) => services.map((service) => service.id === id ? { ...service, [field]: value } : service));
  }

  protected visibleBuildFieldValue(service: ComposeBuilderService, field: 'build' | 'dockerfile' | 'buildTarget') {
    return this.buildContextAvailable() ? service[field] : '';
  }

  protected toggleBuilderServiceListValue(id: number, field: 'networks' | 'dependsOn', item: string, event: Event) {
    const target = event.target as HTMLInputElement;
    this.builderServices.update((services) => services.map((service) => {
      if (service.id !== id) {
        return service;
      }

      const items = splitLines(service[field]).filter((value) => value !== item);
      return {
        ...service,
        [field]: target.checked ? [...items, item].join('\n') : items.join('\n')
      };
    }));
  }

  protected isBuilderServiceListValueSelected(service: ComposeBuilderService, field: 'networks' | 'dependsOn', item: string) {
    return splitLines(service[field]).includes(item);
  }

  protected builderServiceListItems(service: ComposeBuilderService, field: ComposeBuilderListField) {
    return splitLines(service[field]);
  }

  protected builderVolumeMountEntries(service: ComposeBuilderService) {
    return parseVolumeMountEntries(service.volumes, this.builderVolumes().map((volume) => volume.name.trim()).filter(Boolean));
  }

  protected addBuilderNamedVolumeMount(serviceId: number, source?: string) {
    const firstVolume = source || this.builderVolumes().find((volume) => volume.name.trim())?.name.trim();
    if (!firstVolume) {
      this.addBuilderVolume('data');
      this.addBuilderVolumeMount(serviceId, { kind: 'volume', source: 'data', target: '/data', mode: '' });
      return;
    }

    this.addBuilderVolumeMount(serviceId, { kind: 'volume', source: firstVolume, target: '/data', mode: '' });
  }

  protected addBuilderBindMount(serviceId: number) {
    this.addBuilderVolumeMount(serviceId, { kind: 'bind', source: './data', target: '/data', mode: '' });
  }

  protected updateBuilderVolumeMountEntry(id: number, index: number, field: keyof ComposeVolumeMountEntry, event: Event) {
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    this.updateBuilderVolumeMountEntryValue(id, index, field, target.value);
  }

  protected toggleHostPathBrowser(serviceId: number, index: number, source: string) {
    const current = this.hostPathBrowser();
    if (current?.serviceId === serviceId && current.index === index) {
      this.closeHostPathBrowser();
      return;
    }

    this.browseHostPath(serviceId, index, this.hostBrowseStartPath(source));
  }

  private hostBrowseStartPath(source: string) {
    return normalizeHostBrowseStart(source, this.projectRootPath());
  }

  private projectRootPath() {
    const configuredPath = this.form.controls.path.value.trim();
    if (configuredPath) {
      return configuredPath;
    }

    const projectName = this.form.controls.name.value.trim() || this.currentName().trim();
    if (!projectName) {
      return this.globalDefaults().dataRoot;
    }

    return `${this.globalDefaults().dataRoot.replace(/\/+$/, '')}/${projectName}`;
  }

  protected closeHostPathBrowser() {
    this.hostPathBrowser.set(null);
    this.hostPathBrowserError.set('');
  }

  protected closeHostPathBrowserFromBackdrop(event: MouseEvent) {
    if (event.target !== event.currentTarget) {
      return;
    }

    this.closeHostPathBrowser();
  }

  protected browseHostPath(serviceId: number, index: number, path: string) {
    const serverId = this.form.controls.serverId.value || 'local';
    this.hostPathBrowserError.set('');
    this.browsingHostPath.set(true);
    this.api.browseServerPath(serverId, path || '/').subscribe({
      next: (result) => {
        this.hostPathBrowser.set({ serviceId, index, result });
        this.browsingHostPath.set(false);
      },
      error: (error) => {
        this.hostPathBrowserError.set(error?.error?.error || 'Could not browse this host path.');
        this.browsingHostPath.set(false);
      },
    });
  }

  protected hostPathBrowserFor(serviceId: number, index: number) {
    const browser = this.hostPathBrowser();
    return browser?.serviceId === serviceId && browser.index === index ? browser.result : null;
  }

  protected selectHostPath(serviceId: number, index: number, path: string) {
    this.updateBuilderVolumeMountEntryValue(serviceId, index, 'source', path);
    this.hostPathBrowser.set(null);
    this.hostPathBrowserError.set('');
  }

  private updateBuilderVolumeMountEntryValue(id: number, index: number, field: keyof ComposeVolumeMountEntry, value: string) {
    this.builderServices.update((services) => services.map((service) => {
      if (service.id !== id) {
        return service;
      }

      const entries = parseVolumeMountEntries(service.volumes, this.builderVolumes().map((volume) => volume.name.trim()).filter(Boolean));
      const current = entries[index] ?? { kind: 'bind' as const, source: '', target: '', mode: '' };
      const next = { ...current, [field]: value };
      if (field === 'kind') {
        next.source = value === 'volume'
          ? this.builderVolumes().find((volume) => volume.name.trim())?.name.trim() || ''
          : './data';
      }
      entries[index] = next;
      return { ...service, volumes: renderVolumeMountEntries(entries) };
    }));
  }

  protected removeBuilderVolumeMountEntry(id: number, index: number) {
    this.removeBuilderServiceListItem(id, 'volumes', index);
  }

  protected addBuilderServiceListItem(id: number, field: ComposeBuilderListField, value = '') {
    this.builderServices.update((services) => services.map((service) => {
      if (service.id !== id) {
        return service;
      }

      return { ...service, [field]: [...splitLines(service[field]), value].join('\n') };
    }));
  }

  protected updateBuilderServiceListItem(id: number, field: ComposeBuilderListField, index: number, event: Event) {
    const target = event.target as HTMLInputElement;
    this.builderServices.update((services) => services.map((service) => {
      if (service.id !== id) {
        return service;
      }

      const items = splitLines(service[field]);
      items[index] = target.value;
      return { ...service, [field]: items.join('\n') };
    }));
  }

  protected removeBuilderServiceListItem(id: number, field: ComposeBuilderListField, index: number) {
    this.builderServices.update((services) => services.map((service) => {
      if (service.id !== id) {
        return service;
      }

      const items = splitLines(service[field]);
      items.splice(index, 1);
      return { ...service, [field]: items.join('\n') };
    }));
  }

  private addBuilderVolumeMount(id: number, entry: ComposeVolumeMountEntry) {
    this.builderServices.update((services) => services.map((service) => {
      if (service.id !== id) {
        return service;
      }

      return { ...service, volumes: renderVolumeMountEntries([...parseVolumeMountEntries(service.volumes, this.builderVolumes().map((volume) => volume.name.trim()).filter(Boolean)), entry]) };
    }));
  }

  protected builderEnvironmentEntries(service: ComposeBuilderService): ComposeEnvironmentEntry[] {
    const entries = parseEnvironmentEntries(service.environment);
    return service.environment.endsWith('\n') ? [...entries, { key: '', value: '' }] : entries;
  }

  protected addBuilderEnvironmentEntry(id: number) {
    this.builderServices.update((services) => services.map((service) => {
      if (service.id !== id) {
        return service;
      }

      const current = service.environment.trimEnd();
      return { ...service, environment: current ? `${current}\n` : '\n' };
    }));
  }

  protected updateBuilderEnvironmentEntry(id: number, index: number, field: keyof ComposeEnvironmentEntry, event: Event) {
    const target = event.target as HTMLInputElement;
    this.builderServices.update((services) => services.map((service) => {
      if (service.id !== id) {
        return service;
      }

      const entries = parseEnvironmentEntries(service.environment);
      if (field === 'key' && target.value.includes('=')) {
        const [key, ...rest] = target.value.split('=');
        entries[index] = { key: key.trim(), value: rest.join('=').trim() };
      } else {
        entries[index] = { ...(entries[index] ?? { key: '', value: '' }), [field]: target.value };
      }
      return { ...service, environment: renderEnvironmentEntries(entries) };
    }));
  }

  protected removeBuilderEnvironmentEntry(id: number, index: number) {
    this.builderServices.update((services) => services.map((service) => {
      if (service.id !== id) {
        return service;
      }

      const entries = parseEnvironmentEntries(service.environment);
      entries.splice(index, 1);
      return { ...service, environment: renderEnvironmentEntries(entries) };
    }));
  }

  protected builderSecretCount() {
    return this.settingsState.builderSecretCount();
  }

  protected projectSecretNamespace() {
    return this.form.controls.name.value.trim() || this.currentName().trim() || 'project';
  }

  protected addBuilderNetwork(name = 'app', external = false) {
    this.builderNetworks.update((networks) => [
      ...networks,
      { id: this.nextBuilderId++, name: uniqueBuilderName(name, networks.map((network) => network.name)), external, driver: '', extra: '' }
    ]);
  }

  protected addDetectedTraefikNetwork(name: string, serviceId?: number) {
    this.addBuilderNetwork(name, true);
    if (serviceId !== undefined) {
      this.builderServices.update((services) => services.map((service) => service.id === serviceId ? { ...service, networks: addListValue(service.networks, name) } : service));
    }
    if (!this.form.controls.traefikNetwork.value.trim() || !this.builderNetworkNames().includes(this.form.controls.traefikNetwork.value.trim())) {
      this.form.controls.traefikNetwork.setValue(name);
      this.traefikFormRevision.update((revision) => revision + 1);
    }
  }

  protected removeBuilderNetwork(id: number) {
    this.builderNetworks.update((networks) => networks.filter((network) => network.id !== id));
  }

  protected detachAndRemoveBuilderNetwork(network: ComposeBuilderNetwork) {
    const name = network.name.trim();
    if (!name) {
      this.removeBuilderNetwork(network.id);
      return;
    }

    this.builderServices.update((services) => services.map((service) => ({
      ...service,
      networks: removeListValue(service.networks, name),
    })));
    if (this.form.controls.traefikNetwork.value.trim() === name) {
      this.form.controls.traefikNetwork.setValue('');
      this.traefikFormRevision.update((revision) => revision + 1);
    }
    this.removeBuilderNetwork(network.id);
  }

  protected canRemoveBuilderNetwork(network: ComposeBuilderNetwork) {
    return this.builderNetworkReferences().get(network.name.trim()) === undefined;
  }

  protected networkRemoveReason(network: ComposeBuilderNetwork) {
    const refs = this.builderNetworkReferences().get(network.name.trim()) ?? [];
    return refs.length ? `Referenced by ${refs.join(', ')}.` : '';
  }

  protected updateBuilderNetwork(id: number, field: keyof ComposeBuilderNetwork, event: Event) {
    const target = event.target as HTMLInputElement;
    const value = field === 'external' ? target.checked : target.value;
    const previousName = this.builderNetworks().find((network) => network.id === id)?.name.trim() ?? '';
    this.builderNetworks.update((networks) => networks.map((network) => network.id === id ? { ...network, [field]: value } : network));
    if (field === 'name' && typeof value === 'string') {
      this.renameBuilderNetworkReferences(previousName, value.trim());
    }
  }

  private renameBuilderNetworkReferences(previousName: string, nextName: string) {
    if (!previousName || !nextName || previousName === nextName) {
      return;
    }

    this.builderServices.update((services) => services.map((service) => ({
      ...service,
      networks: replaceListValue(service.networks, previousName, nextName),
    })));

    if (this.form.controls.traefikNetwork.value.trim() === previousName) {
      this.form.controls.traefikNetwork.setValue(nextName, { emitEvent: false });
      this.traefikFormRevision.update((revision) => revision + 1);
    }
  }

  protected addBuilderVolume(name = 'data') {
    this.builderVolumes.update((volumes) => [
      ...volumes,
      { id: this.nextBuilderId++, name: uniqueBuilderName(name, volumes.map((volume) => volume.name)), external: false, driver: '', driverOpts: [], extra: '' }
    ]);
  }

  protected removeBuilderVolume(id: number) {
    this.builderVolumes.update((volumes) => volumes.filter((volume) => volume.id !== id));
  }

  protected canRemoveBuilderVolume(volume: ComposeBuilderVolume) {
    return this.builderVolumeReferences().get(volume.name.trim()) === undefined;
  }

  protected volumeRemoveReason(volume: ComposeBuilderVolume) {
    const refs = this.builderVolumeReferences().get(volume.name.trim()) ?? [];
    return refs.length ? `Referenced by ${refs.join(', ')}.` : '';
  }

  protected updateBuilderVolume(id: number, field: keyof ComposeBuilderVolume, event: Event) {
    const target = event.target as HTMLInputElement;
    const value = field === 'external' ? target.checked : target.value;
    this.builderVolumes.update((volumes) => volumes.map((volume) => volume.id === id ? { ...volume, [field]: value } : volume));
  }

  protected addBuilderVolumeDriverOpt(id: number, key = 'type', value = 'nfs') {
    this.builderVolumes.update((volumes) => volumes.map((volume) => volume.id === id ? { ...volume, driverOpts: [...volume.driverOpts, { key, value }] } : volume));
  }

  protected addNfsVolumeDriverOpts(id: number) {
    this.builderVolumes.update((volumes) => volumes.map((volume) => {
      if (volume.id !== id) {
        return volume;
      }

      const existing = new Set(volume.driverOpts.map((entry) => entry.key.trim()).filter(Boolean));
      const additions = [
        { key: 'type', value: 'nfs' },
        { key: 'o', value: 'addr=192.168.178.22,rw,nolock,soft,nfsvers=4' },
        { key: 'device', value: ':/export/sharename' }
      ].filter((entry) => !existing.has(entry.key));
      return { ...volume, driver: volume.driver || 'local', driverOpts: [...volume.driverOpts, ...additions] };
    }));
  }

  protected updateBuilderVolumeDriverOpt(id: number, index: number, field: keyof ComposeKeyValueEntry, event: Event) {
    const target = event.target as HTMLInputElement;
    this.builderVolumes.update((volumes) => volumes.map((volume) => {
      if (volume.id !== id) {
        return volume;
      }

      const driverOpts = [...volume.driverOpts];
      driverOpts[index] = { ...(driverOpts[index] ?? { key: '', value: '' }), [field]: target.value };
      return { ...volume, driverOpts };
    }));
  }

  protected removeBuilderVolumeDriverOpt(id: number, index: number) {
    this.builderVolumes.update((volumes) => volumes.map((volume) => {
      if (volume.id !== id) {
        return volume;
      }

      const driverOpts = [...volume.driverOpts];
      driverOpts.splice(index, 1);
      return { ...volume, driverOpts };
    }));
  }

  protected generateComposeOverride() {
    if (this.builderServices().length === 0) {
      this.addBuilderService();
    }
    this.normalizeBuilderTraefikRefs();

    this.form.controls.composeOverride.setValue(renderComposeBuilder(
      this.builderServices(),
      this.builderNetworks(),
      this.builderVolumes(),
      this.currentTraefikComposeSettings(),
      { registryDeployFromRegistry: this.form.controls.registryDeployFromRegistry.value, allowBuild: Boolean(this.form.controls.repositoryUrl.value.trim()) }
    ));
    this.composeMode.set('yaml');
    this.message.set('Compose override generated. Review it, then save the project.');
  }

  protected resetComposeBuilder() {
    this.builderServices.set([]);
    this.builderNetworks.set([]);
    this.builderVolumes.set([]);
    this.addBuilderService();
    this.addBuilderVolume();
  }

  protected loadBuilderFromComposeOverride() {
    const parsed = parseComposeBuilder(this.form.controls.composeOverride.value);
    if (!parsed) {
      this.message.set('The current override uses Compose options the builder cannot safely edit. The raw YAML is unchanged.');
      return;
    }

    this.nextBuilderId = 1;
    this.builderServices.set(parsed.services.map((service) => ({ ...service, id: this.nextBuilderId++ })));
    this.builderNetworks.set(parsed.networks.map((network) => ({ ...network, id: this.nextBuilderId++ })));
    this.builderVolumes.set(parsed.volumes.map((volume) => ({ ...volume, id: this.nextBuilderId++ })));
    if (this.builderServices().length === 0) {
      this.addBuilderService();
    }
    this.message.set('Compose builder loaded from the current override.');
    this.composeMode.set('builder');
  }

  private loadBuilderFromCompose(compose: string) {
    const parsed = parseComposeBuilder(compose);
    if (!parsed) {
      this.resetComposeBuilder();
      if (compose.trim()) {
        this.composeMode.set('yaml');
      }
      return;
    }

    this.nextBuilderId = 1;
    this.builderServices.set(parsed.services.map((service) => ({ ...service, id: this.nextBuilderId++ })));
    this.builderNetworks.set(parsed.networks.map((network) => ({ ...network, id: this.nextBuilderId++ })));
    this.builderVolumes.set(parsed.volumes.map((volume) => ({ ...volume, id: this.nextBuilderId++ })));
    if (this.builderServices().length === 0) {
      this.addBuilderService();
    }
  }

  private applyImportedProjectPayload(payload: ProjectPayload) {
    const projectName = payload.project?.name ?? payload.name ?? '';
    const serverIds = payload.project?.serverIds?.length ? payload.project.serverIds : payload.serverIds?.length ? payload.serverIds : [payload.project?.serverId ?? payload.serverId ?? 'local'];
    const traefik = payload.traefik ?? { enabled: payload.traefikEnabled };
    const composeOverride = payload.compose?.override ?? payload.composeOverride ?? '';
    const deploymentStrategy = payload.deployment?.strategy ?? payload.deploymentStrategy ?? 'compose';
    const registry = payload.registry ?? {
      publish: Boolean(payload.registryPublish),
      deployFromRegistry: Boolean(payload.registryDeployFromRegistry),
      imageNamespace: payload.registryImageNamespace,
      imageTag: payload.registryImageTag,
    };

    this.form.reset({
      name: projectName,
      serverId: serverIds[0] ?? 'local',
      repositoryUrl: payload.git?.repositoryUrl ?? payload.repositoryUrl ?? '',
      token: '',
      deployToken: '',
      deploymentStrategy: deploymentStrategy === 'swarm' ? 'swarm' : 'compose',
      registryPublish: Boolean(registry.publish),
      registryDeployFromRegistry: Boolean(registry.deployFromRegistry),
      registryImageNamespace: registry.imageNamespace ?? '',
      registryImageTag: registry.imageTag ?? 'latest',
      path: payload.project?.path ?? payload.path ?? '',
      composeOverride,
      traefikEnabled: Boolean(traefik.enabled),
      traefikHostname: traefik.hostname ?? payload.traefikHostname ?? '',
      traefikService: traefik.service ?? payload.traefikService ?? '',
      traefikPort: traefik.port ? String(traefik.port) : payload.traefikPort || '3000',
      traefikEntryPoints: traefik.entryPoints ?? payload.traefikEntryPoints ?? this.globalDefaults().defaultTraefikEntryPoints,
      traefikCertResolver: traefik.certResolver ?? payload.traefikCertResolver ?? this.globalDefaults().defaultTraefikCertResolver,
      traefikNetwork: traefik.network ?? payload.traefikNetwork ?? this.globalDefaults().defaultTraefikNetwork,
      traefikWildcardCertificate: Boolean(traefik.wildcardCertificate ?? payload.traefikWildcardCertificate),
      traefikWildcardDomain: traefik.wildcardDomain ?? payload.traefikWildcardDomain ?? '',
      traefikWebsocket: Boolean(traefik.websocket ?? payload.traefikWebsocket),
      traefikRemovePublishedPorts: traefik.removePublishedPorts ?? payload.traefikRemovePublishedPorts ?? true,
    });
    this.traefikEnabled.set(Boolean(traefik.enabled));
    this.wildcardCertificate.set(Boolean(traefik.wildcardCertificate ?? payload.traefikWildcardCertificate));
    this.deploymentStrategy.set(deploymentStrategy === 'swarm' ? 'swarm' : 'compose');
    this.registryDeployFromRegistry.set(Boolean(registry.deployFromRegistry));
    this.repositoryUrl.set(payload.git?.repositoryUrl ?? payload.repositoryUrl ?? '');
    this.selectedServerId.set(this.form.controls.serverId.value || 'local');
    this.selectedServerIds.set(ensureServerSelected(serverIds, this.form.controls.serverId.value || 'local'));
    this.loadBuilderFromCompose(composeOverride);
    this.composeMode.set('builder');
    this.traefikFormRevision.update((revision) => revision + 1);
    this.applyProjectEnvSecrets(payload.compose?.envSecrets ?? payload.envSecrets ?? []);
  }

  private resetForNewProject() {
    this.patchedProjectName = '';
    this.traefikEnabled.set(false);
    this.wildcardCertificate.set(false);
    this.form.reset({
      name: '',
      serverId: this.servers()[0]?.id ?? 'local',
      repositoryUrl: '',
      token: '',
      deployToken: '',
      deploymentStrategy: 'compose',
      registryPublish: false,
      registryDeployFromRegistry: false,
      registryImageNamespace: '',
      registryImageTag: 'latest',
      path: '',
      composeOverride: '',
      traefikEnabled: false,
      traefikHostname: '',
      traefikService: '',
      traefikPort: '3000',
      traefikEntryPoints: this.globalDefaults().defaultTraefikEntryPoints,
      traefikCertResolver: this.globalDefaults().defaultTraefikCertResolver,
      traefikNetwork: this.globalDefaults().defaultTraefikNetwork,
      traefikWildcardCertificate: false,
      traefikWildcardDomain: '',
      traefikWebsocket: false,
      traefikRemovePublishedPorts: true,
    });
    this.deploymentStrategy.set('compose');
    this.registryDeployFromRegistry.set(false);
    this.repositoryUrl.set('');
    this.selectedServerId.set(this.form.controls.serverId.value || 'local');
    this.selectedServerIds.set([this.form.controls.serverId.value || 'local']);
    this.resetComposeBuilder();
  }

  private patchFromProject(project: ProjectSummary) {
    const traefik = project.traefik ?? { enabled: false };
    const projectSection = project.project;
    const gitSection = project.git;
    const deploymentSection = project.deployment;
    const composeSection = project.compose;
    const registry = project.registry ?? { publish: false, deployFromRegistry: false };
    const serverIds = projectSection?.serverIds?.length ? projectSection.serverIds : project.serverIds?.length ? project.serverIds : [projectSection?.serverId ?? project.serverId ?? 'local'];
    this.patchedProjectName = project.name;
    this.traefikEnabled.set(Boolean(traefik.enabled));
    this.wildcardCertificate.set(Boolean(traefik.wildcardCertificate));
    const deploymentStrategy = deploymentSection?.strategy ?? project.deploymentStrategy ?? 'compose';
    this.form.reset({
      name: projectSection?.name ?? project.name,
      serverId: serverIds[0] ?? 'local',
      repositoryUrl: gitSection?.repositoryUrl ?? project.repositoryUrl ?? '',
      token: '',
      deployToken: '',
      deploymentStrategy,
      registryPublish: Boolean(registry.publish),
      registryDeployFromRegistry: Boolean(registry.deployFromRegistry),
      registryImageNamespace: registry.imageNamespace ?? '',
      registryImageTag: registry.imageTag ?? 'latest',
      path: projectSection?.path ?? project.path ?? '',
      composeOverride: composeSection?.override ?? project.composeOverride ?? '',
      traefikEnabled: Boolean(traefik.enabled),
      traefikHostname: traefik.hostname ?? '',
      traefikService: traefik.service ?? '',
      traefikPort: traefik.port ? String(traefik.port) : '3000',
      traefikEntryPoints: traefik.entryPoints ?? this.globalDefaults().defaultTraefikEntryPoints,
      traefikCertResolver: traefik.certResolver ?? this.globalDefaults().defaultTraefikCertResolver,
      traefikNetwork: traefik.network ?? this.globalDefaults().defaultTraefikNetwork,
      traefikWildcardCertificate: Boolean(traefik.wildcardCertificate),
      traefikWildcardDomain: traefik.wildcardDomain ?? '',
      traefikWebsocket: Boolean(traefik.websocket),
      traefikRemovePublishedPorts: traefik.removePublishedPorts !== false,
    });
    this.deploymentStrategy.set(deploymentStrategy === 'swarm' ? 'swarm' : 'compose');
    this.registryDeployFromRegistry.set(Boolean(registry.deployFromRegistry));
    this.repositoryUrl.set(gitSection?.repositoryUrl ?? project.repositoryUrl ?? '');
    this.selectedServerId.set(this.form.controls.serverId.value || 'local');
    this.selectedServerIds.set(ensureServerSelected(serverIds, this.form.controls.serverId.value || 'local'));
    this.loadBuilderFromCompose(composeSection?.override ?? project.composeOverride ?? '');
    this.applyProjectEnvSecrets(composeSection?.envSecrets ?? project.envSecrets ?? []);
  }

  private applyProjectEnvSecrets(secrets: ProjectEnvironmentSecret[]) {
    if (!secrets.length) {
      return;
    }

    this.builderServices.update((services) => services.map((service) => {
      const serviceSecrets = secrets.filter((secret) => secret.service === service.name);
      return {
        ...service,
        environment: removeGeneratedSecretFileEntries(service.environment, serviceSecrets),
        secretHelperCommand: serviceSecrets.find((secret) => secret.mode === 'docker_secret' && secret.exposure === 'env' && secret.helperCommand)?.helperCommand ?? '',
        secretEnvironment: serviceSecrets.map((secret) => ({
          key: secret.key,
          value: secret.value ?? '',
          mode: secret.source === 'vault' ? 'docker_secret' : secret.mode,
          source: secret.source === 'vault' ? 'vault' : 'inline',
          vaultSecretId: secret.vaultSecretId ?? '',
          exposure: secret.mode === 'docker_secret' && secret.exposure === 'env' ? 'env' : 'file'
        }))
      };
    }));
  }

  private loadVaultSecrets() {
    this.settingsState.setProjectName(this.projectSecretNamespace());
    this.settingsState.loadVaultSecrets();
  }

  private currentProject() {
    const projectRef = this.currentProjectRef || this.currentName();
    return this.store.projects().find((project) => project.id === projectRef || project.name === projectRef) ?? null;
  }

  private toPayload(): ProjectPayload | null {
    if (this.composeMode() === 'builder') {
      const diagnostics = this.builderDiagnostics();
      if (diagnostics.length) {
        this.error.set(diagnostics[0]);
        return null;
      }
    }
    const value = this.form.getRawValue();
    const serverIds = ensureServerSelected(this.selectedServerIds(), value.serverId.trim() || 'local');
    const deploymentStrategy = value.deploymentStrategy === 'swarm' ? 'swarm' : 'compose';
    const traefikSettings = this.currentTraefikComposeSettings();
    const traefikReferenceError = this.validateTraefikReferences(traefikSettings);
    if (traefikReferenceError) {
      this.error.set(traefikReferenceError);
      return null;
    }
    const composeOverride = this.composeMode() === 'builder'
      ? renderComposeBuilder(this.builderServices(), this.builderNetworks(), this.builderVolumes(), traefikSettings, { registryDeployFromRegistry: value.registryDeployFromRegistry, allowBuild: Boolean(value.repositoryUrl.trim()) })
      : mergeTraefikIntoCompose(value.composeOverride.trim(), traefikSettings, { registryDeployFromRegistry: value.registryDeployFromRegistry });

    if (composeOverride === null) {
      this.error.set('The current YAML uses Compose options the UI cannot safely update with Traefik settings. Load it into the builder or add the Traefik labels manually.');
      return null;
    }

    this.form.controls.composeOverride.setValue(composeOverride, { emitEvent: false });

    const envSecrets = this.composeMode() === 'builder' ? collectBuilderEnvSecrets(this.builderServices()) : this.currentProject()?.compose?.envSecrets ?? this.currentProject()?.envSecrets ?? [];
    const traefikPortNumber = Number(value.traefikPort.trim());
    const groupedTraefik = {
      enabled: value.traefikEnabled,
      hostname: value.traefikHostname.trim(),
      service: value.traefikService.trim(),
      port: Number.isFinite(traefikPortNumber) ? traefikPortNumber : undefined,
      entryPoints: value.traefikEntryPoints.trim(),
      certResolver: value.traefikCertResolver.trim(),
      network: value.traefikNetwork.trim(),
      wildcardCertificate: value.traefikWildcardCertificate,
      wildcardDomain: value.traefikWildcardDomain.trim(),
      websocket: value.traefikWebsocket,
      removePublishedPorts: value.traefikRemovePublishedPorts,
    };

    return {
      name: value.name.trim(),
      serverId: value.serverId.trim() || 'local',
      serverIds,
      repositoryUrl: value.repositoryUrl.trim(),
      token: value.token.trim(),
      deployToken: value.deployToken.trim(),
      deploymentStrategy,
      registryPublish: value.registryPublish,
      registryDeployFromRegistry: value.registryDeployFromRegistry,
      registryImageNamespace: value.registryImageNamespace.trim(),
      registryImageTag: value.registryImageTag.trim(),
      path: value.path.trim(),
      composeOverride: composeOverride.trim(),
      envSecrets,
      traefikEnabled: groupedTraefik.enabled,
      traefikHostname: value.traefikHostname.trim(),
      traefikService: value.traefikService.trim(),
      traefikPort: value.traefikPort.trim(),
      traefikEntryPoints: value.traefikEntryPoints.trim(),
      traefikCertResolver: value.traefikCertResolver.trim(),
      traefikNetwork: value.traefikNetwork.trim(),
      traefikWildcardCertificate: value.traefikWildcardCertificate,
      traefikWildcardDomain: value.traefikWildcardDomain.trim(),
      traefikWebsocket: value.traefikWebsocket,
      traefikRemovePublishedPorts: value.traefikRemovePublishedPorts,
      project: {
        name: value.name.trim(),
        serverId: value.serverId.trim() || 'local',
        serverIds,
        path: value.path.trim(),
      },
      git: {
        repositoryUrl: value.repositoryUrl.trim(),
        token: value.token.trim(),
      },
      deployment: {
        deployToken: value.deployToken.trim(),
        strategy: deploymentStrategy,
      },
      registry: {
        publish: value.registryPublish,
        deployFromRegistry: value.registryDeployFromRegistry,
        imageNamespace: value.registryImageNamespace.trim(),
        imageTag: value.registryImageTag.trim(),
      },
      compose: {
        override: composeOverride.trim(),
        envSecrets,
      },
      traefik: groupedTraefik,
    };
  }

  private currentTraefikComposeSettings(): ComposeTraefikSettings {
    this.traefikFormRevision();
    const value = this.form.getRawValue();
    return {
      enabled: value.traefikEnabled,
      projectName: value.name.trim(),
      hostname: value.traefikHostname.trim(),
      service: value.traefikService.trim() || this.builderServiceNames()[0] || value.name.trim(),
      port: value.traefikPort.trim(),
      entryPoints: value.traefikEntryPoints.trim(),
      certResolver: value.traefikCertResolver.trim(),
      network: value.traefikNetwork.trim() || this.builderNetworkNames()[0] || this.globalDefaults().defaultTraefikNetwork,
      wildcardCertificate: value.traefikWildcardCertificate,
      wildcardDomain: value.traefikWildcardDomain.trim(),
      websocket: value.traefikWebsocket,
      removePublishedPorts: value.traefikRemovePublishedPorts,
      deploymentStrategy: value.deploymentStrategy === 'swarm' ? 'swarm' : 'compose',
    };
  }

  private normalizeBuilderTraefikRefs() {
    const serviceNames = this.builderServiceNames();
    const value = this.form.getRawValue();
    let changed = false;

    if (serviceNames.length && !serviceNames.includes(value.traefikService.trim())) {
      this.form.controls.traefikService.setValue(serviceNames[0], { emitEvent: false });
      changed = true;
    }

    if (changed) {
      this.traefikFormRevision.update((revision) => revision + 1);
    }
  }

  private validateTraefikReferences(traefik: ComposeTraefikSettings) {
    if (!traefik.enabled) {
      return '';
    }

    if (!this.builderServiceNames().includes(traefik.service)) {
      return `Traefik target service ${traefik.service} no longer exists. Select a service or disable Traefik.`;
    }

    if (this.composeMode() === 'builder' && !this.builderNetworkNames().includes(traefik.network)) {
      return `Traefik network ${traefik.network} no longer exists. Select another network or disable Traefik before saving.`;
    }

    if (this.composeMode() === 'yaml') {
      const parsed = parseComposeBuilder(this.form.controls.composeOverride.value);
      if (parsed && !parsed.networks.some((network) => network.name.trim() === traefik.network)) {
        return `Traefik network ${traefik.network} is not defined in the YAML. Select another network or disable Traefik before saving.`;
      }
    }

    return '';
  }

  private canComposeAttachToDockerNetwork(networkName: string) {
    if (this.form.controls.deploymentStrategy.value === 'swarm') {
      return true;
    }

    const detail = this.selectedServerTraefikNetworkDetail(networkName);
    return !(detail?.driver === 'overlay' && detail.attachable === false);
  }

  private traefikNetworkAttachWarning(networkName: string) {
    const detail = this.selectedServerTraefikNetworkDetail(networkName);
    if (detail?.driver === 'overlay' && detail.attachable === false) {
      return `${networkName} is a Swarm overlay network but is not attachable. Recreate/update the network as attachable before deploying normal Compose containers to it.`;
    }

    return '';
  }

  private selectedServerTraefikNetworkDetail(networkName: string) {
    const server = this.store.servers().find((candidate) => candidate.id === this.selectedServerId());
    return server?.capabilities?.traefik.networkDetails?.find((network) => network.name === networkName);
  }

  private buildBuilderDiagnostics() {
    const diagnostics: string[] = [];
    const serviceNames = this.builderServiceNames();
    const networkNames = this.builderNetworkNames();
    const volumeNames = this.builderVolumes().map((volume) => volume.name.trim()).filter(Boolean);

    appendDuplicateNameDiagnostics(diagnostics, 'service', serviceNames);
    appendDuplicateNameDiagnostics(diagnostics, 'network', networkNames);
    appendDuplicateNameDiagnostics(diagnostics, 'volume', volumeNames);

    for (const service of this.builderServices()) {
      const serviceName = service.name.trim() || 'Unnamed service';
      const swarmMode = this.form.controls.deploymentStrategy.value === 'swarm';
      const registryImageFromBuild = this.buildContextAvailable() && this.registryDeployFromRegistry() && service.build.trim();
      if (swarmMode && !service.image.trim() && !registryImageFromBuild) {
        diagnostics.push(this.registryDeployFromRegistry()
          ? this.buildContextAvailable()
            ? `${serviceName} needs a build context so Deploy can publish a registry image for Swarm.`
            : `${serviceName} needs an image for Swarm stack deployment because no repository URL is configured.`
          : `${serviceName} needs an image for Swarm stack deployment, or enable registry image deployment.`);
      }

      if (!swarmMode && service.networkMode.trim() && splitLines(service.networks).length) {
        diagnostics.push(`${serviceName} cannot use network_mode and selected networks together.`);
      }

      for (const network of splitLines(service.networks)) {
        if (!networkNames.includes(network)) {
          diagnostics.push(`${serviceName} references missing network ${network}.`);
        }
      }

      for (const dependency of splitLines(service.dependsOn)) {
        if (!serviceNames.includes(dependency)) {
          diagnostics.push(`${serviceName} depends on missing service ${dependency}.`);
        }
      }

      for (const mount of splitLines(service.volumes)) {
        const source = volumeMountSource(mount);
        if (source && !isHostVolumeSource(source) && !volumeNames.includes(source)) {
          diagnostics.push(`${serviceName} references undeclared named volume ${source}.`);
        }
      }

      for (const secret of service.secretEnvironment) {
        const key = secret.key.trim();
        if (!key) {
          diagnostics.push(`${serviceName} has a sensitive environment entry without a key.`);
          continue;
        }
        if (secret.source === 'vault' && !secret.vaultSecretId.trim()) {
          diagnostics.push(`${serviceName}.${key} needs an Updater secret selection.`);
        }
        if (secret.source === 'vault' && secret.mode !== 'docker_secret') {
          diagnostics.push(`${serviceName}.${key} must use Docker secret mode when it references an Updater secret.`);
        }
        if (secret.mode === 'docker_secret' && secret.exposure === 'env' && !isShellEnvIdentifier(key)) {
          diagnostics.push(`${serviceName}.${key} needs a shell-compatible name for env helper mode.`);
        }
        if ((secret.source || 'inline') === 'inline' && !secret.value.trim()) {
          diagnostics.push(`${serviceName}.${key} needs a manual secret value.`);
        }
      }
    }

    const traefik = this.currentTraefikComposeSettings();
    if (traefik.enabled) {
      const networkIssue = this.form.controls.deploymentStrategy.value === 'swarm' ? '' : this.traefikNetworkAttachWarning(traefik.network);
      if (networkIssue) {
        diagnostics.push(networkIssue);
      }

      const target = this.builderServices().find((service) => service.name.trim() === traefik.service);
      if (!traefik.hostname) {
        diagnostics.push('Traefik needs a hostname.');
      }
      if (!traefik.port) {
        diagnostics.push('Traefik needs the container port.');
      }
      if (!target) {
        diagnostics.push('Traefik target service is missing.');
      } else if (target.networkMode.trim() === 'host') {
        diagnostics.push(`${target.name} uses host networking, so Traefik cannot attach it to a Docker network.`);
      }
      if (!networkNames.includes(traefik.network)) {
        diagnostics.push('Traefik Docker network is missing.');
      }
    }

    return diagnostics;
  }

  private readApiError(error: unknown) {
    const apiError = (error as { error?: { error?: string } }).error?.error;
    return apiError || 'Could not save project.';
  }

  private isBuildField(field: keyof ComposeBuilderService) {
    return field === 'build' || field === 'dockerfile' || field === 'buildTarget';
  }
}

function renderComposeBuilder(
  services: ComposeBuilderRenderableService[],
  networks: ComposeBuilderRenderableNetwork[],
  volumes: ComposeBuilderRenderableVolume[],
  traefik?: ComposeTraefikSettings,
  options: { registryDeployFromRegistry?: boolean; allowBuild?: boolean } = {}
) {
  const lines = ['services:'];
  const useSwarmStack = traefik?.deploymentStrategy === 'swarm';
  const allowBuild = options.allowBuild !== false;
  const keepBuildForRegistryRewrite = allowBuild && useSwarmStack && Boolean(options.registryDeployFromRegistry);
  const prepared = prepareComposeBuilderForTraefik(services, networks, traefik);
  const validServices = prepared.services.filter((service) => service.name.trim());

  for (const service of validServices) {
    lines.push(`  ${yamlKey(service.name)}:`);
    const registryPlaceholderImage = keepBuildForRegistryRewrite && !service.image.trim() && service.build.trim()
      ? `deploy-registry-placeholder/${yamlImageName(service.name)}:pending`
      : '';
    if (service.image.trim()) {
      lines.push(`    image: ${yamlScalar(service.image.trim())}`);
    } else if (registryPlaceholderImage) {
      lines.push(`    image: ${yamlScalar(registryPlaceholderImage)}`);
    }
    if (allowBuild && (!useSwarmStack || keepBuildForRegistryRewrite) && service.build.trim() && (service.dockerfile.trim() || service.buildTarget.trim())) {
      lines.push('    build:');
      lines.push(`      context: ${yamlScalar(service.build.trim())}`);
      if (service.dockerfile.trim()) {
        lines.push(`      dockerfile: ${yamlScalar(service.dockerfile.trim())}`);
      }
      if (service.buildTarget.trim()) {
        lines.push(`      target: ${yamlScalar(service.buildTarget.trim())}`);
      }
    } else if (allowBuild && (!useSwarmStack || keepBuildForRegistryRewrite) && service.build.trim()) {
      lines.push(`    build: ${yamlScalar(service.build.trim())}`);
    }
    if (!useSwarmStack && service.containerName.trim()) {
      lines.push(`    container_name: ${yamlScalar(service.containerName.trim())}`);
    }
    if (service.command.trim()) {
      lines.push(`    command: ${yamlScalar(service.command.trim())}`);
    }
    if (!useSwarmStack && service.restart.trim()) {
      lines.push(`    restart: ${yamlScalar(service.restart.trim())}`);
    }
    if (!useSwarmStack && service.networkMode.trim()) {
      lines.push(`    network_mode: ${yamlScalar(service.networkMode.trim())}`);
    }
    if (!useSwarmStack && service.init) {
      lines.push('    init: true');
    }
    appendHealthcheck(lines, service);
    appendList(lines, 'ports', service.ports);
    appendList(lines, 'expose', service.expose);
    appendEnvironment(lines, mergeEnvironmentWithSecretPlaceholders(service.name, service.environment, service.secretEnvironment));
    appendList(lines, 'volumes', service.volumes);
    appendList(lines, 'networks', service.networks);
    if (!useSwarmStack && service.dependsOnAdvanced.trim()) {
      appendExtraYaml(lines, service.dependsOnAdvanced);
    } else if (!useSwarmStack) {
      appendList(lines, 'depends_on', service.dependsOn);
    }
    appendDeploy(lines, service, useSwarmStack);
    appendList(lines, 'profiles', service.profiles);
    appendExtraYaml(lines, service.extra);
  }

  appendTopLevelResources(lines, 'networks', prepared.networks);
  appendTopLevelResources(lines, 'volumes', volumes);
  return `${lines.join('\n')}\n`;
}

function appendHealthcheck(lines: string[], service: ComposeBuilderRenderableService) {
  if (!service.healthcheckMode) {
    return;
  }

  lines.push('    healthcheck:');
  if (service.healthcheckMode === 'disabled') {
    lines.push('      disable: true');
    appendExtraYaml(lines, service.healthcheckExtra, 6);
    return;
  }

  const command = service.healthcheckMode === 'http'
    ? renderHttpHealthcheckCommand(service.healthcheckHttpUrl.trim())
    : service.healthcheckCommand.trim();
  if (service.healthcheckMode === 'http') {
    lines.push(`      # deploy-http-endpoint: ${yamlScalar(service.healthcheckHttpUrl.trim() || 'http://localhost:3000/health')}`);
  }
  if (command) {
    lines.push('      test:');
    lines.push('        - CMD-SHELL');
    lines.push(`        - ${yamlScalar(command)}`);
  }
  if (service.healthcheckInterval.trim()) {
    lines.push(`      interval: ${yamlScalar(service.healthcheckInterval.trim())}`);
  }
  if (service.healthcheckTimeout.trim()) {
    lines.push(`      timeout: ${yamlScalar(service.healthcheckTimeout.trim())}`);
  }
  if (service.healthcheckRetries.trim()) {
    lines.push(`      retries: ${Number.isFinite(Number(service.healthcheckRetries)) ? Math.max(0, Math.trunc(Number(service.healthcheckRetries))) : yamlScalar(service.healthcheckRetries.trim())}`);
  }
  if (service.healthcheckStartPeriod.trim()) {
    lines.push(`      start_period: ${yamlScalar(service.healthcheckStartPeriod.trim())}`);
  }
  appendExtraYaml(lines, service.healthcheckExtra, 6);
}

function renderHttpHealthcheckCommand(url: string) {
  const target = url || 'http://localhost:3000/health';
  return `curl -fsS ${shellHealthcheckUrlArg(target)} >/dev/null || exit 1`;
}

function formDeploymentStrategySummary(input: {
  strategy: DeploymentStrategy;
  traefikEnabled: boolean;
  traefikNetwork: string;
  targetCount: number;
  server: ServerRecord | null;
}): StrategySummary {
  const detectedTraefikNetwork = input.server?.capabilities?.traefik.dockerProviderNetwork || input.server?.capabilities?.traefik.networks?.[0] || '';
  const network = input.traefikNetwork || detectedTraefikNetwork;
  const recommendation = recommendedDeploymentStrategy(input.server, input.traefikEnabled, input.targetCount);
  const recommendationDetail = recommendation.strategy !== input.strategy
    ? `Detected topology recommends ${recommendation.strategy === 'swarm' ? 'Swarm stack' : 'Single host Compose'}: ${recommendation.reason}`
    : `Detected topology matches this mode: ${recommendation.reason}`;

  if (input.strategy === 'swarm') {
    return {
      label: 'Swarm stack',
      reason: input.traefikEnabled
        ? 'This project will deploy as a Swarm stack and use the configured shared proxy network.'
        : 'This project will deploy as a Swarm stack.',
      details: [
        recommendationDetail,
        'Deploy must run through a Swarm manager agent.',
        input.targetCount > 1
          ? 'Multiple selected targets collapse to one stack dispatch; placement constraints decide worker nodes.'
          : 'Service placement constraints decide the target node.',
        input.traefikEnabled
          ? `Proxy routing uses ${network || 'the selected overlay network'}.`
          : 'No proxy routing is configured.'
      ]
    };
  }

  return {
    label: 'Single host Compose',
    reason: input.traefikEnabled
      ? 'This project will deploy containers on the selected Docker host and route through the configured network.'
      : 'This project will deploy containers directly on the selected Docker host.',
    details: [
      recommendationDetail,
      'Deploy runs with Docker Compose on each selected target server.',
      input.targetCount > 1
        ? `${input.targetCount} target servers will receive separate Compose deploys.`
        : `Target server: ${input.server?.name || 'local'}.`,
      input.traefikEnabled
        ? `Proxy routing uses ${network || 'the selected Docker network'}.`
        : 'No proxy routing is configured.'
    ]
  };
}

function recommendedDeploymentStrategy(server: ServerRecord | null, traefikEnabled: boolean, targetCount: number): { strategy: DeploymentStrategy; reason: string } {
  const dockerMode = server?.capabilities?.docker.mode;
  const providerMode = server?.capabilities?.traefik.providerMode;
  const providerNetwork = server?.capabilities?.traefik.networkDetails?.find((network) => network.name === server.capabilities?.traefik.dockerProviderNetwork);

  if (dockerMode === 'swarm-worker') {
    return { strategy: 'swarm', reason: 'the selected target is a Swarm worker and stack deploys must be dispatched by a manager.' };
  }
  if (dockerMode === 'swarm-manager' && (providerMode === 'swarm' || providerMode === 'mixed')) {
    return { strategy: 'swarm', reason: `Traefik is using the ${providerMode} provider on a Swarm manager.` };
  }
  if (targetCount > 1 && dockerMode === 'swarm-manager') {
    return { strategy: 'swarm', reason: 'multiple targets can be represented with Swarm placement constraints from one manager deploy.' };
  }
  if (traefikEnabled && providerNetwork?.driver === 'overlay' && providerNetwork.attachable === false) {
    return { strategy: 'swarm', reason: `${providerNetwork.name} is a non-attachable overlay network.` };
  }

  return { strategy: 'compose', reason: dockerMode ? `${dockerMode.replace(/-/g, ' ')} with Docker-provider compatible networking.` : 'no Swarm-only topology was detected.' };
}

function mergeTraefikIntoCompose(compose: string, traefik: ComposeTraefikSettings, options: { registryDeployFromRegistry?: boolean } = {}) {
  if (!compose || !traefik.enabled) {
    return compose;
  }

  const parsed = parseComposeBuilder(compose);
  if (!parsed) {
    return null;
  }

  return renderComposeBuilder(parsed.services, parsed.networks, parsed.volumes, traefik, options);
}

function prepareComposeBuilderForTraefik(
  services: ComposeBuilderRenderableService[],
  networks: ComposeBuilderRenderableNetwork[],
  traefik?: ComposeTraefikSettings
) {
  const cleanedServices = services.map((service) => ({
    ...service,
    deployLabels: removeTraefikDeployLabels(service.deployLabels),
    extra: removeTraefikLabelBlocks(service.extra),
  }));

  if (!traefik?.enabled || !traefik.hostname || !traefik.service || !traefik.network) {
    return { services: cleanedServices, networks };
  }

  const serviceExists = cleanedServices.some((service) => service.name.trim() === traefik.service);
  const targetServiceName = serviceExists ? traefik.service : cleanedServices.find((service) => service.name.trim())?.name.trim();

  if (!targetServiceName) {
    return { services: cleanedServices, networks };
  }

  const labels = renderTraefikLabels({ ...traefik, service: targetServiceName }, traefik.deploymentStrategy === 'swarm' ? 'deploy' : 'service');
  const preparedServices = cleanedServices.map((service) => {
    if (service.name.trim() !== targetServiceName) {
      return service;
    }

    const networkMode = service.networkMode.trim();
    const canAttachNetwork = networkMode !== 'host';
    const serviceNetworks = canAttachNetwork ? addListValue(service.networks, traefik.network) : service.networks;

    return {
      ...service,
      ports: traefik.removePublishedPorts ? '' : service.ports,
      networks: serviceNetworks,
      deployLabels: traefik.deploymentStrategy === 'swarm' ? labels : service.deployLabels,
      extra: traefik.deploymentStrategy === 'swarm' ? service.extra : replaceGeneratedTraefikBlock(service.extra, labels),
    };
  });

  const hasNetwork = networks.some((network) => network.name.trim() === traefik.network);
  const preparedNetworks = hasNetwork
    ? networks.map((network) => network.name.trim() === traefik.network ? { ...network, external: true, driver: '' } : network)
    : [...networks, { id: -1, name: traefik.network, external: true, driver: '', extra: '' }];

  return { services: preparedServices, networks: preparedNetworks };
}

function renderTraefikLabels(traefik: ComposeTraefikSettings, target: 'service' | 'deploy' = 'service') {
  const routerName = traefikRouterName(traefik.projectName || traefik.service);
  const labels = [
    `traefik.enable=true`,
    ...(traefik.deploymentStrategy === 'swarm'
      ? [`traefik.swarm.network=${traefik.network}`]
      : [`traefik.docker.network=${traefik.network}`]),
    `traefik.http.routers.${routerName}.rule=Host(\`${traefik.hostname}\`)`,
    `traefik.http.routers.${routerName}.entrypoints=${traefik.entryPoints}`,
    `traefik.http.routers.${routerName}.tls=true`,
    `traefik.http.routers.${routerName}.tls.certresolver=${traefik.certResolver}`,
    `traefik.http.services.${routerName}.loadbalancer.server.port=${traefik.port || '80'}`,
  ];

  if (traefik.wildcardCertificate && traefik.wildcardDomain) {
    labels.push(`traefik.http.routers.${routerName}.tls.domains[0].main=${traefik.wildcardDomain}`);
    labels.push(`traefik.http.routers.${routerName}.tls.domains[0].sans=*.${traefik.wildcardDomain}`);
  }

  if (traefik.websocket) {
    labels.push(`traefik.http.middlewares.${routerName}-websocket.headers.customrequestheaders.Connection=Upgrade`);
    labels.push(`traefik.http.middlewares.${routerName}-websocket.headers.customrequestheaders.Upgrade=websocket`);
    labels.push(`traefik.http.routers.${routerName}.middlewares=${routerName}-websocket`);
  }

  return target === 'deploy'
    ? labels.join('\n')
    : [
        'labels:',
        ...labels.map((label) => `  - ${yamlScalar(label)}`)
      ].join('\n');
}

function replaceGeneratedTraefikBlock(extra: string, labels: string) {
  const withoutGenerated = removeTraefikLabelBlocks(extra);
  const block = `# updater-traefik-start\n${labels}\n# updater-traefik-end`;
  return withoutGenerated ? `${withoutGenerated}\n${block}` : block;
}

function removeTraefikLabelBlocks(extra: string) {
  const withoutManagedBlock = extra
    .replace(/\n?# updater-traefik-start[\s\S]*?# updater-traefik-end\n?/g, '\n')
    .trim();
  const lines = withoutManagedBlock.split(/\r?\n/);
  const kept: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (isTraefikLabelLine(line)) {
      continue;
    }

    if (line.trim() !== 'labels:') {
      kept.push(line);
      continue;
    }

    const block: string[] = [];
    let cursor = index + 1;
    while (cursor < lines.length && (/^(\s+|#|$)/.test(lines[cursor]))) {
      block.push(lines[cursor]);
      cursor += 1;
    }

    if (isTraefikOnlyLabelsBlock(block)) {
      index = cursor - 1;
      continue;
    }

    kept.push(line, ...block.filter((entry) => !isTraefikLabelLine(entry)));
    index = cursor - 1;
  }

  return kept.join('\n').trim();
}

function isTraefikOnlyLabelsBlock(lines: string[]) {
  const labelLines = lines.filter((line) => line.trim() && !line.trim().startsWith('#'));
  return labelLines.length > 0 && labelLines.every(isTraefikLabelLine);
}

function isTraefikLabelLine(line: string) {
  return /^\s*-\s*["']?traefik\./.test(line) || /^\s*["']?traefik\./.test(line);
}

function removeTraefikDeployLabels(labels: string) {
  return splitLines(labels).filter((label) => !isTraefikLabelLine(label)).join('\n');
}

function addListValue(value: string, item: string) {
  const items = splitLines(value);
  return items.includes(item) ? value : [...items, item].join('\n');
}

function replaceListValue(value: string, previousItem: string, nextItem: string) {
  return uniqueList(splitLines(value).map((item) => item === previousItem ? nextItem : item)).join('\n');
}

function removeListValue(value: string, item: string) {
  return splitLines(value).filter((valueItem) => valueItem !== item).join('\n');
}

function appendList(lines: string[], key: string, value: string) {
  const items = splitLines(value);
  if (!items.length) {
    return;
  }

  lines.push(`    ${key}:`);
  for (const item of items) {
    lines.push(`      - ${yamlScalar(item)}`);
  }
}

function appendEnvironment(lines: string[], value: string) {
  const entries = splitLines(value)
    .map((entry) => entry.split('='))
    .map(([key, ...rest]) => ({ key: key.trim(), value: rest.join('=').trim() }))
    .filter((entry) => entry.key);

  if (!entries.length) {
    return;
  }

  lines.push('    environment:');
  for (const entry of entries) {
    lines.push(`      ${yamlKey(entry.key)}: ${yamlScalar(entry.value)}`);
  }
}

function appendDeploy(lines: string[], service: ComposeBuilderRenderableService, useSwarmDefaults: boolean) {
  const mode = service.deployMode.trim() || (useSwarmDefaults ? 'replicated' : '');
  const replicas = service.deployReplicas.trim() || (useSwarmDefaults && mode !== 'global' ? '1' : '');
  const constraints = uniqueList(splitLines(service.deployPlacementConstraints || (useSwarmDefaults ? 'node.role == worker' : '')));
  const labels = splitLines(service.deployLabels);
  const advanced = service.deployAdvanced.trim();

  if (!mode && !replicas && !constraints.length && !labels.length && !advanced) {
    return;
  }

  lines.push('    deploy:');
  if (mode) {
    lines.push(`      mode: ${yamlScalar(mode)}`);
  }
  if (replicas && mode !== 'global') {
    lines.push(`      replicas: ${Number.isFinite(Number(replicas)) ? Math.max(0, Math.trunc(Number(replicas))) : yamlScalar(replicas)}`);
  }
  if (constraints.length) {
    lines.push('      placement:');
    lines.push('        constraints:');
    for (const constraint of constraints) {
      lines.push(`          - ${yamlScalar(constraint)}`);
    }
  }
  if (labels.length) {
    lines.push('      labels:');
    for (const label of labels) {
      lines.push(`        - ${yamlScalar(label)}`);
    }
  }
  appendExtraYaml(lines, advanced, 6);
}

function mergeEnvironmentWithSecretPlaceholders(serviceName: string, environment: string, entries: ComposeSecretEnvironmentEntry[]) {
  const dockerSecretEntries = entries
    .map((entry) => ({ key: entry.key.trim(), mode: entry.mode, exposure: entry.exposure }))
    .filter((entry) => entry.key && entry.mode === 'docker_secret' && entry.exposure !== 'env');

  if (!dockerSecretEntries.length) {
    return environment;
  }

  return renderEnvironmentEntries([
    ...parseEnvironmentEntries(environment),
    ...dockerSecretEntries.map((entry) => ({
      key: `${entry.key}_FILE`,
      value: `/run/secrets/${composeSecretName(serviceName, entry.key)}`
    }))
  ]);
}

function composeSecretName(service: string, key: string) {
  return `${service}_${key}`.toLowerCase().replace(/[^a-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '') || 'deploy_secret';
}

function isShellEnvIdentifier(value: string) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function collectBuilderEnvSecrets(services: ComposeBuilderRenderableService[]): ProjectEnvironmentSecret[] {
  return services.flatMap((service) =>
    service.secretEnvironment
      .map((secret) => ({
        service: service.name.trim(),
        key: secret.key.trim(),
        value: secret.source === 'vault' ? '' : secret.value.trim(),
        mode: secret.source === 'vault' ? 'docker_secret' as const : secret.mode === 'env' ? 'env' as const : 'docker_secret' as const,
        source: secret.source === 'vault' ? 'vault' as const : 'inline' as const,
        exposure: secret.mode === 'docker_secret' && secret.exposure === 'env' ? 'env' as const : 'file' as const,
        helperCommand: secret.mode === 'docker_secret' && secret.exposure === 'env' ? service.secretHelperCommand.trim() : '',
        ...(secret.source === 'vault' ? { vaultSecretId: secret.vaultSecretId.trim() } : {})
      }))
      .filter((secret) => secret.service && secret.key && (secret.source === 'vault' ? secret.vaultSecretId : secret.value))
  );
}

function ensureServerSelected(serverIds: string[], serverId: string) {
  const ids = serverIds.map((id) => id.trim()).filter(Boolean);
  const selected = serverId.trim() || 'local';
  return [...new Set(ids.includes(selected) ? ids : [selected, ...ids])];
}

function removeGeneratedSecretFileEntries(environment: string, secrets: ProjectEnvironmentSecret[]) {
  const generatedKeys = new Set(
    secrets
      .filter((secret) => secret.mode === 'docker_secret' && secret.exposure !== 'env')
      .map((secret) => `${secret.key}_FILE`)
  );

  if (!generatedKeys.size) {
    return environment;
  }

  return renderEnvironmentEntries(parseEnvironmentEntries(environment).filter((entry) => !generatedKeys.has(entry.key)));
}

function appendTopLevelResources(
  lines: string[],
  key: 'networks' | 'volumes',
  resources: Array<ComposeBuilderRenderableNetwork | ComposeBuilderRenderableVolume>
) {
  const valid = resources.filter((resource) => resource.name.trim());
  if (!valid.length) {
    return;
  }

  lines.push(key + ':');
  for (const resource of valid) {
    if (resource.external) {
      lines.push(`  ${yamlKey(resource.name)}:`);
      lines.push('    external: true');
    } else {
      lines.push(`  ${yamlKey(resource.name)}:`);
      if (resource.driver.trim()) {
        lines.push(`    driver: ${yamlScalar(resource.driver.trim())}`);
      } else if (!resource.extra.trim() && !hasVolumeDriverOpts(resource)) {
        lines[lines.length - 1] += ' {}';
      }
    }
    appendVolumeDriverOpts(lines, resource);
    appendExtraYaml(lines, resource.extra);
  }
}

function hasVolumeDriverOpts(resource: ComposeBuilderRenderableNetwork | ComposeBuilderRenderableVolume): resource is ComposeBuilderRenderableVolume {
  return 'driverOpts' in resource && resource.driverOpts.some((entry) => entry.key.trim());
}

function appendVolumeDriverOpts(lines: string[], resource: ComposeBuilderRenderableNetwork | ComposeBuilderRenderableVolume) {
  if (!hasVolumeDriverOpts(resource)) {
    return;
  }

  lines.push('    driver_opts:');
  for (const entry of resource.driverOpts) {
    const key = entry.key.trim();
    if (!key) {
      continue;
    }
    lines.push(`      ${yamlKey(key)}: ${yamlScalar(entry.value.trim())}`);
  }
}

function appendExtraYaml(lines: string[], value: string, indent = 4) {
  const prefix = ' '.repeat(indent);
  for (const line of value.split(/\r?\n/).filter((entry) => entry.trim())) {
    lines.push(`${prefix}${line}`);
  }
}

function splitLines(value: string) {
  return value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function uniqueList(values: string[]) {
  return [...new Set(values)];
}

function parseEnvironmentEntries(value: string): ComposeEnvironmentEntry[] {
  return value
    .split(/\r?\n/)
    .map((entry) => {
      const [key, ...rest] = entry.split('=');
      return { key: key.trim(), value: rest.join('=').trim() };
    })
    .filter((entry) => entry.key || entry.value);
}

function renderEnvironmentEntries(entries: ComposeEnvironmentEntry[]) {
  return entries
    .filter((entry) => entry.key || entry.value)
    .map((entry) => `${entry.key}=${entry.value}`)
    .join('\n');
}

function appendDuplicateNameDiagnostics(diagnostics: string[], label: string, names: string[]) {
  const seen = new Set<string>();
  const reported = new Set<string>();
  for (const name of names) {
    if (seen.has(name) && !reported.has(name)) {
      diagnostics.push(`Duplicate ${label} name ${name}.`);
      reported.add(name);
    }
    seen.add(name);
  }
}

function volumeMountSource(mount: string) {
  return parseVolumeMountSourceTarget(mount).source;
}

function normalizeHostBrowseStart(source: string, projectRoot: string) {
  const trimmed = source.trim();
  if (!trimmed) {
    return normalizeAbsolutePath(projectRoot);
  }

  if (trimmed.startsWith('/')) {
    return normalizeAbsolutePath(trimmed);
  }

  return normalizeAbsolutePath(joinAbsolutePath(projectRoot, trimmed));
}

function normalizeAbsolutePath(path: string) {
  const normalized = path.trim().replace(/\/+$/, '') || '/';
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

function joinAbsolutePath(root: string, relativePath: string) {
  const parts: string[] = [];
  const rootPath = normalizeAbsolutePath(root);
  for (const part of `${rootPath}/${relativePath}`.split('/')) {
    if (!part || part === '.') {
      continue;
    }
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join('/')}`;
}

function parseVolumeMountEntries(value: string, namedVolumes: string[]): ComposeVolumeMountEntry[] {
  const volumeNames = new Set(namedVolumes);
  return splitMultiline(value).map((mount) => {
    const parsed = parseVolumeMountSourceTarget(mount);
    const kind = parsed.source && !isHostVolumeSource(parsed.source) && volumeNames.has(parsed.source) ? 'volume' as const : 'bind' as const;
    return {
      kind,
      source: parsed.source,
      target: parsed.target,
      mode: parsed.mode
    };
  }).filter((entry) => entry.source || entry.target);
}

function renderVolumeMountEntries(entries: ComposeVolumeMountEntry[]) {
  return entries
    .map((entry) => {
      const source = entry.source.trim();
      const target = entry.target.trim();
      const mode = entry.mode.trim();
      if (!source && !target) {
        return '';
      }
      if (!target) {
        return source;
      }
      return [source, target, mode].filter(Boolean).join(':');
    })
    .filter(Boolean)
    .join('\n');
}

function splitMultiline(value: string) {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseVolumeMountSourceTarget(mount: string) {
  const trimmed = mount.trim();
  if (!trimmed) {
    return { source: '', target: '', mode: '' };
  }

  const windowsDrive = trimmed.match(/^[a-zA-Z]:[\\/]/);
  if (windowsDrive) {
    const remainder = trimmed.slice(2);
    const separator = remainder.search(/:/);
    if (separator === -1) {
      return { source: trimmed, target: '', mode: '' };
    }
    const sourceEnd = separator + 2;
    const rest = trimmed.slice(sourceEnd + 1);
    const nextSeparator = rest.indexOf(':');
    return {
      source: trimmed.slice(0, sourceEnd).trim().replace(/^["']|["']$/g, ''),
      target: (nextSeparator === -1 ? rest : rest.slice(0, nextSeparator)).trim(),
      mode: nextSeparator === -1 ? '' : rest.slice(nextSeparator + 1).trim()
    };
  }

  const separator = trimmed.indexOf(':');
  if (separator === -1) {
    return { source: '', target: trimmed, mode: '' };
  }

  const rest = trimmed.slice(separator + 1);
  const nextSeparator = rest.indexOf(':');
  return {
    source: trimmed.slice(0, separator).trim().replace(/^["']|["']$/g, ''),
    target: (nextSeparator === -1 ? rest : rest.slice(0, nextSeparator)).trim(),
    mode: nextSeparator === -1 ? '' : rest.slice(nextSeparator + 1).trim()
  };
}

function isHostVolumeSource(source: string) {
  return source === '.'
    || source === '..'
    || source.startsWith('./')
    || source.startsWith('../')
    || source.startsWith('/')
    || source.startsWith('~/')
    || /^[a-zA-Z]:[\\/]/.test(source);
}

function yamlKey(value: string) {
  return /^[a-zA-Z0-9._-]+$/.test(value.trim()) ? value.trim() : yamlScalar(value.trim());
}

function yamlScalar(value: string) {
  if (isPlainYamlScalar(value)) {
    return value;
  }

  return JSON.stringify(value);
}

function yamlImageName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'service';
}

function isPlainYamlScalar(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }

  if (!/^[a-zA-Z0-9_./@-]+$/.test(trimmed)) {
    return false;
  }

  return !/^(?:y|yes|n|no|true|false|on|off|null|~)$/i.test(trimmed);
}

function stripBuilderIgnoredComment(raw: string) {
  if (/^\s*#\s*deploy-http-endpoint:/.test(raw)) {
    return raw;
  }

  return raw.replace(/\s+#.*$/, '').trim().startsWith('#') ? '' : raw.replace(/\s+#.*$/, '');
}

function parseHealthcheckEndpointComment(text: string) {
  const match = text.match(/^#\s*deploy-http-endpoint:\s*(.+)$/);
  return match?.[1] ? unquoteYaml(match[1]) : '';
}

function traefikRouterName(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-');
}

function uniqueBuilderName(baseName: string, usedNames: string[]) {
  if (!usedNames.includes(baseName)) {
    return baseName;
  }

  let index = 2;
  while (usedNames.includes(`${baseName}-${index}`)) {
    index += 1;
  }
  return `${baseName}-${index}`;
}

function parseComposeBuilder(compose: string): { services: Omit<ComposeBuilderService, 'id'>[]; networks: Omit<ComposeBuilderNetwork, 'id'>[]; volumes: Omit<ComposeBuilderVolume, 'id'>[] } | null {
  if (!compose.trim()) {
    return {
      services: [blankBuilderService('app', '.', '')],
      networks: [],
      volumes: [{ name: 'data', external: false, driver: '', driverOpts: [], extra: '' }]
    };
  }

  const lines = compose
    .split(/\r?\n/)
    .map(stripBuilderIgnoredComment)
    .filter((raw) => raw.trim());
  const services: Omit<ComposeBuilderService, 'id'>[] = [];
  const networks: Omit<ComposeBuilderNetwork, 'id'>[] = [];
  const volumes: Omit<ComposeBuilderVolume, 'id'>[] = [];
  let section: 'services' | 'networks' | 'volumes' | '' = '';
  let service: Omit<ComposeBuilderService, 'id'> | undefined;
  let listKey: ComposeBuilderListField | 'environment' | '' = '';
  let objectKey: 'build' | 'dependsOn' | 'deploy' | 'placement' | 'healthcheck' | '' = '';
  let extraKey = '';
  let resource: Omit<ComposeBuilderNetwork, 'id'> | Omit<ComposeBuilderVolume, 'id'> | undefined;
  let resourceObjectKey: 'driverOpts' | '' = '';

  for (const raw of lines) {
    const indent = raw.match(/^ */)?.[0].length ?? 0;
    const text = raw.trim();

    if (indent === 0) {
      if (text === 'services:') {
        section = 'services';
      } else if (text === 'networks:') {
        section = 'networks';
      } else if (text === 'volumes:') {
        section = 'volumes';
      } else {
        section = '';
      }
      service = undefined;
      listKey = '';
      objectKey = '';
      extraKey = '';
      resource = undefined;
      resourceObjectKey = '';
      continue;
    }

    if (section === 'services') {
      if (indent === 2 && text.endsWith(':')) {
        service = blankBuilderService(unquoteYaml(text.slice(0, -1)), '', '', '');
        services.push(service);
        listKey = '';
        objectKey = '';
        extraKey = '';
        continue;
      }

      if (!service || indent !== 4) {
        if (service && objectKey === 'build' && indent === 6) {
          const [key, ...rest] = text.split(':');
          const value = unquoteYaml(rest.join(':').trim());
          if (key === 'context') {
            service.build = value;
          } else if (key === 'dockerfile') {
            service.dockerfile = value;
          } else if (key === 'target') {
            service.buildTarget = value;
          } else {
            service.extra = appendRawLine(service.extra, raw.slice(4));
          }
          continue;
        }
        if (service && objectKey === 'healthcheck') {
          const endpoint = parseHealthcheckEndpointComment(text);
          if (endpoint) {
            service.healthcheckMode = 'http';
            service.healthcheckHttpUrl = endpoint;
            continue;
          }
          if (indent === 6) {
            const [healthKey, ...healthRest] = text.split(':');
            const healthValue = unquoteYaml(healthRest.join(':').trim());
            if (healthKey === 'test') {
              service.healthcheckMode = service.healthcheckMode === 'http' ? 'http' : 'command';
              if (healthValue) {
                service.healthcheckCommand = healthValue;
              } else {
                extraKey = 'healthcheckTest';
              }
              continue;
            }
            if (healthKey === 'disable') {
              service.healthcheckMode = healthValue === 'true' ? 'disabled' : service.healthcheckMode;
              continue;
            }
            if (healthKey === 'interval') {
              service.healthcheckInterval = healthValue;
              continue;
            }
            if (healthKey === 'timeout') {
              service.healthcheckTimeout = healthValue;
              continue;
            }
            if (healthKey === 'retries') {
              service.healthcheckRetries = healthValue;
              continue;
            }
            if (healthKey === 'start_period' || healthKey === 'startPeriod') {
              service.healthcheckStartPeriod = healthValue;
              continue;
            }
            service.healthcheckExtra = appendRawLine(service.healthcheckExtra, raw.slice(6));
            if (!healthValue) {
              extraKey = 'healthcheckExtra';
            }
            continue;
          }
          if (extraKey === 'healthcheckTest' && indent > 6) {
            service.healthcheckMode = service.healthcheckMode === 'http' ? 'http' : 'command';
            service.healthcheckCommand = appendRawLine(service.healthcheckCommand, raw.slice(6));
            continue;
          }
          if (extraKey === 'healthcheckExtra' && indent > 6) {
            service.healthcheckExtra = appendRawLine(service.healthcheckExtra, raw.slice(6));
            continue;
          }
        }
        if (service && objectKey === 'dependsOn' && indent === 6 && text.endsWith(':')) {
          appendParsedServiceListValue(service, 'dependsOn', unquoteYaml(text.slice(0, -1)));
          service.dependsOnAdvanced = appendRawLine(service.dependsOnAdvanced, 'depends_on:');
          service.dependsOnAdvanced = appendRawLine(service.dependsOnAdvanced, raw.slice(4));
          continue;
        }
        if (service && objectKey === 'dependsOn' && indent > 6) {
          service.dependsOnAdvanced = appendRawLine(service.dependsOnAdvanced, raw.slice(4));
          continue;
        }
        if (service && extraKey === 'deployLabels' && indent === 8 && text.startsWith('- ')) {
          service.deployLabels = appendRawLine(service.deployLabels, unquoteYaml(text.slice(2)));
          continue;
        }
        if (service && objectKey === 'deploy') {
          if (indent === 6) {
            const [deployKey, ...deployRest] = text.split(':');
            const deployValue = unquoteYaml(deployRest.join(':').trim());
            if (deployKey === 'mode') {
              service.deployMode = deployValue;
              continue;
            }
            if (deployKey === 'replicas') {
              service.deployReplicas = deployValue;
              continue;
            }
            if (deployKey === 'placement') {
              objectKey = 'placement';
              continue;
            }
            if (deployKey === 'labels') {
              extraKey = 'deployLabels';
              continue;
            }
            service.deployAdvanced = appendRawLine(service.deployAdvanced, raw.slice(6));
            if (!deployValue) {
              extraKey = 'deployAdvanced';
            }
            continue;
          }
          if (indent > 6) {
            service.deployAdvanced = appendRawLine(service.deployAdvanced, raw.slice(6));
            continue;
          }
        }
        if (service && objectKey === 'placement') {
          if (indent === 6) {
            objectKey = 'deploy';
            extraKey = '';
            const [deployKey, ...deployRest] = text.split(':');
            const deployValue = unquoteYaml(deployRest.join(':').trim());
            if (deployKey === 'mode') {
              service.deployMode = deployValue;
              continue;
            }
            if (deployKey === 'replicas') {
              service.deployReplicas = deployValue;
              continue;
            }
            if (deployKey === 'labels') {
              extraKey = 'deployLabels';
              continue;
            }
            service.deployAdvanced = appendRawLine(service.deployAdvanced, raw.slice(6));
            continue;
          }
          if (indent === 8 && text === 'constraints:') {
            extraKey = 'deployPlacementConstraints';
            continue;
          }
          if (indent === 10 && text.startsWith('- ')) {
            service.deployPlacementConstraints = appendRawLine(service.deployPlacementConstraints, unquoteYaml(text.slice(2)));
            continue;
          }
          if (indent > 6) {
            service.deployAdvanced = appendRawLine(service.deployAdvanced, raw.slice(6));
            continue;
          }
        }
        if (service && extraKey === 'deployLabels' && indent === 8 && text.startsWith('- ')) {
          service.deployLabels = appendRawLine(service.deployLabels, unquoteYaml(text.slice(2)));
          continue;
        }
        if (service && extraKey && indent > 4) {
          service.extra = appendRawLine(service.extra, raw.slice(4));
          continue;
        }
        if (service && indent === 6 && text.startsWith('- ') && listKey) {
          appendParsedServiceListValue(service, listKey, unquoteYaml(text.slice(2)));
          continue;
        }
        if (service && indent === 6 && listKey === 'networks' && /^[^:]+:\s*\{\}\s*$/.test(text)) {
          continue;
        }
        if (service && indent === 6 && listKey && text.startsWith('target:') && service.build) {
          service.buildTarget = unquoteYaml(text.slice('target:'.length));
          continue;
        }
        if (service && indent === 6 && listKey === 'environment') {
          const [key, ...rest] = text.split(':');
          if (key.trim()) {
            appendParsedEnvironmentValue(service, unquoteYaml(key.trim()), unquoteYaml(rest.join(':').trim()));
            continue;
          }
        }
        return null;
      }

      const [key, ...rest] = text.split(':');
      const value = rest.join(':').trim();
      listKey = '';
      objectKey = '';
      extraKey = '';
      if (['ports', 'expose', 'volumes', 'networks', 'depends_on', 'environment', 'profiles'].includes(key)) {
        listKey = key === 'depends_on' ? 'dependsOn' : key as ComposeBuilderListField | 'environment';
        if (value && value !== '[]') {
          return null;
        }
        if (key === 'depends_on') {
          objectKey = 'dependsOn';
        }
        continue;
      }

      if (key === 'build' && !value) {
        objectKey = 'build';
        continue;
      }

      if (key === 'deploy' && !value) {
        objectKey = 'deploy';
        continue;
      }

      if (key === 'healthcheck' && !value) {
        objectKey = 'healthcheck';
        service.healthcheckMode = 'command';
        continue;
      }

      if (key === 'target' && service.build) {
        service.buildTarget = unquoteYaml(value);
        continue;
      }

      if (isSupportedServiceScalar(key)) {
        applyParsedServiceScalar(service, key, unquoteYaml(value));
        continue;
      }

      service.extra = appendRawLine(service.extra, text);
      if (!value) {
        extraKey = key;
      }
      continue;
    }

    if ((section === 'networks' || section === 'volumes') && indent === 2) {
      const name = unquoteYaml(text.replace(/:\s*\{\}\s*$/, '').replace(/:\s*$/, ''));
      resource = section === 'volumes'
        ? { name, external: false, driver: '', driverOpts: [], extra: '' }
        : { name, external: false, driver: '', extra: '' };
      (section === 'networks' ? networks : volumes).push(resource);
      resourceObjectKey = '';
      continue;
    }

    if (section === 'volumes' && indent === 6 && resource && resourceObjectKey === 'driverOpts' && 'driverOpts' in resource) {
      const [key, ...rest] = text.split(':');
      if (key.trim()) {
        resource.driverOpts.push({ key: unquoteYaml(key.trim()), value: unquoteYaml(rest.join(':').trim()) });
        continue;
      }
    }

    if ((section === 'networks' || section === 'volumes') && indent === 4 && resource) {
      const [key, ...rest] = text.split(':');
      const value = unquoteYaml(rest.join(':').trim());
      resourceObjectKey = '';
      if (key === 'external') {
        resource.external = value === 'true';
      } else if (key === 'driver') {
        resource.driver = value;
      } else if (section === 'volumes' && key === 'driver_opts' && !value && 'driverOpts' in resource) {
        resourceObjectKey = 'driverOpts';
      } else {
        resource.extra = appendRawLine(resource.extra, text);
      }
      continue;
    }
  }

  return { services: services.map(normalizeParsedHealthcheck), networks, volumes };
}

function blankBuilderService(name: string, build: string, networks: string, restart = 'unless-stopped'): Omit<ComposeBuilderService, 'id'> {
  return {
    name,
    image: '',
    build,
    dockerfile: '',
    buildTarget: '',
    containerName: '',
    command: '',
    restart,
    networkMode: '',
    init: false,
    healthcheckMode: '',
    healthcheckHttpUrl: 'http://localhost:3000/health',
    healthcheckCommand: '',
    healthcheckInterval: '30s',
    healthcheckTimeout: '10s',
    healthcheckRetries: '3',
    healthcheckStartPeriod: '40s',
    healthcheckExtra: '',
    ports: '',
    expose: '',
    environment: '',
    secretEnvironment: [],
    secretHelperCommand: '',
    volumes: '',
    networks,
    dependsOn: '',
    dependsOnAdvanced: '',
    deployMode: '',
    deployReplicas: '',
    deployPlacementConstraints: '',
    deployAdvanced: '',
    deployLabels: '',
    profiles: '',
    extra: ''
  };
}

function normalizeParsedHealthcheck(service: Omit<ComposeBuilderService, 'id'>): Omit<ComposeBuilderService, 'id'> {
  if (!service.healthcheckMode) {
    return service;
  }

  if (service.healthcheckMode === 'disabled') {
    return service;
  }

  const testCommand = normalizeHealthcheckTestCommand(service.healthcheckCommand);
  if (service.healthcheckMode === 'http') {
    return {
      ...service,
      healthcheckCommand: ''
    };
  }

  const httpTarget = extractCurlHttpHealthcheckTarget(testCommand) || extractNodeHttpHealthcheckTarget(testCommand);
  return {
    ...service,
    healthcheckMode: httpTarget ? 'http' : 'command',
    healthcheckHttpUrl: httpTarget || service.healthcheckHttpUrl,
    healthcheckCommand: httpTarget ? '' : testCommand
  };
}

function normalizeHealthcheckTestCommand(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  const items = parseYamlInlineOrBlockList(trimmed);
  if (!items.length) {
    return unquoteYaml(trimmed);
  }

  const [kind, ...rest] = items;
  if (kind === 'CMD-SHELL') {
    return rest.join(' ').trim();
  }
  if (kind === 'CMD') {
    return rest.map(shellArg).join(' ');
  }
  return items.map(shellArg).join(' ');
}

function parseYamlInlineOrBlockList(value: string) {
  if (value.includes('\n')) {
    return value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && line !== '[' && line !== ']')
      .map((line) => line.replace(/,$/, ''))
      .map((line) => line.startsWith('- ') ? line.slice(2) : line)
      .map(unquoteYaml)
      .filter(Boolean);
  }

  if (value.startsWith('[') && value.endsWith(']')) {
    return value
      .slice(1, -1)
      .split(',')
      .map((item) => unquoteYaml(item.trim()))
      .filter(Boolean);
  }

  return [unquoteYaml(value)];
}

function extractNodeHttpHealthcheckTarget(command: string) {
  if (!/require\(['"]https?['"]\)|require\(['"]http['"]\)/.test(command) || !/\.get\(/.test(command)) {
    return '';
  }

  const constMatch = command.match(/const\s+u\s*=\s*([^;]+);/);
  if (constMatch?.[1]) {
    return unquoteYaml(constMatch[1].trim());
  }

  const getMatch = command.match(/\.get\((.+?),\s*\(?r\)?\s*=>/);
  return getMatch?.[1] ? unquoteYaml(getMatch[1].trim()) : '';
}

function extractCurlHttpHealthcheckTarget(command: string) {
  if (!/(?:^|\s)curl\s/.test(command)) {
    return '';
  }

  const match = command.match(/(?:^|\s)curl\s+(?:-[a-zA-Z]+\s+)*(?:"((?:\\"|[^"])*)"|'((?:'\\''|[^'])*)'|([^\s>]+))/);
  const target = match?.[1] ?? match?.[2] ?? match?.[3] ?? '';
  if (!/^https?:\/\//.test(target) && !/^\$[{a-zA-Z_]/.test(target)) {
    return '';
  }
  return target.replace(/\\"/g, '"').replace(/'\\''/g, "'").replace(/\$\$/g, '$');
}

function shellHealthcheckUrlArg(value: string) {
  if (/\$[{a-zA-Z_]/.test(value)) {
    return `"${value.replace(/\$/g, '$$$$').replace(/(["\\`])/g, '\\$1')}"`;
  }

  return shellArg(value);
}

function shellArg(value: string) {
  return /^[a-zA-Z0-9_./:@=-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function applyParsedServiceScalar(service: Omit<ComposeBuilderService, 'id'>, key: string, value: string) {
  if (key === 'image' || key === 'build' || key === 'dockerfile' || key === 'buildTarget' || key === 'command' || key === 'restart' || key === 'networkMode' || key === 'containerName') {
    service[key] = value;
  } else if (key === 'network_mode') {
    service.networkMode = value;
  } else if (key === 'container_name') {
    service.containerName = value;
  } else if (key === 'init') {
    service.init = value === 'true';
  }
}

function isSupportedServiceScalar(key: string) {
  return ['image', 'build', 'command', 'restart', 'network_mode', 'networkMode', 'container_name', 'containerName', 'init'].includes(key);
}

function appendRawLine(value: string, line: string) {
  return value ? `${value}\n${line}` : line;
}

function appendParsedServiceListValue(service: Omit<ComposeBuilderService, 'id'>, key: ComposeBuilderListField | 'environment', value: string) {
  if (key === 'environment') {
    return;
  }

  const current = String(service[key] || '');
  service[key] = current ? `${current}\n${value}` : value;
}

function appendParsedEnvironmentValue(service: Omit<ComposeBuilderService, 'id'>, key: string, value: string) {
  const entry = `${key}=${value}`;
  service.environment = service.environment ? `${service.environment}\n${entry}` : entry;
}

function unquoteYaml(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }

  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    try {
      return trimmed.startsWith('"') ? JSON.parse(trimmed) as string : trimmed.slice(1, -1).replace(/''/g, "'");
    } catch {
      return trimmed.slice(1, -1);
    }
  }

  return trimmed;
}
