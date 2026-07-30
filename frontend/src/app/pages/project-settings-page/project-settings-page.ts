import { Component, computed, effect, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ComposeInspection, ComposeServiceInspection, GlobalSettings, ProjectPayload, ProjectSummary } from '../../models/project';
import { ProjectApi } from '../../services/project-api';
import { ProjectStore } from '../../state/project-store';

interface ComposeBuilderService {
  id: number;
  name: string;
  image: string;
  build: string;
  dockerfile: string;
  containerName: string;
  command: string;
  restart: string;
  networkMode: string;
  init: boolean;
  ports: string;
  expose: string;
  environment: string;
  volumes: string;
  networks: string;
  dependsOn: string;
  dependsOnAdvanced: string;
  profiles: string;
  extra: string;
}

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
  extra: string;
}

type ComposeBuilderListField = 'ports' | 'expose' | 'volumes' | 'networks' | 'dependsOn' | 'profiles';

@Component({
  selector: 'app-project-settings-page',
  imports: [ReactiveFormsModule],
  templateUrl: './project-settings-page.html',
  styleUrl: './project-settings-page.scss',
})
export class ProjectSettingsPage implements OnInit {
  protected readonly store = inject(ProjectStore);
  private readonly api = inject(ProjectApi);
  private readonly fb = inject(NonNullableFormBuilder);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly isNew = signal(true);
  protected readonly currentName = signal('');
  protected readonly saving = signal<'save' | 'deploy' | ''>('');
  protected readonly importingCompose = signal(false);
  protected readonly inspectingCompose = signal(false);
  protected readonly composeInspection = signal<ComposeInspection | null>(null);
  protected readonly builderServices = signal<ComposeBuilderService[]>([]);
  protected readonly builderNetworks = signal<ComposeBuilderNetwork[]>([]);
  protected readonly builderVolumes = signal<ComposeBuilderVolume[]>([]);
  protected readonly message = signal('');
  protected readonly error = signal('');
  protected readonly traefikEnabled = signal(false);
  protected readonly wildcardCertificate = signal(false);
  protected readonly selectedServerId = signal('local');
  protected readonly servers = this.store.servers;
  protected readonly traefikAvailable = computed(() => {
    const server = this.store.servers().find((candidate) => candidate.id === this.selectedServerId());
    return server ? (server.capabilities?.traefik.available ?? true) : false;
  });
  protected readonly title = computed(() => (this.isNew() ? 'New project' : `Settings for ${this.currentName()}`));
  protected readonly submitLabel = computed(() => (this.isNew() ? 'Create project' : 'Save'));
  private readonly globalDefaults = signal<GlobalSettings>({
    dataRoot: '/root/docker-apps',
    defaultTraefikNetwork: 'proxy',
    defaultTraefikEntryPoints: 'websecure',
    defaultTraefikCertResolver: 'letsencrypt',
    sshKeyPath: '~/.ssh',
    cleanupAfterDeploy: false,
  });

  protected readonly form = this.fb.group({
    name: ['', [Validators.required, Validators.pattern(/^[a-zA-Z0-9._-]+$/)]],
    serverId: ['local', [Validators.required]],
    repositoryUrl: [''],
    token: [''],
    deployToken: [''],
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
    this.form.controls.serverId.valueChanges.pipe(takeUntilDestroyed()).subscribe((serverId) => {
      this.selectedServerId.set(serverId || 'local');
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

    effect(() => {
      if (!this.traefikAvailable()) {
        this.form.controls.traefikEnabled.setValue(false);
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

      if (!projectRef) {
        this.isNew.set(true);
        this.currentName.set('');
        this.currentProjectRef = '';
        this.store.selectProject('');
        this.resetForNewProject();
        return;
      }

      this.isNew.set(false);
      this.currentProjectRef = projectRef;
      this.store.selectProject(projectRef);
      this.currentName.set(this.currentProject()?.name ?? projectRef);
      this.patchedProjectName = '';
      this.selectedServerId.set(this.currentProject()?.serverId ?? this.form.controls.serverId.value ?? 'local');
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
      const result = this.isNew()
        ? await firstValueFrom(this.api.createProject(payload))
        : await firstValueFrom(this.api.updateProject(this.currentProjectRef || this.currentName(), payload));
      const savedId = result.id || this.currentProjectRef;
      const savedName = result.name || payload.name;

      this.currentProjectRef = savedId;
      this.store.selectProject(savedId);
      this.store.loadProjects();

      if (mode === 'deploy') {
        this.message.set(`Saving ${savedName} and starting deployment...`);
        await firstValueFrom(this.api.deployProject(savedId));
      }

      await this.router.navigate(['/projects', savedId, 'overview']);
    } catch (error) {
      this.error.set(this.readApiError(error));
    } finally {
      this.saving.set('');
    }
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

  protected applyTraefikTarget(service: ComposeServiceInspection) {
    const port = this.primaryServicePort(service);
    this.form.controls.traefikService.setValue(service.name);
    if (port) {
      this.form.controls.traefikPort.setValue(port);
    }
    this.form.controls.traefikEnabled.setValue(true);
    this.message.set(`Traefik target set to ${service.name}${port ? ` on port ${port}` : ''}.`);
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

  protected addBuilderService() {
    const index = this.builderServices().length + 1;
    this.builderServices.update((services) => [
      ...services,
      {
        id: this.nextBuilderId++,
        name: index === 1 ? 'app' : `service-${index}`,
        image: '',
        build: index === 1 ? '.' : '',
        dockerfile: '',
        containerName: '',
        command: '',
        restart: 'unless-stopped',
        networkMode: '',
        init: false,
        ports: '',
        expose: '',
        environment: '',
        volumes: '',
        networks: this.builderNetworks()[0]?.name || 'app',
        dependsOn: '',
        dependsOnAdvanced: '',
        profiles: '',
        extra: ''
      }
    ]);

    if (this.builderNetworks().length === 0) {
      this.addBuilderNetwork('app');
    }
  }

  protected removeBuilderService(id: number) {
    this.builderServices.update((services) => services.filter((service) => service.id !== id));
  }

  protected updateBuilderService(id: number, field: keyof ComposeBuilderService, event: Event) {
    const target = event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    const value = field === 'init' && target instanceof HTMLInputElement ? target.checked : target.value;
    this.builderServices.update((services) => services.map((service) => service.id === id ? { ...service, [field]: value } : service));
  }

  protected addBuilderNetwork(name = 'app') {
    this.builderNetworks.update((networks) => [
      ...networks,
      { id: this.nextBuilderId++, name: uniqueBuilderName(name, networks.map((network) => network.name)), external: false, driver: '', extra: '' }
    ]);
  }

  protected removeBuilderNetwork(id: number) {
    this.builderNetworks.update((networks) => networks.filter((network) => network.id !== id));
  }

  protected updateBuilderNetwork(id: number, field: keyof ComposeBuilderNetwork, event: Event) {
    const target = event.target as HTMLInputElement;
    const value = field === 'external' ? target.checked : target.value;
    this.builderNetworks.update((networks) => networks.map((network) => network.id === id ? { ...network, [field]: value } : network));
  }

  protected addBuilderVolume(name = 'data') {
    this.builderVolumes.update((volumes) => [
      ...volumes,
      { id: this.nextBuilderId++, name: uniqueBuilderName(name, volumes.map((volume) => volume.name)), external: false, driver: '', extra: '' }
    ]);
  }

  protected removeBuilderVolume(id: number) {
    this.builderVolumes.update((volumes) => volumes.filter((volume) => volume.id !== id));
  }

  protected updateBuilderVolume(id: number, field: keyof ComposeBuilderVolume, event: Event) {
    const target = event.target as HTMLInputElement;
    const value = field === 'external' ? target.checked : target.value;
    this.builderVolumes.update((volumes) => volumes.map((volume) => volume.id === id ? { ...volume, [field]: value } : volume));
  }

  protected generateComposeOverride() {
    if (this.builderServices().length === 0) {
      this.addBuilderService();
    }

    this.form.controls.composeOverride.setValue(renderComposeBuilder(this.builderServices(), this.builderNetworks(), this.builderVolumes()));
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
  }

  private loadBuilderFromCompose(compose: string) {
    const parsed = parseComposeBuilder(compose);
    if (!parsed) {
      this.resetComposeBuilder();
      return;
    }

    this.nextBuilderId = 1;
    this.builderServices.set(parsed.services.map((service) => ({ ...service, id: this.nextBuilderId++ })));
    this.builderNetworks.set(parsed.networks.map((network) => ({ ...network, id: this.nextBuilderId++ })));
    this.builderVolumes.set(parsed.volumes.map((volume) => ({ ...volume, id: this.nextBuilderId++ })));
    if (this.builderServices().length === 0) {
      this.addBuilderService();
    }
    if (this.builderNetworks().length === 0) {
      this.addBuilderNetwork('app');
    }
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
    this.selectedServerId.set(this.form.controls.serverId.value || 'local');
    this.resetComposeBuilder();
  }

  private patchFromProject(project: ProjectSummary) {
    const traefik = project.traefik ?? { enabled: false };
    this.patchedProjectName = project.name;
    this.traefikEnabled.set(Boolean(traefik.enabled));
    this.wildcardCertificate.set(Boolean(traefik.wildcardCertificate));
    this.form.reset({
      name: project.name,
      serverId: project.serverId ?? 'local',
      repositoryUrl: project.repositoryUrl ?? '',
      token: '',
      deployToken: '',
      path: project.path ?? '',
      composeOverride: project.composeOverride ?? '',
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
    this.selectedServerId.set(this.form.controls.serverId.value || 'local');
    this.loadBuilderFromCompose(project.composeOverride ?? '');
  }

  private currentProject() {
    const projectRef = this.currentProjectRef || this.currentName();
    return this.store.projects().find((project) => project.id === projectRef || project.name === projectRef) ?? null;
  }

  private toPayload(): ProjectPayload {
    const value = this.form.getRawValue();

    return {
      name: value.name.trim(),
      serverId: value.serverId.trim() || 'local',
      repositoryUrl: value.repositoryUrl.trim(),
      token: value.token.trim(),
      deployToken: value.deployToken.trim(),
      path: value.path.trim(),
      composeOverride: value.composeOverride.trim(),
      traefikEnabled: this.traefikAvailable() && value.traefikEnabled,
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
    };
  }

  private readApiError(error: unknown) {
    const apiError = (error as { error?: { error?: string } }).error?.error;
    return apiError || 'Could not save project.';
  }
}

function renderComposeBuilder(services: ComposeBuilderService[], networks: ComposeBuilderNetwork[], volumes: ComposeBuilderVolume[]) {
  const lines = ['services:'];
  const validServices = services.filter((service) => service.name.trim());

  for (const service of validServices) {
    lines.push(`  ${yamlKey(service.name)}:`);
    if (service.image.trim()) {
      lines.push(`    image: ${yamlScalar(service.image.trim())}`);
    }
    if (service.build.trim() && service.dockerfile.trim()) {
      lines.push('    build:');
      lines.push(`      context: ${yamlScalar(service.build.trim())}`);
      lines.push(`      dockerfile: ${yamlScalar(service.dockerfile.trim())}`);
    } else if (service.build.trim()) {
      lines.push(`    build: ${yamlScalar(service.build.trim())}`);
    }
    if (service.containerName.trim()) {
      lines.push(`    container_name: ${yamlScalar(service.containerName.trim())}`);
    }
    if (service.command.trim()) {
      lines.push(`    command: ${yamlScalar(service.command.trim())}`);
    }
    if (service.restart.trim()) {
      lines.push(`    restart: ${yamlScalar(service.restart.trim())}`);
    }
    if (service.networkMode.trim()) {
      lines.push(`    network_mode: ${yamlScalar(service.networkMode.trim())}`);
    }
    if (service.init) {
      lines.push('    init: true');
    }
    appendList(lines, 'ports', service.ports);
    appendList(lines, 'expose', service.expose);
    appendEnvironment(lines, service.environment);
    appendList(lines, 'volumes', service.volumes);
    appendList(lines, 'networks', service.networks);
    if (service.dependsOnAdvanced.trim()) {
      appendExtraYaml(lines, service.dependsOnAdvanced);
    } else {
      appendList(lines, 'depends_on', service.dependsOn);
    }
    appendList(lines, 'profiles', service.profiles);
    appendExtraYaml(lines, service.extra);
  }

  appendTopLevelResources(lines, 'networks', networks);
  appendTopLevelResources(lines, 'volumes', volumes);
  return `${lines.join('\n')}\n`;
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

function appendTopLevelResources(lines: string[], key: 'networks' | 'volumes', resources: Array<ComposeBuilderNetwork | ComposeBuilderVolume>) {
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
      } else if (!resource.extra.trim()) {
        lines[lines.length - 1] += ' {}';
      }
    }
    appendExtraYaml(lines, resource.extra);
  }
}

function appendExtraYaml(lines: string[], value: string) {
  for (const line of value.split(/\r?\n/).filter((entry) => entry.trim())) {
    lines.push(`    ${line}`);
  }
}

function splitLines(value: string) {
  return value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function yamlKey(value: string) {
  return /^[a-zA-Z0-9._-]+$/.test(value.trim()) ? value.trim() : yamlScalar(value.trim());
}

function yamlScalar(value: string) {
  if (/^[a-zA-Z0-9_./:@-]+$/.test(value)) {
    return value;
  }

  return JSON.stringify(value);
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
      services: [blankBuilderService('app', '.', 'app')],
      networks: [{ name: 'app', external: false, driver: '', extra: '' }],
      volumes: [{ name: 'data', external: false, driver: '', extra: '' }]
    };
  }

  const lines = compose
    .split(/\r?\n/)
    .map((raw) => raw.replace(/\s+#.*$/, ''))
    .filter((raw) => raw.trim() && !raw.trim().startsWith('#'));
  const services: Omit<ComposeBuilderService, 'id'>[] = [];
  const networks: Omit<ComposeBuilderNetwork, 'id'>[] = [];
  const volumes: Omit<ComposeBuilderVolume, 'id'>[] = [];
  let section: 'services' | 'networks' | 'volumes' | '' = '';
  let service: Omit<ComposeBuilderService, 'id'> | undefined;
  let listKey: ComposeBuilderListField | 'environment' | '' = '';
  let objectKey: 'build' | 'dependsOn' | '' = '';
  let extraKey = '';
  let resource: Omit<ComposeBuilderNetwork, 'id'> | Omit<ComposeBuilderVolume, 'id'> | undefined;

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
      continue;
    }

    if (section === 'services') {
      if (indent === 2 && text.endsWith(':')) {
        service = blankBuilderService(unquoteYaml(text.slice(0, -1)), '', '');
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
          } else {
            service.extra = appendRawLine(service.extra, raw.slice(4));
          }
          continue;
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
        if (service && extraKey && indent > 4) {
          service.extra = appendRawLine(service.extra, raw.slice(4));
          continue;
        }
        if (service && indent === 6 && text.startsWith('- ') && listKey) {
          appendParsedServiceListValue(service, listKey, unquoteYaml(text.slice(2)));
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
      resource = { name, external: false, driver: '', extra: '' };
      (section === 'networks' ? networks : volumes).push(resource);
      continue;
    }

    if ((section === 'networks' || section === 'volumes') && indent === 4 && resource) {
      const [key, ...rest] = text.split(':');
      const value = unquoteYaml(rest.join(':').trim());
      if (key === 'external') {
        resource.external = value === 'true';
      } else if (key === 'driver') {
        resource.driver = value;
      } else {
        resource.extra = appendRawLine(resource.extra, text);
      }
      continue;
    }
  }

  return { services, networks, volumes };
}

function blankBuilderService(name: string, build: string, networks: string): Omit<ComposeBuilderService, 'id'> {
  return {
    name,
    image: '',
    build,
    dockerfile: '',
    containerName: '',
    command: '',
    restart: 'unless-stopped',
    networkMode: '',
    init: false,
    ports: '',
    expose: '',
    environment: '',
    volumes: '',
    networks,
    dependsOn: '',
    dependsOnAdvanced: '',
    profiles: '',
    extra: ''
  };
}

function applyParsedServiceScalar(service: Omit<ComposeBuilderService, 'id'>, key: string, value: string) {
  if (key === 'image' || key === 'build' || key === 'dockerfile' || key === 'command' || key === 'restart' || key === 'networkMode' || key === 'containerName') {
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
