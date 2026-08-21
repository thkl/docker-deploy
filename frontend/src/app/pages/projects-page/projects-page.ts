import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { DeploymentRecord, RuntimeStatus } from '../../models/project';
import { ProjectStore } from '../../state/project-store';

@Component({
  selector: 'app-projects-page',
  imports: [RouterLink],
  templateUrl: './projects-page.html',
  styleUrl: './projects-page.scss',
})
export class ProjectsPage {
  protected readonly store = inject(ProjectStore);
  protected readonly message = signal('');
  protected readonly searchTerm = signal('');

  protected readonly filteredProjects = computed(() => {
    const term = this.searchTerm().trim().toLowerCase();
    if (!term) {
      return this.store.projects();
    }

    return this.store.projects().filter((project) =>
      [
        project.name,
        project.deploymentStrategy === 'swarm' ? 'Swarm application' : 'Compose application',
        this.runtimeLabel(this.store.runtimeStatusFor(project.id)),
        this.statusLabel(project.lastDeployment),
      ]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLowerCase().includes(term)),
    );
  });

  protected readonly runningCount = computed(() =>
    this.store.projects().filter((project) => this.store.runtimeStatusFor(project.id)?.status === 'running').length,
  );

  protected readonly attentionCount = computed(() =>
    this.store.projects().filter((project) => {
      const runtime = this.store.runtimeStatusFor(project.id)?.status;
      return runtime === 'partial' || runtime === 'stopped' || runtime === 'error' || project.lastDeployment?.status === 'failed';
    }).length,
  );

  protected readonly deployingCount = computed(() =>
    this.store.projects().filter((project) => project.lastDeployment?.status === 'running').length,
  );

  protected readonly proxiedCount = computed(() =>
    this.store.projects().filter((project) => project.traefik.enabled && project.traefik.hostname).length,
  );

  protected updateSearch(event: Event) {
    this.searchTerm.set((event.target as HTMLInputElement).value);
  }

  protected statusLabel(deployment?: DeploymentRecord | null) {
    if (!deployment) {
      return 'No deploy';
    }

    return deployment.status === 'running'
      ? 'Running'
      : deployment.status === 'succeeded'
        ? 'Succeeded'
        : 'Failed';
  }

  protected runtimeLabel(status: RuntimeStatus | null) {
    if (!status) {
      return 'Checking';
    }

    return status.status === 'running'
      ? 'Containers running'
      : status.status === 'partial'
        ? 'Partially running'
        : status.status === 'stopped'
          ? 'Stopped'
          : status.status === 'error'
            ? 'Status error'
            : 'Unknown';
  }

  protected formatDate(value?: string) {
    if (!value) {
      return '';
    }

    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date(value));
  }
}
