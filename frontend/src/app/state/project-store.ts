import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { ProjectSummary, ServerRecord } from '../models/project';
import { ProjectApi } from '../services/project-api';

const selectedProjectKey = 'updater.selectedProject';

@Injectable({ providedIn: 'root' })
export class ProjectStore {
  private readonly api = inject(ProjectApi);
  private readonly selectedName = signal(localStorage.getItem(selectedProjectKey) ?? '');

  readonly projects = signal<ProjectSummary[]>([]);
  readonly servers = signal<ServerRecord[]>([]);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly selectedProjectName = this.selectedName.asReadonly();
  readonly selectedProject = computed(() =>
    this.projects().find((project) => project.name === this.selectedName()) ?? null,
  );
  readonly selectedProjectServer = computed(() => {
    const project = this.selectedProject();
    return this.servers().find((server) => server.id === (project?.serverId ?? 'local')) ?? null;
  });

  constructor() {
    effect(() => {
      const name = this.selectedName();
      if (name) {
        localStorage.setItem(selectedProjectKey, name);
      } else {
        localStorage.removeItem(selectedProjectKey);
      }
    });
  }

  loadProjects() {
    this.loading.set(true);
    this.error.set('');

    this.api.listProjects().subscribe({
      next: (projects) => {
        this.projects.set(projects);
        if (!projects.some((project) => project.name === this.selectedName())) {
          this.selectedName.set(projects[0]?.name ?? '');
        }
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

  selectProject(name: string) {
    this.selectedName.set(name);
  }
}
