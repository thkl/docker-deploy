import { Component, computed, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { ContainerFleetInventory, ContainerRecord, ProjectSummary } from '../../models/project';
import { ContainerLogStreamService, ContainerLogStreamEvent } from '../../services/container-log-stream';
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
  protected readonly store = inject(ProjectStore);
  private refreshTimer?: ReturnType<typeof setInterval>;
  private logSubscription?: Subscription;

  protected readonly inventory = signal<ContainerFleetInventory | null>(null);
  private readonly metricHistory = signal<Record<string, ContainerMetricSample[]>>(readMetricHistory());
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

  ngOnInit() {
    this.refresh();
    this.refreshTimer = setInterval(() => this.refresh(), 10_000);
  }

  ngOnDestroy() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.logSubscription?.unsubscribe();
  }

  protected refresh() {
    if (this.refreshing()) return;
    this.refreshing.set(true);
    this.error.set('');
    this.api.getContainerInventory().subscribe({
      next: (inventory) => {
        this.recordMetricSamples(inventory);
        this.inventory.set(inventory);
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
    const cutoff = at - metricHistoryWindowMs;
    const previous = this.metricHistory();
    const next: Record<string, ContainerMetricSample[]> = {};

    for (const server of inventory.servers) {
      if (server.error) {
        for (const [key, samples] of Object.entries(previous)) {
          if (key.startsWith(`${server.serverId}:`)) {
            const recent = samples.filter((sample) => sample.at >= cutoff && sample.at <= at).slice(-metricHistorySampleLimit);
            if (recent.length) next[key] = recent;
          }
        }
        continue;
      }

      for (const container of server.containers) {
        const key = `${server.serverId}:${container.id}`;
        const samples = (previous[key] ?? []).filter((sample) => sample.at >= cutoff && sample.at <= at);
        if (container.cpuPercent !== undefined || container.memoryPercent !== undefined) {
          const sample: ContainerMetricSample = {
            at,
            ...(container.cpuPercent !== undefined ? { cpuPercent: container.cpuPercent } : {}),
            ...(container.memoryPercent !== undefined ? { memoryPercent: container.memoryPercent } : {}),
          };
          const last = samples.at(-1);
          if (last?.at === at) samples[samples.length - 1] = sample;
          else if (!last || at > last.at) samples.push(sample);
        }
        if (samples.length) next[key] = samples.slice(-metricHistorySampleLimit);
      }
    }

    this.metricHistory.set(next);
    try {
      sessionStorage.setItem(metricHistoryStorageKey, JSON.stringify(next));
    } catch {
      // Sparklines still work for this page visit if browser storage is unavailable.
    }
  }
}
