import { Component, computed, ElementRef, ViewChild, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { DeploymentRecord, ProjectSummary } from '../../models/project';
import { DeploymentStreamService } from '../../services/deployment-stream';
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
  private readonly router = inject(Router);

  protected readonly latestDeployment = signal<DeploymentRecord | null>(null);
  protected readonly loadingDeployment = signal(false);
  protected readonly deploying = signal(false);
  protected readonly deployMessage = signal('');
  protected readonly deployError = signal('');
  protected readonly streamState = signal<'connecting' | 'live' | 'closed' | 'error'>('closed');
  protected readonly autoScroll = signal(true);
  protected readonly deleteProjectTarget = signal<ProjectSummary | null>(null);
  protected readonly deleting = signal(false);
  protected readonly deleteError = signal('');
  protected readonly deleteConfirmation = signal('');
  protected readonly deleteStopContainers = signal(true);
  protected readonly deleteCheckout = signal(true);
  protected readonly deleteDeploymentHistory = signal(true);
  protected readonly selectedServer = computed(() => this.store.selectedProjectServer());

  private readonly deploymentStream = inject(DeploymentStreamService);
  private streamSubscription: Subscription | undefined;

  @ViewChild('deployLog') private deployLog?: ElementRef<HTMLElement>;

  ngOnInit() {
    this.route.paramMap.subscribe((params) => {
      const name = params.get('name');
      if (name) {
        this.store.selectProject(name);
        this.connectDeploymentStream(name);
      }
    });
  }

  ngOnDestroy() {
    this.disconnectDeploymentStream();
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

  protected openDelete(project: ProjectSummary) {
    this.deleteProjectTarget.set(project);
    this.deleteError.set('');
    this.deleteConfirmation.set('');
    this.deleteStopContainers.set(true);
    this.deleteCheckout.set(true);
    this.deleteDeploymentHistory.set(true);
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
      next: () => {
        this.deleteProjectTarget.set(null);
        this.deleting.set(false);
        this.disconnectDeploymentStream();
        this.store.loadProjects();
        this.router.navigate(['/projects']);
      },
      error: (error) => {
        this.deleteError.set(error?.error?.error || `Could not delete ${project.name}.`);
        this.deleting.set(false);
      },
    });
  }

  protected toggleAutoScroll(event: Event) {
    const checked = (event.target as HTMLInputElement).checked;
    this.autoScroll.set(checked);

    if (checked) {
      this.scrollLogToBottom();
    }
  }

  protected onLogScroll() {
    const element = this.deployLog?.nativeElement;
    if (!element) {
      return;
    }

    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    this.autoScroll.set(distanceFromBottom < 48);
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

  protected streamLabel() {
    return this.streamState() === 'live'
      ? 'Live'
      : this.streamState() === 'connecting'
        ? 'Connecting'
        : this.streamState() === 'error'
          ? 'Stream lost'
          : 'Offline';
  }

  private loadLatestDeployment(name: string) {
    this.loadingDeployment.set(true);

    this.api.getLatestDeployment(name).subscribe({
      next: (deployment) => {
        this.setLatestDeployment(deployment);
        this.loadingDeployment.set(false);
        this.deployError.set('');
      },
      error: () => {
        this.loadingDeployment.set(false);
        this.deployError.set(`Could not load deployment status for ${name}.`);
      },
    });
  }

  private connectDeploymentStream(name: string) {
    this.disconnectDeploymentStream();
    this.loadingDeployment.set(true);
    this.streamState.set('connecting');

    this.streamSubscription = this.deploymentStream.streamLatest(name).subscribe({
      next: (deployment) => {
        this.setLatestDeployment(deployment);
        this.loadingDeployment.set(false);
        this.streamState.set('live');

        if (deployment?.status !== 'running') {
          this.store.loadProjects();
        }
      },
      error: () => {
        this.loadingDeployment.set(false);
        this.streamState.set('error');
        this.deployError.set('Live log stream disconnected. Use Refresh to load the latest deployment state.');
      },
      complete: () => {
        this.loadingDeployment.set(false);
        if (this.streamState() !== 'error') {
          this.streamState.set('closed');
        }
      },
    });
  }

  private disconnectDeploymentStream() {
    this.streamSubscription?.unsubscribe();
    this.streamSubscription = undefined;
    this.streamState.set('closed');
  }

  private setLatestDeployment(deployment: DeploymentRecord | null) {
    this.latestDeployment.set(deployment);
    this.queueLogScroll();
  }

  private queueLogScroll() {
    if (!this.autoScroll()) {
      return;
    }

    window.setTimeout(() => this.scrollLogToBottom());
  }

  private scrollLogToBottom() {
    const element = this.deployLog?.nativeElement;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }
}
