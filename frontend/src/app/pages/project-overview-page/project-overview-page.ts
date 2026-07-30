import { Component, computed, ElementRef, ViewChild, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { DeploymentRecord, ProjectSummary, RuntimeServiceStatus, RuntimeStatus } from '../../models/project';
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
  protected readonly runtimeStatus = signal<RuntimeStatus | null>(null);
  protected readonly loadingDeployment = signal(false);
  protected readonly loadingRuntimeStatus = signal(false);
  protected readonly deploying = signal(false);
  protected readonly deployMessage = signal('');
  protected readonly deployError = signal('');
  protected readonly runtimeStatusError = signal('');
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
  private activeProjectRef = '';

  @ViewChild('deployLog') private deployLog?: ElementRef<HTMLElement>;

  ngOnInit() {
    this.route.paramMap.subscribe((params) => {
      const projectRef = params.get('name');
      if (projectRef) {
        this.resetProjectState(projectRef);
        this.store.selectProject(projectRef);
        this.connectDeploymentStream(projectRef);
        this.loadRuntimeStatus(projectRef);
      }
    });
  }

  ngOnDestroy() {
    this.disconnectDeploymentStream();
  }

  protected deploy(projectRef: string) {
    const project = this.projectByRef(projectRef);
    const projectName = project?.name ?? projectRef;

    this.deploying.set(true);
    this.deployMessage.set(`Starting deployment for ${projectName}...`);
    this.deployError.set('');

    this.api.deployProject(project?.id ?? projectRef).subscribe({
      next: () => {
        this.deploying.set(false);
        this.deployMessage.set(`Deployment started for ${projectName}.`);
        this.store.loadProjects();
        this.loadLatestDeployment(project?.id ?? projectRef, projectName);
      },
      error: () => {
        this.deploying.set(false);
        this.deployError.set(`Could not start deployment for ${projectName}.`);
      },
    });
  }

  protected refresh(projectRef: string) {
    const project = this.projectByRef(projectRef);
    this.loadLatestDeployment(project?.id ?? projectRef, project?.name ?? projectRef);
    this.loadRuntimeStatus(project?.id ?? projectRef);
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

    this.api.deleteProject(project.id, {
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

  protected runtimeStatusLabel(status: RuntimeStatus | null) {
    if (!status) {
      return 'Unknown';
    }

    return status.status === 'running'
      ? 'Running'
      : status.status === 'partial'
        ? 'Partial'
        : status.status === 'stopped'
          ? 'Stopped'
          : status.status === 'error'
            ? 'Error'
            : 'Unknown';
  }

  protected servicePortLabel(service: RuntimeServiceStatus) {
    if (service.networkMode === 'host') {
      return service.exposedPorts?.length
        ? `host network: ${service.exposedPorts.join(', ')}`
        : 'host network: container ports exposed on host';
    }

    return service.ports || 'no published ports';
  }

  private loadLatestDeployment(projectRef: string, projectName = projectRef) {
    this.loadingDeployment.set(true);

    this.api.getLatestDeployment(projectRef).subscribe({
      next: (deployment) => {
        if (this.activeProjectRef !== projectRef) {
          return;
        }

        this.setLatestDeployment(deployment);
        this.loadingDeployment.set(false);
        this.deployError.set('');
      },
      error: () => {
        if (this.activeProjectRef !== projectRef) {
          return;
        }

        this.loadingDeployment.set(false);
        this.deployError.set(`Could not load deployment status for ${projectName}.`);
      },
    });
  }

  private loadRuntimeStatus(projectRef: string) {
    this.loadingRuntimeStatus.set(true);
    this.runtimeStatusError.set('');
    this.runtimeStatus.set(null);

    this.api.getProjectStatus(projectRef).subscribe({
      next: (status) => {
        if (this.activeProjectRef !== projectRef) {
          return;
        }

        this.runtimeStatus.set(status);
        this.loadingRuntimeStatus.set(false);
      },
      error: () => {
        if (this.activeProjectRef !== projectRef) {
          return;
        }

        this.loadingRuntimeStatus.set(false);
        this.runtimeStatusError.set('Could not inspect runtime status.');
      },
    });
  }

  private connectDeploymentStream(projectRef: string) {
    this.disconnectDeploymentStream();
    this.loadingDeployment.set(true);
    this.streamState.set('connecting');

    this.streamSubscription = this.deploymentStream.streamLatest(projectRef).subscribe({
      next: (deployment) => {
        if (this.activeProjectRef !== projectRef) {
          return;
        }

        this.setLatestDeployment(deployment);
        this.loadingDeployment.set(false);
        this.streamState.set('live');

        if (deployment?.status !== 'running') {
          this.store.loadProjects();
          this.loadRuntimeStatus(projectRef);
        }
      },
      error: () => {
        if (this.activeProjectRef !== projectRef) {
          return;
        }

        this.loadingDeployment.set(false);
        this.streamState.set('error');
        this.deployError.set('Live log stream disconnected. Use Refresh to load the latest deployment state.');
      },
      complete: () => {
        if (this.activeProjectRef !== projectRef) {
          return;
        }

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

  private resetProjectState(projectRef: string) {
    this.activeProjectRef = projectRef;
    this.latestDeployment.set(null);
    this.runtimeStatus.set(null);
    this.runtimeStatusError.set('');
    this.deployError.set('');
    this.deployMessage.set('');
    this.loadingDeployment.set(true);
    this.loadingRuntimeStatus.set(true);
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

  private projectByRef(projectRef: string) {
    return this.store.projects().find((project) => project.id === projectRef || project.name === projectRef) ?? null;
  }
}
