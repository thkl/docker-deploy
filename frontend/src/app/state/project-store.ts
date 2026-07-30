import { computed, effect, inject, Injectable, signal } from '@angular/core';
import { ProjectSummary, ServerRecord } from '../models/project';
import { ProjectApi } from '../services/project-api';

const selectedProjectKey = 'updater.selectedProject';

@Injectable({ providedIn: 'root' })
export class ProjectStore {
  private readonly api = inject(ProjectApi);
  private readonly selectedId = signal(localStorage.getItem(selectedProjectKey) ?? '');

  readonly projects = signal<ProjectSummary[]>([]);
  readonly servers = signal<ServerRecord[]>([]);
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
        const selected = this.selectedId();
        const selectedProject = projects.find((project) => project.id === selected) ?? projects.find((project) => project.name === selected);
        if (selectedProject) {
          this.selectedId.set(selectedProject.id);
        } else {
          this.selectedId.set(projects[0]?.id ?? '');
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

  selectProject(projectRef: string) {
    const project = this.projects().find((candidate) => candidate.id === projectRef || candidate.name === projectRef);
    this.selectedId.set(project?.id ?? projectRef);
  }
}
