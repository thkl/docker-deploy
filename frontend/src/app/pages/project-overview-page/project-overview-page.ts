import { Component, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { DeploymentRecord } from '../../models/project';
import { ProjectApi } from '../../services/project-api';
import { ProjectStore } from '../../state/project-store';

@Component({
  selector: 'app-project-overview-page',
  imports: [RouterLink],
  templateUrl: './project-overview-page.html',
  styleUrl: './project-overview-page.scss',
})
export class ProjectOverviewPage implements OnInit, OnDestroy {
  protected readonly store = inject(ProjectStore);
  private readonly api = inject(ProjectApi);
  private readonly route = inject(ActivatedRoute);

  protected readonly latestDeployment = signal<DeploymentRecord | null>(null);
  protected readonly loadingDeployment = signal(false);
  protected readonly deploying = signal(false);
  protected readonly deployMessage = signal('');
  protected readonly deployError = signal('');

  private refreshTimer: ReturnType<typeof setInterval> | undefined;

  ngOnInit() {
    this.route.paramMap.subscribe((params) => {
      const name = params.get('name');
      if (name) {
        this.store.selectProject(name);
        this.loadLatestDeployment(name);
        this.startRefreshTimer(name);
      }
    });
  }

  ngOnDestroy() {
    this.stopRefreshTimer();
  }

  protected deploy(name: string) {
    this.deploying.set(true);
    this.deployMessage.set(`Starting deployment for ${name}...`);
    this.deployError.set('');

    this.api.deployProject(name).subscribe({
      next: () => {
        this.deploying.set(false);
        this.deployMessage.set(`Deployment started for ${name}.`);
        this.store.loadProjects();
        this.loadLatestDeployment(name);
      },
      error: () => {
        this.deploying.set(false);
        this.deployError.set(`Could not start deployment for ${name}.`);
      },
    });
  }

  protected refresh(name: string) {
    this.loadLatestDeployment(name);
  }

  protected formatDate(value?: string) {
    if (!value) {
      return 'Not finished';
    }

    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'medium',
    }).format(new Date(value));
  }

  protected statusLabel(deployment: DeploymentRecord | null) {
    if (!deployment) {
      return 'No deployment yet';
    }

    return deployment.status === 'running'
      ? 'Running'
      : deployment.status === 'succeeded'
        ? 'Succeeded'
        : 'Failed';
  }

  private loadLatestDeployment(name: string) {
    this.loadingDeployment.set(true);

    this.api.getLatestDeployment(name).subscribe({
      next: (deployment) => {
        this.latestDeployment.set(deployment);
        this.loadingDeployment.set(false);
        this.deployError.set('');
      },
      error: () => {
        this.loadingDeployment.set(false);
        this.deployError.set(`Could not load deployment status for ${name}.`);
      },
    });
  }

  private startRefreshTimer(name: string) {
    this.stopRefreshTimer();
    this.refreshTimer = setInterval(() => {
      this.loadLatestDeployment(name);
    }, 4000);
  }

  private stopRefreshTimer() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }
}
