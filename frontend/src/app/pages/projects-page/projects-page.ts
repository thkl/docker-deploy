import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { DeploymentRecord } from '../../models/project';
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
