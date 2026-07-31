import { Component, inject, signal } from '@angular/core';
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
