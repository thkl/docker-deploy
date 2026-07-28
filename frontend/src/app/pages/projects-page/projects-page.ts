import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { DeploymentRecord, ProjectSummary } from '../../models/project';
import { ProjectApi } from '../../services/project-api';
import { ProjectStore } from '../../state/project-store';

@Component({
  selector: 'app-projects-page',
  imports: [RouterLink],
  templateUrl: './projects-page.html',
  styleUrl: './projects-page.scss',
})
export class ProjectsPage {
  protected readonly store = inject(ProjectStore);
  private readonly api = inject(ProjectApi);
  protected readonly deploying = signal('');
  protected readonly message = signal('');
  protected readonly deleteProjectTarget = signal<ProjectSummary | null>(null);
  protected readonly deleting = signal(false);
  protected readonly deleteError = signal('');
  protected readonly deleteConfirmation = signal('');
  protected readonly deleteStopContainers = signal(true);
  protected readonly deleteCheckout = signal(false);
  protected readonly deleteDeploymentHistory = signal(false);

  deploy(name: string) {
    this.deploying.set(name);
    this.message.set(`Deploying ${name}...`);

    this.api.deployProject(name).subscribe({
      next: () => {
        this.message.set(`Deployment started for ${name}.`);
        this.store.loadProjects();
        this.deploying.set('');
      },
      error: () => {
        this.message.set(`Could not start deployment for ${name}.`);
        this.deploying.set('');
      },
    });
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

  protected formatDate(value?: string) {
    if (!value) {
      return '';
    }

    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date(value));
  }

  protected openDelete(project: ProjectSummary) {
    this.deleteProjectTarget.set(project);
    this.deleteError.set('');
    this.deleteConfirmation.set('');
    this.deleteStopContainers.set(true);
    this.deleteCheckout.set(false);
    this.deleteDeploymentHistory.set(false);
  }

  protected closeDelete() {
    if (this.deleting()) {
      return;
    }

    this.deleteProjectTarget.set(null);
    this.deleteError.set('');
  }

  protected updateDeleteConfirmation(event: Event) {
    this.deleteConfirmation.set((event.target as HTMLInputElement).value);
  }

  protected updateDeleteOption(option: 'stop' | 'checkout' | 'history', event: Event) {
    const checked = (event.target as HTMLInputElement).checked;
    if (option === 'stop') {
      this.deleteStopContainers.set(checked);
    } else if (option === 'checkout') {
      this.deleteCheckout.set(checked);
    } else {
      this.deleteDeploymentHistory.set(checked);
    }
  }

  protected canDelete() {
    const project = this.deleteProjectTarget();
    return Boolean(project && this.deleteConfirmation() === project.name && !this.deleting());
  }

  protected deleteProject() {
    const project = this.deleteProjectTarget();
    if (!project || !this.canDelete()) {
      return;
    }

    this.deleting.set(true);
    this.deleteError.set('');

    this.api.deleteProject(project.name, {
      confirmationName: this.deleteConfirmation(),
      stopContainers: this.deleteStopContainers(),
      deleteCheckout: this.deleteCheckout(),
      deleteDeploymentHistory: this.deleteDeploymentHistory(),
    }).subscribe({
      next: (result) => {
        this.message.set(`${project.name} deleted: ${result.actions.join(', ')}.`);
        this.deleteProjectTarget.set(null);
        this.deleting.set(false);
        this.store.loadProjects();
      },
      error: (error) => {
        this.deleteError.set(error?.error?.error || `Could not delete ${project.name}.`);
        this.deleting.set(false);
      },
    });
  }
}
