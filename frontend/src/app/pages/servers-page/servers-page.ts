import { Component, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { forkJoin, Subscription } from 'rxjs';
import { ProjectSummary, ServerRecord, TraefikConfigValidation, TraefikDiagnosticStatus, TraefikImpactPreview } from '../../models/project';
import { readMigratedSessionStorageKey, removeSessionStorageKeys } from '../../services/browser-storage';
import { ControllerEvent, EventBusService } from '../../services/event-bus';
import { ProjectApi } from '../../services/project-api';
import { ProjectStore } from '../../state/project-store';

const pairingTokenStorageKey = 'deploy.agentPairingTokens';
const legacyPairingTokenStorageKey = 'updater.agentPairingTokens';
type ServerTab = 'name' | 'health' | 'traefik';

interface ServerActivityItem {
  id: string;
  serverId: string;
  title: string;
  detail: string;
  time: string;
  tone: 'neutral' | 'success' | 'warning' | 'danger';
}

@Component({
  selector: 'app-servers-page',
  imports: [ReactiveFormsModule],
  templateUrl: './servers-page.html',
  styleUrl: './servers-page.scss',
})
export class ServersPage implements OnInit, OnDestroy {
  private readonly api = inject(ProjectApi);
  private readonly eventBus = inject(EventBusService);
  private readonly fb = inject(NonNullableFormBuilder);
  private readonly store = inject(ProjectStore);
  private eventBusSubscription?: Subscription;

  protected readonly savingServer = signal(false);
  protected readonly pairingServer = signal('');
  protected readonly refreshingServer = signal('');
  protected readonly backingUpTraefik = signal('');
  protected readonly validatingTraefik = signal('');
  protected readonly previewingTraefikImpact = signal('');
  protected readonly deletingServer = signal('');
  protected readonly editingServer = signal('');
  protected readonly savingServerName = signal('');
  protected readonly serverNameDraft = signal('');
  protected readonly selectedServerId = signal('');
  protected readonly activeServerTab = signal<ServerTab>('name');
  protected readonly serverActivity = signal<ServerActivityItem[]>([]);
  protected readonly serverActivityState = signal<'connecting' | 'live' | 'error'>('connecting');
  protected readonly message = signal('');
  protected readonly error = signal('');
  protected readonly pairingTokens = signal<Record<string, string>>({});
  protected readonly traefikValidation = signal<Record<string, TraefikConfigValidation>>({});
  protected readonly traefikImpact = signal<Record<string, TraefikImpactPreview>>({});
  protected readonly servers = this.store.servers;
  protected readonly serverForm = this.fb.group({
    name: [''],
    baseUrl: ['http://', [Validators.required]],
    pairingToken: ['', [Validators.required]],
  });

  ngOnInit() {
    this.pairingTokens.set(readStoredPairingTokens());
    this.store.loadServers();
    this.connectServerActivity();
  }

  ngOnDestroy() {
    this.eventBusSubscription?.unsubscribe();
  }

  protected selectedServer() {
    const servers = this.servers();
    const selectedId = this.selectedServerId();
    return servers.find((server) => server.id === selectedId) ?? servers[0];
  }

  protected selectServer(server: ServerRecord) {
    this.selectedServerId.set(server.id);
    this.editingServer.set('');
    this.serverNameDraft.set('');
  }

  protected setServerTab(tab: ServerTab) {
    this.activeServerTab.set(tab);
  }

  protected serverActivityLabel() {
    return this.serverActivityState() === 'live'
      ? 'Live'
      : this.serverActivityState() === 'error'
        ? 'Stream lost'
        : 'Connecting';
  }

  protected visibleServerActivity(server?: ServerRecord) {
    return this.serverActivity().filter((event) => !server || !event.serverId || event.serverId === server.id).slice(0, 8);
  }

  protected saveServer() {
    this.message.set('');
    this.error.set('');

    if (this.serverForm.invalid) {
      this.serverForm.markAllAsTouched();
      this.error.set('Enter the agent URL and pairing token before saving.');
      return;
    }

    const payload = this.serverForm.getRawValue();
    this.savingServer.set(true);
    this.api.createServer(payload).subscribe({
      next: (server) => {
        this.storePairingToken(server.id, payload.pairingToken);
        this.serverForm.patchValue({
          name: server.name,
        });
        this.store.loadServers();
        this.message.set(`Remote server ${server.name} saved. Pairing token is loaded for this agent.`);
        this.savingServer.set(false);
      },
      error: (error) => {
        this.error.set(error?.status === 409
          ? error?.error?.error || 'This remote agent is already registered.'
          : error?.error?.error || 'Could not save remote server.');
        this.savingServer.set(false);
      },
    });
  }

  protected deleteServer(serverId: string) {
    this.deletingServer.set(serverId);
    this.message.set('');
    this.error.set('');
    this.api.deleteServer(serverId).subscribe({
      next: () => {
        this.removeStoredPairingToken(serverId);
        this.store.loadServers();
        this.message.set(`Remote agent ${serverId} removed.`);
        this.deletingServer.set('');
      },
      error: (error) => {
        this.error.set(error?.error?.error || 'Could not remove remote agent.');
        this.deletingServer.set('');
      },
    });
  }

  protected refreshServer(serverId: string) {
    this.refreshingServer.set(serverId);
    this.message.set('');
    this.error.set('');

    this.api.refreshServerHealth(serverId).subscribe({
      next: (server) => {
        this.store.loadServers();
        this.message.set(`${server.name} health refreshed.`);
        this.refreshingServer.set('');
      },
      error: (error) => {
        this.error.set(error?.error?.error || 'Could not refresh agent health.');
        this.refreshingServer.set('');
      },
    });
  }

  protected refreshAllServers() {
    const servers = this.servers();
    if (!servers.length) {
      return;
    }

    this.refreshingServer.set('all');
    this.message.set('');
    this.error.set('');

    forkJoin(servers.map((server) => this.api.refreshServerHealth(server.id))).subscribe({
      next: () => {
        this.store.loadServers();
        this.message.set('Agent health refreshed.');
        this.refreshingServer.set('');
      },
      error: (error) => {
        this.error.set(error?.error?.error || 'Could not refresh agent health.');
        this.refreshingServer.set('');
      },
    });
  }

  protected backupTraefik(server: ServerRecord) {
    this.backingUpTraefik.set(server.id);
    this.message.set('');
    this.error.set('');

    this.api.backupTraefik(server.id).subscribe({
      next: (backup) => {
        downloadJson(`deploy-traefik-${server.id}-${backup.createdAt.replace(/[:.]/g, '-')}.json`, backup);
        this.message.set(`Traefik backup exported for ${server.name}.`);
        this.backingUpTraefik.set('');
      },
      error: (error) => {
        this.error.set(error?.error?.error || 'Could not export Traefik backup.');
        this.backingUpTraefik.set('');
      },
    });
  }

  protected validateTraefik(server: ServerRecord) {
    this.validatingTraefik.set(server.id);
    this.message.set('');
    this.error.set('');

    this.api.validateTraefik(server.id).subscribe({
      next: (validation) => {
        this.traefikValidation.update((current) => ({ ...current, [server.id]: validation }));
        this.message.set(`Traefik validation ${validation.status} for ${server.name}.`);
        this.validatingTraefik.set('');
      },
      error: (error) => {
        this.error.set(error?.error?.error || 'Could not validate Traefik config.');
        this.validatingTraefik.set('');
      },
    });
  }

  protected previewTraefikImpact(server: ServerRecord) {
    this.previewingTraefikImpact.set(server.id);
    this.message.set('');
    this.error.set('');

    this.api.previewTraefikImpact(server.id).subscribe({
      next: (preview) => {
        this.traefikImpact.update((current) => ({ ...current, [server.id]: preview }));
        this.message.set(`${preview.projectCount} Traefik project${preview.projectCount === 1 ? '' : 's'} found on ${server.name}.`);
        this.previewingTraefikImpact.set('');
      },
      error: (error) => {
        this.error.set(error?.error?.error || 'Could not preview Traefik impact.');
        this.previewingTraefikImpact.set('');
      },
    });
  }

  protected pairServer(serverId: string) {
    const pairingToken = this.pairingTokens()[serverId] || this.serverForm.controls.pairingToken.value.trim();
    if (!pairingToken) {
      this.error.set('Enter the agent pairing token before pairing.');
      return;
    }

    this.pairingServer.set(serverId);
    this.message.set('');
    this.error.set('');
    this.api.pairServer(serverId, pairingToken).subscribe({
      next: (server) => {
        this.store.loadServers();
        this.message.set(`Remote server ${server.name} paired.`);
        this.removeStoredPairingToken(server.id);
        this.serverForm.reset({
          name: '',
          baseUrl: 'http://',
          pairingToken: '',
        });
        this.pairingServer.set('');
      },
      error: (error) => {
        this.error.set(error?.error?.error || 'Could not pair remote server.');
        this.pairingServer.set('');
      },
    });
  }

  protected startRename(server: ServerRecord) {
    this.editingServer.set(server.id);
    this.serverNameDraft.set(server.name);
    this.message.set('');
    this.error.set('');
  }

  protected updateServerNameDraft(event: Event) {
    this.serverNameDraft.set((event.target as HTMLInputElement).value);
  }

  protected cancelRename() {
    if (this.savingServerName()) {
      return;
    }

    this.editingServer.set('');
    this.serverNameDraft.set('');
  }

  protected saveServerName(server: ServerRecord) {
    const nextName = this.serverNameDraft().trim();
    if (!nextName) {
      this.error.set('Enter a server name before saving.');
      return;
    }

    this.savingServerName.set(server.id);
    this.message.set('');
    this.error.set('');
    this.api.updateServer(server.id, {
      name: nextName,
      ...(server.kind === 'remote' ? { baseUrl: server.baseUrl } : {}),
    }).subscribe({
      next: (updated) => {
        this.store.loadServers();
        this.message.set(`Server ${updated.id} renamed to ${updated.name}.`);
        this.editingServer.set('');
        this.serverNameDraft.set('');
        this.savingServerName.set('');
      },
      error: (error) => {
        this.error.set(error?.error?.error || 'Could not rename server.');
        this.savingServerName.set('');
      },
    });
  }

  protected formatDate(value?: string) {
    if (!value) {
      return 'Never';
    }

    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date(value));
  }

  private connectServerActivity() {
    this.eventBusSubscription = this.eventBus.stream().subscribe({
      next: (event) => {
        this.serverActivityState.set('live');
        const item = this.toServerActivityItem(event);
        if (item) {
          this.upsertServerActivity(item);
        }
      },
      error: () => {
        this.serverActivityState.set('error');
      },
    });
  }

  private upsertServerActivity(item: ServerActivityItem) {
    this.serverActivity.update((events) => {
      const next = events.filter((event) => event.id !== item.id);
      return [item, ...next].slice(0, 80);
    });
  }

  private toServerActivityItem(event: ControllerEvent): ServerActivityItem | null {
    if (event.type === 'connected') {
      return {
        id: `connected:${event.connectedAt}`,
        serverId: '',
        title: 'Agent activity connected',
        detail: 'Controller events are flowing to this browser.',
        time: event.connectedAt,
        tone: 'success',
      };
    }

    if (event.type === 'servers.updated') {
      return {
        id: `servers.updated:${event.changedAt}`,
        serverId: '',
        title: 'Server list changed',
        detail: 'Server or agent configuration was updated.',
        time: event.changedAt,
        tone: 'neutral',
      };
    }

    if (event.type === 'server.health') {
      const activeJobs = event.server.activeJobs?.length ?? 0;
      return {
        id: `server.health:${event.server.id}:${event.server.updatedAt}`,
        serverId: event.server.id,
        title: `${event.server.name} ${event.server.status || 'unknown'}`,
        detail: [
          event.server.agentVersion ? `version ${event.server.agentVersion}` : 'version unknown',
          activeJobs === 1 ? '1 active job' : `${activeJobs} active jobs`,
          event.server.lastHealthError || '',
        ].filter(Boolean).join(' · '),
        time: event.server.lastSeenAt || event.server.updatedAt,
        tone: event.server.status === 'online'
          ? activeJobs > 0 ? 'warning' : 'success'
          : event.server.status === 'unpaired'
            ? 'warning'
            : 'danger',
      };
    }

    if (event.type === 'deployment.updated' && event.deployment?.serverId) {
      return {
        id: `deployment.updated:${event.deployment.id}:${event.deployment.status}`,
        serverId: event.deployment.serverId,
        title: `${event.deployment.projectName} deployment ${event.deployment.status}`,
        detail: `${event.deployment.trigger} deploy on ${event.deployment.serverId}`,
        time: event.deployment.finishedAt || event.deployment.startedAt,
        tone: event.deployment.status === 'succeeded'
          ? 'success'
          : event.deployment.status === 'failed'
            ? 'danger'
            : 'warning',
      };
    }

    if (event.type === 'runtime.operation.updated') {
      return {
        id: `runtime.operation.updated:${event.operation.id}`,
        serverId: event.operation.serverId,
        title: `${event.projectName} ${event.operation.action} ${event.operation.status}`,
        detail: `${event.operation.service} on ${event.operation.serverId}`,
        time: event.operation.finishedAt,
        tone: event.operation.status === 'succeeded' ? 'success' : 'danger',
      };
    }

    return null;
  }

  protected activeJobLabel(server: ServerRecord) {
    const count = server.activeJobs?.length ?? 0;
    return count === 1 ? '1 active job' : `${count} active jobs`;
  }

  protected managedProjects(server: ServerRecord) {
    return this.store.projects().filter((project) => (project.serverId || 'local') === server.id);
  }

  protected managedContainerCount(server: ServerRecord) {
    return this.managedProjects(server).reduce((count, project) => count + (this.store.runtimeStatusFor(project.id)?.services.length ?? 0), 0);
  }

  protected managedContainerLabel(server: ServerRecord) {
    const projects = this.managedProjects(server);
    const containers = this.managedContainerCount(server);
    if (!projects.length) {
      return 'No managed projects';
    }

    if (containers === 1) {
      return `1 known container · ${projects.length} project${projects.length === 1 ? '' : 's'}`;
    }

    return `${containers} known containers · ${projects.length} project${projects.length === 1 ? '' : 's'}`;
  }

  protected projectContainerLabel(project: ProjectSummary) {
    const status = this.store.runtimeStatusFor(project.id);
    if (!status) {
      return 'status not checked';
    }

    const count = status.services.length;
    return count === 1 ? '1 container' : `${count} containers`;
  }

  protected projectContainerServices(project: ProjectSummary) {
    return this.store.runtimeStatusFor(project.id)?.services ?? [];
  }

  protected traefikLabel(server: ServerRecord) {
    const traefik = server.capabilities?.traefik;
    if (!traefik) {
      return 'Traefik unknown';
    }

    if (traefik.available) {
      return `Available · ${traefik.containerCount} container${traefik.containerCount === 1 ? '' : 's'}`;
    }

    return traefik.networkPresent ? 'Network exists, no container' : 'Not detected';
  }

  protected traefikValue(values?: string[], fallback = 'Not detected') {
    return values?.length ? values.join(', ') : fallback;
  }

  protected traefikProviderNetwork(server: ServerRecord) {
    return server.capabilities?.traefik.dockerProviderNetwork || 'Not detected';
  }

  protected traefikAcmeStorage(server: ServerRecord) {
    return server.capabilities?.traefik.acmeStorage || 'Not detected';
  }

  protected traefikMountLabel(mount: { source: string; target: string }) {
    return `${mount.source} -> ${mount.target}`;
  }

  protected validationFor(server: ServerRecord) {
    return this.traefikValidation()[server.id];
  }

  protected validationTone(status: TraefikDiagnosticStatus) {
    return status;
  }

  protected impactFor(server: ServerRecord) {
    return this.traefikImpact()[server.id];
  }

  protected projectDefaultUsage(project: TraefikImpactPreview['projects'][number]) {
    const defaults = [
      project.usesDefaultNetwork ? 'network' : '',
      project.usesDefaultEntryPoints ? 'entrypoints' : '',
      project.usesDefaultCertResolver ? 'cert resolver' : '',
    ].filter(Boolean);

    return defaults.length ? `Uses defaults: ${defaults.join(', ')}` : 'Explicit proxy settings';
  }

  protected memoryLabel(server: ServerRecord) {
    const memory = server.capabilities?.system?.memory;
    if (!memory) {
      return 'Memory unknown';
    }

    return `${this.formatBytes(memory.usedBytes)} / ${this.formatBytes(memory.totalBytes)}`;
  }

  protected memoryPercent(server: ServerRecord) {
    const memory = server.capabilities?.system?.memory;
    return memory?.totalBytes ? Math.round((memory.usedBytes / memory.totalBytes) * 100) : 0;
  }

  protected diskLabel(server: ServerRecord) {
    const disk = server.capabilities?.system?.disk;
    if (!disk) {
      return 'Disk unknown';
    }

    return `${this.formatBytes(disk.usedBytes)} / ${this.formatBytes(disk.totalBytes)}`;
  }

  protected diskPercent(server: ServerRecord) {
    return Math.round(server.capabilities?.system?.disk?.usedPercent ?? 0);
  }

  protected loadLabel(server: ServerRecord) {
    const system = server.capabilities?.system;
    if (!system) {
      return 'Load unknown';
    }

    const load = system.loadAverage[0] ?? 0;
    return `${load.toFixed(2)} on ${system.cpuCount} CPU${system.cpuCount === 1 ? '' : 's'}`;
  }

  protected loadPercent(server: ServerRecord) {
    const system = server.capabilities?.system;
    if (!system?.cpuCount) {
      return 0;
    }

    return Math.min(100, Math.round(((system.loadAverage[0] ?? 0) / system.cpuCount) * 100));
  }

  protected metricCheckedAt(server: ServerRecord) {
    return this.formatDate(server.capabilities?.system?.checkedAt);
  }

  protected statusTone(server: ServerRecord) {
    return server.status === 'online'
      ? 'online'
      : server.status === 'unpaired'
        ? 'unpaired'
        : 'offline';
  }

  private formatBytes(value: number) {
    if (!Number.isFinite(value)) {
      return 'unknown';
    }

    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let current = value;
    let unit = 0;
    while (current >= 1024 && unit < units.length - 1) {
      current /= 1024;
      unit += 1;
    }

    return `${current >= 10 || unit === 0 ? current.toFixed(0) : current.toFixed(1)} ${units[unit]}`;
  }

  private storePairingToken(serverId: string, pairingToken: string) {
    if (!pairingToken) {
      return;
    }

    this.pairingTokens.update((tokens) => {
      const next = { ...tokens, [serverId]: pairingToken };
      sessionStorage.setItem(pairingTokenStorageKey, JSON.stringify(next));
      sessionStorage.removeItem(legacyPairingTokenStorageKey);
      return next;
    });
  }

  private removeStoredPairingToken(serverId: string) {
    this.pairingTokens.update((tokens) => {
      const next = { ...tokens };
      delete next[serverId];
      sessionStorage.setItem(pairingTokenStorageKey, JSON.stringify(next));
      sessionStorage.removeItem(legacyPairingTokenStorageKey);
      return next;
    });
  }
}

function readStoredPairingTokens(): Record<string, string> {
  try {
    return JSON.parse(readMigratedSessionStorageKey(pairingTokenStorageKey, legacyPairingTokenStorageKey) || '{}') as Record<string, string>;
  } catch {
    removeSessionStorageKeys(pairingTokenStorageKey, legacyPairingTokenStorageKey);
    return {};
  }
}

function downloadJson(filename: string, value: unknown) {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
