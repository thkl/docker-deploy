import { Component, computed, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { ContainerFleetInventory, ContainerRecord, ContainerStatsSample, ProjectSummary } from '../../models/project';
import { ContainerLogStreamService, ContainerLogStreamEvent } from '../../services/container-log-stream';
import { ContainerStatsStreamEvent, ContainerStatsStreamService } from '../../services/container-stats-stream';
import { ProjectApi } from '../../services/project-api';
import { ProjectStore } from '../../state/project-store';

interface ContainerRow extends ContainerRecord {
  serverId: string;
  serverName: string;
}

type ContainerMetricName = 'cpu' | 'memory';

interface ContainerMetricSample {
  at: number;
  cpuPercent?: number;
  memoryPercent?: number;
}

const metricHistoryStorageKey = 'updater.container-metric-history.v1';
const metricHistoryWindowMs = 10 * 60 * 1000;
const metricHistorySampleLimit = 60;
const inventoryRefreshIntervalMs = 60_000;

function readMetricHistory(): Record<string, ContainerMetricSample[]> {
  try {
    const raw = sessionStorage.getItem(metricHistoryStorageKey);
    if (!raw) return {};

    const stored = JSON.parse(raw) as Record<string, unknown>;
    const cutoff = Date.now() - metricHistoryWindowMs;
    const history: Record<string, ContainerMetricSample[]> = {};
    for (const [key, value] of Object.entries(stored)) {
      if (!Array.isArray(value)) continue;
      const samples = value.filter((sample): sample is ContainerMetricSample => {
        if (!sample || typeof sample !== 'object') return false;
        const candidate = sample as ContainerMetricSample;
        return Number.isFinite(candidate.at)
          && candidate.at >= cutoff
          && candidate.at <= Date.now()
          && (Number.isFinite(candidate.cpuPercent) || Number.isFinite(candidate.memoryPercent));
      }).slice(-metricHistorySampleLimit);
      if (samples.length) history[key] = samples;
    }
    return history;
  } catch {
    return {};
  }
}

@Component({
  selector: 'app-containers-page',
  imports: [RouterLink],
  templateUrl: './containers-page.html',
  styleUrl: './containers-page.scss',
})
export class ContainersPage implements OnInit, OnDestroy {
  private readonly api = inject(ProjectApi);
  private readonly logStream = inject(ContainerLogStreamService);
  private readonly statsStream = inject(ContainerStatsStreamService);
  protected readonly store = inject(ProjectStore);
  private refreshTimer?: ReturnType<typeof setInterval>;
  private logSubscription?: Subscription;
  private readonly statsSubscriptions = new Map<string, Subscription>();
  private lastUnknownInventoryRefreshAt = 0;

  protected readonly inventory = signal<ContainerFleetInventory | null>(null);
  private readonly metricHistory = signal<Record<string, ContainerMetricSample[]>>(readMetricHistory());
  private readonly statsStreamStates = signal<Record<string, 'connecting' | 'live' | 'closed' | 'error'>>({});
  protected readonly loading = signal(true);
  protected readonly refreshing = signal(false);
  protected readonly error = signal('');
  protected readonly serverFilter = signal('all');
  protected readonly stateFilter = signal('all');
  protected readonly query = signal('');
  protected readonly selectedContainerKey = signal('');
  protected readonly logTail = signal(200);
  protected readonly logSearch = signal('');
  protected readonly logOutput = signal('');
  protected readonly logState = signal<'connecting' | 'live' | 'closed' | 'error'>('closed');
  protected readonly logError = signal('');

  protected readonly containers = computed<ContainerRow[]>(() => (this.inventory()?.servers ?? []).flatMap((server) =>
    server.containers.map((container) => ({ ...container, serverId: server.serverId, serverName: server.serverName })),
  ));
  protected readonly visibleContainers = computed(() => {
    const query = this.query().trim().toLowerCase();
    return this.containers().filter((container) => {
      if (this.serverFilter() !== 'all' && container.serverId !== this.serverFilter()) return false;
      if (this.stateFilter() === 'running' && container.state !== 'running') return false;
      if (this.stateFilter() === 'stopped' && container.state === 'running') return false;
      if (this.stateFilter() === 'unhealthy' && container.health !== 'unhealthy') return false;
      if (!query) return true;
      return [container.name, container.image, container.id, container.composeProject, container.composeService, container.serverName]
        .some((value) => value?.toLowerCase().includes(query));
    }).sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })
      || left.serverName.localeCompare(right.serverName, undefined, { numeric: true, sensitivity: 'base' }));
  });
  protected readonly selectedContainer = computed(() => this.containers().find((container) => this.keyFor(container) === this.selectedContainerKey()) ?? null);
  protected readonly filteredLogOutput = computed(() => {
    const output = this.logOutput();
    const query = this.logSearch().trim().toLowerCase();
    if (!query) return output;
    return output.split('\n').filter((line) => line.toLowerCase().includes(query)).join('\n');
  });
  protected readonly runningCount = computed(() => this.containers().filter((container) => container.state === 'running').length);
  protected readonly unhealthyCount = computed(() => this.containers().filter((container) => container.health === 'unhealthy').length);
  protected readonly stoppedCount = computed(() => this.containers().filter((container) => container.state !== 'running').length);
  protected readonly failedServers = computed(() => (this.inventory()?.servers ?? []).filter((server) => server.error));
  protected readonly statsStreamLabel = computed(() => {
    const servers = this.inventory()?.servers ?? [];
    if (!servers.length) return 'Waiting for Docker hosts';
    const states = servers.map((server) => this.statsStreamStates()[server.serverId]);
    const live = states.filter((state) => state === 'live').length;
    if (live === states.length) return `Live metrics · ${live} host${live === 1 ? '' : 's'}`;
    if (states.some((state) => state === 'error')) return `Stats reconnecting · ${live}/${states.length} hosts`;
    if (live) return `Streaming stats · ${live}/${states.length} hosts`;
    return 'Connecting to live Docker stats…';
  });

  ngOnInit() {
    this.refresh();
    this.refreshTimer = setInterval(() => this.refresh(), inventoryRefreshIntervalMs);
  }

  ngOnDestroy() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.logSubscription?.unsubscribe();
    for (const subscription of this.statsSubscriptions.values()) subscription.unsubscribe();
    this.statsSubscriptions.clear();
  }

  protected refresh() {
    if (this.refreshing()) return;
    this.refreshing.set(true);
    this.error.set('');
    this.api.getContainerInventory().subscribe({
      next: (inventory) => {
        this.recordMetricSamples(inventory);
        this.inventory.set(inventory);
        this.syncStatsStreams(inventory.servers.map((server) => server.serverId));
        this.loading.set(false);
        this.refreshing.set(false);
        if (this.selectedContainerKey() && !this.selectedContainer()) this.closeLogs();
      },
      error: (error) => {
        this.error.set(error?.error?.error || 'Could not load container inventory.');
        this.loading.set(false);
        this.refreshing.set(false);
      },
    });
  }

  protected selectServer(event: Event) {
    this.serverFilter.set((event.target as HTMLSelectElement).value);
  }

  protected selectState(event: Event) {
    this.stateFilter.set((event.target as HTMLSelectElement).value);
  }

  protected updateQuery(event: Event) {
    this.query.set((event.target as HTMLInputElement).value);
  }

  protected updateLogSearch(event: Event) {
    this.logSearch.set((event.target as HTMLInputElement).value);
  }

  protected selectLogTail(event: Event) {
    const tail = Number((event.target as HTMLSelectElement).value) || 200;
    this.logTail.set(tail);
    const selected = this.selectedContainer();
    if (selected) this.openLogs(selected);
  }

  protected openLogs(container: ContainerRow) {
    this.logSubscription?.unsubscribe();
    this.selectedContainerKey.set(this.keyFor(container));
    this.logOutput.set('');
    this.logSearch.set('');
    this.logError.set('');
    this.logState.set('connecting');
    this.logSubscription = this.logStream.follow(container.serverId, container.id, this.logTail()).subscribe({
      next: (event) => this.handleLogEvent(event),
      error: (error) => {
        this.logState.set('error');
        this.logError.set(error instanceof Error ? error.message : 'Container log stream failed.');
      },
      complete: () => {
        if (this.logState() !== 'error') this.logState.set('closed');
      },
    });
  }

  protected closeLogs() {
    this.logSubscription?.unsubscribe();
    this.logSubscription = undefined;
    this.selectedContainerKey.set('');
    this.logOutput.set('');
    this.logState.set('closed');
    this.logError.set('');
  }

  protected keyFor(container: ContainerRow) {
    return `${container.serverId}:${container.id}`;
  }

  protected matchingProject(container: ContainerRow): ProjectSummary | null {
    if (!container.composeProject) return null;
    return this.store.projects().find((project) => {
      const targetServerIds = project.serverIds?.length ? project.serverIds : [project.serverId || 'local'];
      const projectPathName = project.path?.trim().replace(/[\\/]+$/, '').split(/[\\/]/).pop();
      const composeName = (projectPathName || project.name).toLowerCase();
      return targetServerIds.includes(container.serverId) && composeName === container.composeProject?.toLowerCase();
    }) ?? null;
  }

  protected stateTone(container: ContainerRecord) {
    if (container.state === 'running') return 'good';
    if (container.state === 'exited' || container.state === 'dead') return 'bad';
    return 'neutral';
  }

  protected healthTone(health?: string) {
    if (health === 'healthy') return 'good';
    if (health === 'unhealthy') return 'bad';
    if (health === 'starting') return 'warning';
    return 'neutral';
  }

  protected healthLabel(health?: string) {
    return health || 'No check';
  }

  protected formatPercent(value?: number) {
    return value === undefined ? '—' : `${value.toFixed(1)}%`;
  }

  protected metricSparklinePoints(container: ContainerRow, metric: ContainerMetricName) {
    const property = metric === 'cpu' ? 'cpuPercent' : 'memoryPercent';
    const samples = (this.metricHistory()[this.keyFor(container)] ?? [])
      .filter((sample) => Number.isFinite(sample[property]));
    if (samples.length < 2) return null;

    const values = samples.map((sample) => sample[property]!);
    const min = Math.min(...values);
    const range = Math.max(...values) - min;
    const firstAt = samples[0].at;
    const duration = samples.at(-1)!.at - firstAt;
    return samples.map((sample, index) => {
      const x = 2 + (duration > 0 ? (sample.at - firstAt) / duration : index / (samples.length - 1)) * 68;
      const value = sample[property]!;
      const y = 16 - (range > 0 ? ((value - min) / range) * 12 : 6);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
  }

  protected metricSparklineLabel(container: ContainerRow, metric: ContainerMetricName) {
    const property = metric === 'cpu' ? 'cpuPercent' : 'memoryPercent';
    const values = (this.metricHistory()[this.keyFor(container)] ?? [])
      .map((sample) => sample[property])
      .filter((value): value is number => Number.isFinite(value));
    const label = metric === 'cpu' ? 'CPU' : 'Memory';
    return `${label} usage trend for the last 10 minutes; latest ${this.formatPercent(values.at(-1))}; ${values.length} samples`;
  }

  private syncStatsStreams(serverIds: string[]) {
    const targets = new Set(serverIds);
    for (const [serverId, subscription] of this.statsSubscriptions) {
      if (targets.has(serverId)) continue;
      subscription.unsubscribe();
      this.statsSubscriptions.delete(serverId);
      this.statsStreamStates.update((states) => {
        const next = { ...states };
        delete next[serverId];
        return next;
      });
    }

    for (const serverId of targets) {
      if (this.statsSubscriptions.has(serverId)) continue;
      this.setStatsStreamState(serverId, 'connecting');
      const subscription = this.statsStream.follow(serverId).subscribe({
        next: (event) => this.handleStatsStreamEvent(serverId, event),
        error: () => this.setStatsStreamState(serverId, 'error'),
        complete: () => this.setStatsStreamState(serverId, 'closed'),
      });
      this.statsSubscriptions.set(serverId, subscription);
    }
  }

  private handleStatsStreamEvent(serverId: string, event: ContainerStatsStreamEvent) {
    if (event.type === 'status') {
      this.setStatsStreamState(serverId, event.status);
      return;
    }
    if (event.type === 'error') {
      this.setStatsStreamState(serverId, 'error');
      return;
    }
    this.applyStatsSamples(serverId, event.samples);
  }

  private setStatsStreamState(serverId: string, status: 'connecting' | 'live' | 'closed' | 'error') {
    this.statsStreamStates.update((states) => ({ ...states, [serverId]: status }));
  }

  private applyStatsSamples(serverId: string, samples: ContainerStatsSample[]) {
    const inventory = this.inventory();
    if (!inventory || !samples.length) return;

    const historyEntries: Array<{ key: string; sample: ContainerMetricSample }> = [];
    let hasUnknownContainer = false;
    let changed = false;
    const servers = inventory.servers.map((server) => {
      if (server.serverId !== serverId) return server;
      hasUnknownContainer = samples.some((sample) => !server.containers.some((container) => this.statsSampleMatches(container, sample)));
      let serverChanged = false;
      const containers = server.containers.map((container) => {
        const sample = samples.find((candidate) => this.statsSampleMatches(container, candidate));
        if (!sample) return container;
        serverChanged = true;
        changed = true;
        const at = Date.parse(sample.checkedAt) || Date.now();
        if (sample.cpuPercent !== undefined || sample.memoryPercent !== undefined) {
          historyEntries.push({
            key: this.keyFor({ ...container, serverId, serverName: server.serverName }),
            sample: {
              at,
              ...(sample.cpuPercent !== undefined ? { cpuPercent: sample.cpuPercent } : {}),
              ...(sample.memoryPercent !== undefined ? { memoryPercent: sample.memoryPercent } : {}),
            },
          });
        }
        return {
          ...container,
          state: 'running',
          cpuPercent: sample.cpuPercent,
          memoryUsage: sample.memoryUsage,
          memoryPercent: sample.memoryPercent,
          networkIo: sample.networkIo,
          blockIo: sample.blockIo,
          processCount: sample.processCount,
        };
      });
      return serverChanged ? { ...server, checkedAt: samples.at(-1)!.checkedAt, containers } : server;
    });

    if (changed) {
      this.inventory.set({ ...inventory, checkedAt: samples.at(-1)!.checkedAt, servers });
      this.storeMetricHistory(historyEntries);
    }
    if (hasUnknownContainer && Date.now() - this.lastUnknownInventoryRefreshAt > 15_000) {
      this.lastUnknownInventoryRefreshAt = Date.now();
      this.refresh();
    }
  }

  private statsSampleMatches(container: ContainerRecord, sample: ContainerStatsSample) {
    const containerId = container.id.toLowerCase();
    const sampleId = sample.id.toLowerCase();
    return containerId === sampleId
      || containerId.startsWith(sampleId)
      || sampleId.startsWith(containerId)
      || container.name === sample.name;
  }

  protected formatDate(value?: string) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  }

  protected logStateLabel() {
    return this.logState() === 'live' ? 'Live' : this.logState() === 'connecting' ? 'Connecting' : this.logState() === 'error' ? 'Stream error' : 'Closed';
  }

  private handleLogEvent(event: ContainerLogStreamEvent) {
    if (event.type === 'status') {
      this.logState.set(event.status);
      return;
    }
    if (event.type === 'error') {
      this.logState.set('error');
      this.logError.set(event.error);
      return;
    }

    this.logOutput.update((output) => `${output}${event.chunk}`.slice(-1_500_000));
  }

  private recordMetricSamples(inventory: ContainerFleetInventory) {
    const at = Date.parse(inventory.checkedAt) || Date.now();
    const entries: Array<{ key: string; sample: ContainerMetricSample }> = [];
    for (const server of inventory.servers) {
      for (const container of server.containers) {
        if (container.cpuPercent !== undefined || container.memoryPercent !== undefined) {
          entries.push({
            key: `${server.serverId}:${container.id}`,
            sample: {
              at,
              ...(container.cpuPercent !== undefined ? { cpuPercent: container.cpuPercent } : {}),
              ...(container.memoryPercent !== undefined ? { memoryPercent: container.memoryPercent } : {}),
            },
          });
        }
      }
    }
    this.storeMetricHistory(entries);
  }

  private storeMetricHistory(entries: Array<{ key: string; sample: ContainerMetricSample }>) {
    if (!entries.length) return;
    const cutoff = Date.now() - metricHistoryWindowMs;
    const previous = this.metricHistory();
    const next: Record<string, ContainerMetricSample[]> = {};
    for (const [key, samples] of Object.entries(previous)) {
      const recent = samples.filter((sample) => sample.at >= cutoff).slice(-metricHistorySampleLimit);
      if (recent.length) next[key] = recent;
    }

    let changed = false;
    for (const { key, sample } of entries) {
      const samples = next[key] ?? [];
      const last = samples.at(-1);
      if (last?.at === sample.at) {
        samples[samples.length - 1] = { ...last, ...sample };
        next[key] = samples;
        changed = true;
      } else if (!last || sample.at - last.at >= 10_000) {
        samples.push(sample);
        next[key] = samples.slice(-metricHistorySampleLimit);
        changed = true;
      }
    }
    if (!changed) return;

    this.metricHistory.set(next);
    try {
      sessionStorage.setItem(metricHistoryStorageKey, JSON.stringify(next));
    } catch {
      // Sparklines still work for this page visit if browser storage is unavailable.
    }
  }
}
