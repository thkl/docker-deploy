import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { Subscription } from 'rxjs';
import { ProjectPreflightResult, ProjectSummary, RuntimeStatus, ServerRecord } from '../models/project';
import { readMigratedLocalStorageKey, removeLocalStorageKeys } from '../services/browser-storage';
import { ControllerEvent, EventBusService } from '../services/event-bus';
import { ProjectApi } from '../services/project-api';

const selectedProjectKey = 'deploy.selectedProject';
const legacySelectedProjectKey = 'updater.selectedProject';

@Injectable({ providedIn: 'root' })
export class ProjectStore {
  private readonly api = inject(ProjectApi);
  private readonly eventBus = inject(EventBusService);
  private readonly selectedId = signal(readMigratedLocalStorageKey(selectedProjectKey, legacySelectedProjectKey) ?? '');
  private eventBusSubscription?: Subscription;

  readonly projects = signal<ProjectSummary[]>([]);
  readonly servers = signal<ServerRecord[]>([]);
  readonly runtimeStatuses = signal<Record<string, RuntimeStatus>>({});
  readonly preflightResults = signal<Record<string, ProjectPreflightResult>>({});
  readonly runtimeStatusLoading = signal<Record<string, boolean>>({});
  readonly loading = signal(false);
  readonly error = signal('');
  readonly selectedProjectId = this.selectedId.asReadonly();
  readonly selectedProject = computed(() =>
    this.projects().find((project) => project.id === this.selectedId()) ?? null,
  );
  readonly selectedProjectServer = computed(() => {
    const project = this.selectedProject();
    return this.servers().find((server) => server.id === (project?.serverId ?? 'local')) ?? null;
  });

  constructor() {
    effect(() => {
      const id = this.selectedId();
      if (id) {
        localStorage.setItem(selectedProjectKey, id);
        localStorage.removeItem(legacySelectedProjectKey);
      } else {
        removeLocalStorageKeys(selectedProjectKey, legacySelectedProjectKey);
      }
    });
  }

  loadProjects() {
    this.loading.set(true);
    this.error.set('');

    this.api.listProjects().subscribe({
      next: (projects) => {
        this.projects.set(projects);
        const selected = this.selectedId();
        const selectedProject = projects.find((project) => project.id === selected) ?? projects.find((project) => project.name === selected);
        if (selectedProject) {
          this.selectedId.set(selectedProject.id);
        } else {
          this.selectedId.set(projects[0]?.id ?? '');
        }
        this.connectEventBus();
        this.loading.set(false);
      },
      error: () => {
        this.error.set('Could not load projects.');
        this.loading.set(false);
      },
    });
  }

  loadServers() {
    this.api.listServers().subscribe({
      next: (servers) => {
        this.servers.set(servers);
      },
      error: () => {
        this.error.set('Could not load servers.');
      },
    });
  }

  selectProject(projectRef: string) {
    const project = this.projects().find((candidate) => candidate.id === projectRef || candidate.name === projectRef);
    this.selectedId.set(project?.id ?? projectRef);
  }

  runtimeStatusFor(projectRef: string) {
    const project = this.projects().find((candidate) => candidate.id === projectRef || candidate.name === projectRef);
    return this.runtimeStatuses()[project?.id ?? projectRef] ?? null;
  }

  refreshRuntimeStatus(projectRef: string) {
    const project = this.projects().find((candidate) => candidate.id === projectRef || candidate.name === projectRef);
    if (!project) {
      return;
    }

    this.runtimeStatusLoading.update((statuses) => ({ ...statuses, [project.id]: true }));
    this.api.getProjectStatus(project.id).subscribe({
      next: (status) => {
        this.runtimeStatuses.update((statuses) => ({ ...statuses, [project.id]: status }));
        this.runtimeStatusLoading.update((statuses) => ({ ...statuses, [project.id]: false }));
      },
      error: () => {
        this.runtimeStatuses.update((statuses) => ({
          ...statuses,
          [project.id]: {
            status: 'error',
            checkedAt: new Date().toISOString(),
            services: [],
            error: 'Could not inspect runtime status.',
          },
        }));
        this.runtimeStatusLoading.update((statuses) => ({ ...statuses, [project.id]: false }));
      },
    });
  }

  setRuntimeStatus(projectRef: string, status: RuntimeStatus) {
    const project = this.projects().find((candidate) => candidate.id === projectRef || candidate.name === projectRef);
    this.runtimeStatuses.update((statuses) => ({ ...statuses, [project?.id ?? projectRef]: status }));
  }

  preflightFor(projectRef: string) {
    const project = this.projects().find((candidate) => candidate.id === projectRef || candidate.name === projectRef);
    return this.preflightResults()[project?.id ?? projectRef] ?? null;
  }

  setPreflight(projectRef: string, result: ProjectPreflightResult) {
    const project = this.projects().find((candidate) => candidate.id === projectRef || candidate.name === projectRef);
    this.preflightResults.update((results) => ({ ...results, [project?.id ?? result.projectId ?? projectRef]: result }));
  }

  private loadRuntimeStatuses(projects: ProjectSummary[]) {
    const currentIds = new Set(projects.map((project) => project.id));
    this.runtimeStatuses.update((statuses) =>
      Object.fromEntries(Object.entries(statuses).filter(([id]) => currentIds.has(id))),
    );
  }

  private connectEventBus() {
    this.loadRuntimeStatuses(this.projects());
    if (this.eventBusSubscription) {
      return;
    }

    this.eventBusSubscription = this.eventBus.stream().subscribe({
      next: (event) => this.handleControllerEvent(event),
      error: () => {
        this.eventBusSubscription = undefined;
      },
    });
  }

  private handleControllerEvent(event: ControllerEvent) {
    if (event.type === 'projects.updated') {
      this.loadProjects();
      return;
    }

    if (event.type === 'servers.updated') {
      this.loadServers();
      return;
    }

    if (event.type === 'server.health') {
      this.upsertServer(event.server);
      return;
    }

    if (event.type === 'runtime.status') {
      const project = this.projects().find((candidate) => candidate.id === event.projectId || candidate.name === event.projectName);
      this.runtimeStatuses.update((statuses) => ({ ...statuses, [project?.id ?? event.projectId ?? event.projectName]: event.status }));
      this.runtimeStatusLoading.update((statuses) => ({ ...statuses, [project?.id ?? event.projectId ?? event.projectName]: false }));
      return;
    }

    if (event.type === 'deployment.updated') {
      this.projects.update((projects) =>
        projects.map((project) => {
          if (project.id !== event.projectId && project.name !== event.projectName) {
            return project;
          }

          const previous = project.lastDeployment;
          const next = event.deployment && previous?.id === event.deployment.id && !event.deployment.log
            ? {
                ...event.deployment,
                log: previous.log,
                targets: event.deployment.targets?.map((target) => ({
                  ...target,
                  log: previous.targets?.find((candidate) => candidate.id === target.id)?.log ?? target.log,
                })),
              }
            : event.deployment;
          return { ...project, lastDeployment: next };
        }),
      );
    }
  }

  private upsertServer(server: ServerRecord) {
    this.servers.update((servers) => {
      const existingIndex = servers.findIndex((candidate) => candidate.id === server.id);
      if (existingIndex === -1) {
        return [...servers, server].sort((left, right) => left.name.localeCompare(right.name));
      }

      return servers.map((candidate) => (candidate.id === server.id ? server : candidate));
    });
  }
}
