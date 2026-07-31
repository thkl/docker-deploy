import { Component, computed, ElementRef, ViewChild, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { ComposeInspection, ComposeMountInspection, ComposeServiceInspection, DeploymentRecord, ProjectSummary, RuntimeLogs, RuntimeOperationRecord, RuntimeServiceAction, RuntimeServiceStatus, RuntimeStatus } from '../../models/project';
import { DeploymentStreamService } from '../../services/deployment-stream';
import { ProjectApi } from '../../services/project-api';
import { RuntimeLogStreamService } from '../../services/runtime-log-stream';
import { RuntimeOperationStreamService } from '../../services/runtime-operation-stream';
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
  protected readonly runtimeLogs = signal<RuntimeLogs | null>(null);
  protected readonly runtimeOperations = signal<RuntimeOperationRecord[]>([]);
  protected readonly composeInspection = signal<ComposeInspection | null>(null);
  protected readonly loadingDeployment = signal(false);
  protected readonly loadingRuntimeStatus = signal(false);
  protected readonly loadingRuntimeLogs = signal(false);
  protected readonly loadingRuntimeOperations = signal(false);
  protected readonly loadingComposeInspection = signal(false);
  protected readonly deploying = signal(false);
  protected readonly deployMessage = signal('');
  protected readonly deployError = signal('');
  protected readonly runtimeStatusError = signal('');
  protected readonly runtimeLogsError = signal('');
  protected readonly runtimeOperationsError = signal('');
  protected readonly composeInspectionError = signal('');
  protected readonly runtimeActionMessage = signal('');
  protected readonly runtimeActionError = signal('');
  protected readonly runtimeActionKey = signal('');
  protected readonly runtimeActionOutput = signal('');
  protected readonly selectedRuntimeOperationId = signal('');
  protected readonly selectedRuntimeService = signal('');
  protected readonly runtimeLogTail = signal(200);
  protected readonly runtimeLogStreamState = signal<'connecting' | 'live' | 'closed' | 'error'>('closed');
  protected readonly streamState = signal<'connecting' | 'live' | 'closed' | 'error'>('closed');
  protected readonly autoScroll = signal(true);
  protected readonly deploymentLogExpanded = signal(false);
  protected readonly runtimeLogAutoScroll = signal(true);
  protected readonly deleteProjectTarget = signal<ProjectSummary | null>(null);
  protected readonly deleting = signal(false);
  protected readonly deleteError = signal('');
  protected readonly deleteConfirmation = signal('');
  protected readonly deleteStopContainers = signal(true);
  protected readonly deleteCheckout = signal(true);
  protected readonly deleteDeploymentHistory = signal(true);
  protected readonly selectedServer = computed(() => this.store.selectedProjectServer());

  private readonly deploymentStream = inject(DeploymentStreamService);
  private readonly runtimeLogStream = inject(RuntimeLogStreamService);
  private readonly runtimeOperationStream = inject(RuntimeOperationStreamService);
  private streamSubscription: Subscription | undefined;
  private runtimeLogSubscription: Subscription | undefined;
  private runtimeOperationSubscription: Subscription | undefined;
  private activeProjectRef = '';

  @ViewChild('deployLog') private deployLog?: ElementRef<HTMLElement>;
  @ViewChild('runtimeLog') private runtimeLog?: ElementRef<HTMLElement>;

  ngOnInit() {
    this.route.paramMap.subscribe((params) => {
      const projectRef = params.get('name');
      if (projectRef) {
        this.resetProjectState(projectRef);
        this.store.selectProject(projectRef);
        this.connectDeploymentStream(projectRef);
        this.loadRuntimeStatus(projectRef);
        this.loadRuntimeOperations(projectRef);
      }
    });
  }

  ngOnDestroy() {
    this.disconnectDeploymentStream();
    this.disconnectRuntimeLogStream();
    this.disconnectRuntimeOperationStream();
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
    this.loadRuntimeOperations(project?.id ?? projectRef);
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

  protected toggleDeploymentLog() {
    this.deploymentLogExpanded.update((expanded) => !expanded);
    if (!this.deploymentLogExpanded()) {
      return;
    }

    this.queueLogScroll();
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

  protected runRuntimeAction(projectRef: string, service: RuntimeServiceStatus, action: RuntimeServiceAction) {
    const serviceName = service.service;
    const actionKey = `${serviceName}:${action}`;
    this.disconnectRuntimeLogStream();
    this.disconnectRuntimeOperationStream();
    this.runtimeActionKey.set(actionKey);
    this.runtimeActionMessage.set(`${this.runtimeActionLabel(action)} ${serviceName}...`);
    this.runtimeActionError.set('');
    this.runtimeActionOutput.set('');

    this.runtimeOperationSubscription = this.runtimeOperationStream.run(projectRef, serviceName, action).subscribe({
      next: (event) => {
        if (this.activeProjectRef !== projectRef) {
          return;
        }

        if (event.type === 'status') {
          if (event.status === 'live') {
            this.runtimeActionMessage.set(`${this.runtimeActionLabel(action)} ${serviceName} is running...`);
          } else if (event.status === 'closed') {
            this.runtimeActionKey.set('');
            this.loadRuntimeStatus(projectRef);
          } else if (event.status === 'error') {
            this.runtimeActionKey.set('');
            this.loadRuntimeStatus(projectRef);
          }
          return;
        }

        if (event.type === 'log') {
          this.runtimeActionOutput.update((output) => `${output}${event.stream === 'stderr' ? '[stderr] ' : ''}${event.chunk}`);
          return;
        }

        if (event.type === 'operation') {
          this.upsertRuntimeOperation(event.operation);
          this.selectedRuntimeOperationId.set(event.operation.id);
          if (event.operation.status === 'failed') {
            this.runtimeActionError.set(event.operation.error || `Could not ${action} ${serviceName}.`);
            this.runtimeActionMessage.set('');
          } else {
            this.runtimeActionMessage.set(`${this.runtimeActionLabel(action)} ${serviceName} finished.`);
            this.runtimeActionError.set('');
          }
          return;
        }

        this.runtimeActionError.set(event.error);
        this.runtimeActionMessage.set('');
        this.runtimeActionKey.set('');
      },
      error: (error) => {
        if (this.activeProjectRef !== projectRef) {
          return;
        }

        this.runtimeActionError.set(error?.error?.error || `Could not ${action} ${serviceName}.`);
        this.runtimeActionMessage.set('');
        this.runtimeActionKey.set('');
        this.loadRuntimeOperations(projectRef);
      },
      complete: () => {
        if (this.activeProjectRef !== projectRef) {
          return;
        }

        if (this.runtimeActionKey() === actionKey) {
          this.runtimeActionKey.set('');
          this.loadRuntimeStatus(projectRef);
          this.loadRuntimeOperations(projectRef);
        }
      },
    });
  }

  protected runtimeActionBusy(service: RuntimeServiceStatus, action?: RuntimeServiceAction) {
    const current = this.runtimeActionKey();
    return action ? current === `${service.service}:${action}` : current.startsWith(`${service.service}:`);
  }

  protected runtimeActionLabel(action: RuntimeServiceAction) {
    return action === 'restart'
      ? 'Restart'
      : action === 'start'
        ? 'Start'
        : action === 'stop'
          ? 'Stop'
          : action === 'recreate'
            ? 'Recreate'
            : 'Pull';
  }

  protected toggleRuntimeOperation(operation: RuntimeOperationRecord) {
    this.selectedRuntimeOperationId.update((current) => current === operation.id ? '' : operation.id);
  }

  protected operationDuration(operation: RuntimeOperationRecord) {
    const started = new Date(operation.startedAt).getTime();
    const finished = new Date(operation.finishedAt).getTime();
    if (!Number.isFinite(started) || !Number.isFinite(finished) || finished < started) {
      return '';
    }

    return `${Math.max(0, Math.round((finished - started) / 1000))}s`;
  }

  protected inspectCompose(projectRef: string) {
    this.loadingComposeInspection.set(true);
    this.composeInspectionError.set('');
    this.composeInspection.set(null);

    this.api.inspectCompose(projectRef).subscribe({
      next: (inspection) => {
        if (this.activeProjectRef !== projectRef) {
          return;
        }

        this.composeInspection.set(inspection);
        this.loadingComposeInspection.set(false);
      },
      error: (error) => {
        if (this.activeProjectRef !== projectRef) {
          return;
        }

        this.loadingComposeInspection.set(false);
        this.composeInspectionError.set(error?.error?.error || 'Could not inspect Docker Compose file.');
      },
    });
  }

  protected composeSourceLabel(inspection: ComposeInspection) {
    return inspection.source === 'storedOverride' ? 'Stored override' : 'Repository compose';
  }

  protected serviceSummary(service: ComposeServiceInspection) {
    const parts = [
      service.image ? `image ${service.image}` : '',
      service.build ? 'build configured' : '',
      service.ports.length ? `${service.ports.length} ports` : '',
      service.mounts.length ? `${service.mounts.length} mounts` : ''
    ].filter(Boolean);
    return parts.join(' · ') || 'No image, build, ports, or mounts declared.';
  }

  protected mountLabel(mount: ComposeMountInspection) {
    const source = mount.source || '(anonymous)';
    const target = mount.target || '(no target)';
    return `${source} -> ${target}${mount.readOnly ? ' :ro' : ''}`;
  }

  protected portsLabel(service: ComposeServiceInspection) {
    if (service.ports.length) {
      return service.ports.map((port) => port.raw).join(', ');
    }

    return service.expose.length ? `expose ${service.expose.join(', ')}` : 'no declared ports';
  }

  protected mountsLabel(service: ComposeServiceInspection) {
    return service.mounts.length ? service.mounts.map((mount) => this.mountLabel(mount)).join(', ') : 'no mounts';
  }

  protected hasUnsafeMount(service: ComposeServiceInspection) {
    return service.mounts.some((mount) => !mount.safeForCleanup);
  }

  protected updateRuntimeService(event: Event) {
    this.disconnectRuntimeLogStream();
    this.selectedRuntimeService.set((event.target as HTMLSelectElement).value);
    this.runtimeLogs.set(null);
    this.runtimeLogsError.set('');
  }

  protected updateRuntimeTail(event: Event) {
    this.disconnectRuntimeLogStream();
    this.runtimeLogTail.set(Number((event.target as HTMLSelectElement).value) || 200);
    this.runtimeLogs.set(null);
  }

  protected loadRuntimeLogs(projectRef: string) {
    this.disconnectRuntimeLogStream();
    const service = this.selectedRuntimeService() || this.runtimeStatus()?.services[0]?.service || '';
    if (!service) {
      this.runtimeLogsError.set('Select a running service first.');
      return;
    }

    this.loadingRuntimeLogs.set(true);
    this.runtimeLogsError.set('');

    this.api.getRuntimeLogs(projectRef, service, this.runtimeLogTail()).subscribe({
      next: (logs) => {
        if (this.activeProjectRef !== projectRef) {
          return;
        }

        this.runtimeLogs.set(logs);
        this.queueRuntimeLogScroll();
        this.loadingRuntimeLogs.set(false);
      },
      error: (error) => {
        if (this.activeProjectRef !== projectRef) {
          return;
        }

        this.loadingRuntimeLogs.set(false);
        this.runtimeLogsError.set(error?.error?.error || 'Could not load runtime logs.');
      },
    });
  }

  protected toggleRuntimeLogStream(projectRef: string) {
    if (this.runtimeLogStreamState() === 'live' || this.runtimeLogStreamState() === 'connecting') {
      this.disconnectRuntimeLogStream();
      return;
    }

    this.connectRuntimeLogStream(projectRef);
  }

  protected runtimeLogStreamLabel() {
    return this.runtimeLogStreamState() === 'live'
      ? 'Live'
      : this.runtimeLogStreamState() === 'connecting'
        ? 'Connecting'
        : this.runtimeLogStreamState() === 'error'
          ? 'Stream lost'
          : 'Offline';
  }

  protected toggleRuntimeLogAutoScroll(event: Event) {
    const checked = (event.target as HTMLInputElement).checked;
    this.runtimeLogAutoScroll.set(checked);

    if (checked) {
      this.scrollRuntimeLogToBottom();
    }
  }

  protected onRuntimeLogScroll() {
    const element = this.runtimeLog?.nativeElement;
    if (!element) {
      return;
    }

    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    this.runtimeLogAutoScroll.set(distanceFromBottom < 48);
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
        if (!this.selectedRuntimeService() && status.services[0]?.service) {
          this.selectedRuntimeService.set(status.services[0].service);
        }
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

  protected loadRuntimeOperations(projectRef: string) {
    this.loadingRuntimeOperations.set(true);
    this.runtimeOperationsError.set('');

    this.api.listRuntimeOperations(projectRef).subscribe({
      next: (operations) => {
        if (this.activeProjectRef !== projectRef) {
          return;
        }

        this.runtimeOperations.set(operations);
        this.loadingRuntimeOperations.set(false);
      },
      error: (error) => {
        if (this.activeProjectRef !== projectRef) {
          return;
        }

        this.loadingRuntimeOperations.set(false);
        this.runtimeOperationsError.set(error?.error?.error || 'Could not load runtime operation history.');
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

  private connectRuntimeLogStream(projectRef: string) {
    const service = this.selectedRuntimeService() || this.runtimeStatus()?.services[0]?.service || '';
    if (!service) {
      this.runtimeLogsError.set('Select a running service first.');
      return;
    }

    this.disconnectRuntimeLogStream();
    this.runtimeLogsError.set('');
    this.loadingRuntimeLogs.set(false);
    this.runtimeLogStreamState.set('connecting');
    this.runtimeLogs.set({
      service,
      containerId: 'live',
      tail: this.runtimeLogTail(),
      checkedAt: new Date().toISOString(),
      output: ''
    });

    this.runtimeLogSubscription = this.runtimeLogStream.follow(projectRef, service, this.runtimeLogTail()).subscribe({
      next: (event) => {
        if (this.activeProjectRef !== projectRef) {
          return;
        }

        if (event.type === 'status') {
          this.runtimeLogStreamState.set(event.status);
          return;
        }

        if (event.type === 'error') {
          this.runtimeLogsError.set(event.error);
          this.runtimeLogStreamState.set('error');
          return;
        }

        const current = this.runtimeLogs();
        this.runtimeLogs.set({
          service,
          containerId: current?.containerId || 'live',
          tail: this.runtimeLogTail(),
          checkedAt: current?.checkedAt || new Date().toISOString(),
          output: `${current?.output || ''}${event.stream === 'stderr' ? '[stderr] ' : ''}${event.chunk}`
        });
        this.queueRuntimeLogScroll();
      },
      error: () => {
        if (this.activeProjectRef !== projectRef) {
          return;
        }

        this.runtimeLogStreamState.set('error');
        this.runtimeLogsError.set('Live runtime log stream disconnected.');
      },
      complete: () => {
        if (this.activeProjectRef !== projectRef || this.runtimeLogStreamState() === 'error') {
          return;
        }

        this.runtimeLogStreamState.set('closed');
      },
    });
  }

  private disconnectRuntimeLogStream() {
    this.runtimeLogSubscription?.unsubscribe();
    this.runtimeLogSubscription = undefined;
    this.runtimeLogStreamState.set('closed');
  }

  private disconnectRuntimeOperationStream() {
    this.runtimeOperationSubscription?.unsubscribe();
    this.runtimeOperationSubscription = undefined;
  }

  private upsertRuntimeOperation(operation: RuntimeOperationRecord) {
    this.runtimeOperations.update((operations) => [
      operation,
      ...operations.filter((candidate) => candidate.id !== operation.id)
    ].slice(0, 25));
  }

  private resetProjectState(projectRef: string) {
    this.disconnectRuntimeLogStream();
    this.activeProjectRef = projectRef;
    this.latestDeployment.set(null);
    this.runtimeStatus.set(null);
    this.runtimeLogs.set(null);
    this.runtimeOperations.set([]);
    this.composeInspection.set(null);
    this.runtimeStatusError.set('');
    this.runtimeLogsError.set('');
    this.runtimeOperationsError.set('');
    this.composeInspectionError.set('');
    this.runtimeActionMessage.set('');
    this.runtimeActionError.set('');
    this.runtimeActionKey.set('');
    this.runtimeActionOutput.set('');
    this.selectedRuntimeOperationId.set('');
    this.deployError.set('');
    this.deployMessage.set('');
    this.selectedRuntimeService.set('');
    this.runtimeLogTail.set(200);
    this.deploymentLogExpanded.set(false);
    this.loadingDeployment.set(true);
    this.loadingRuntimeStatus.set(true);
    this.loadingRuntimeLogs.set(false);
    this.loadingRuntimeOperations.set(false);
    this.loadingComposeInspection.set(false);
  }

  private setLatestDeployment(deployment: DeploymentRecord | null) {
    this.latestDeployment.set(deployment);
    if (deployment?.status === 'running') {
      this.deploymentLogExpanded.set(true);
    }
    this.queueLogScroll();
  }

  private queueLogScroll() {
    if (!this.autoScroll() || !this.deploymentLogExpanded()) {
      return;
    }

    window.setTimeout(() => this.scrollLogToBottom());
  }

  private queueRuntimeLogScroll() {
    if (!this.runtimeLogAutoScroll()) {
      return;
    }

    window.setTimeout(() => this.scrollRuntimeLogToBottom());
  }

  private scrollLogToBottom() {
    const element = this.deployLog?.nativeElement;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }

  private scrollRuntimeLogToBottom() {
    const element = this.runtimeLog?.nativeElement;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }

  private projectByRef(projectRef: string) {
    return this.store.projects().find((project) => project.id === projectRef || project.name === projectRef) ?? null;
  }
}
