import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { DeploymentRecord, ProjectSummary, RuntimeStatus } from '../../models/project';
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
        project.repositoryUrl,
        project.path,
        project.traefik.hostname,
        this.targetServerLabel(project),
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

  protected accessLabel(project: ProjectSummary) {
    if (project.deployToken && project.token) {
      return 'CI and webhook';
    }

    if (project.deployToken) {
      return 'CI trigger';
    }

    if (project.token) {
      return 'Webhook';
    }

    return 'Manual';
  }

  protected repositoryLabel(project: ProjectSummary) {
    if (!project.repositoryUrl) {
      return 'Repository not set';
    }

    return project.repositoryUrl.replace(/^https?:\/\//, '').replace(/^git@/, '');
  }

  protected proxyLabel(project: ProjectSummary) {
    return project.traefik.enabled && project.traefik.hostname ? project.traefik.hostname : 'No proxy';
  }

  protected composeLabel(project: ProjectSummary) {
    return project.hasComposeOverride ? 'Stored override' : 'Project file';
  }

  protected targetServerLabel(project: { deploymentStrategy?: string; serverId?: string; serverIds?: string[] }) {
    if (project.deploymentStrategy === 'swarm') {
      return 'Swarm service';
    } else {
      const ids = project.serverIds?.length ? project.serverIds : [project.serverId || 'local'];
      const names = ids.map((id) => this.store.servers().find((server) => server.id === id)?.name || id);
      return names.length > 1 ? `${names.length} servers: ${names.join(', ')}` : names[0] || 'local';
    }
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
