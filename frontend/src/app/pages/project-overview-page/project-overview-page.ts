import { Component, computed, effect, ElementRef, ViewChild, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink, RouterLinkActive } from '@angular/router';
import { Subscription } from 'rxjs';
import { DeploymentRecord, DeploymentStrategy, NotificationDeliveryRecord, ProjectPreflightCheck, ProjectPreflightResult, ProjectReleaseSnapshot, ProjectSummary, RuntimeLogs, RuntimeOperationRecord, RuntimeServiceAction, RuntimeServiceStatus, RuntimeStatus, ServerRecord, WebhookEventRecord } from '../../models/project';
import { DeploymentStreamService } from '../../services/deployment-stream';
import { ProjectApi } from '../../services/project-api';
import { RuntimeLogStreamService } from '../../services/runtime-log-stream';
import { RuntimeOperationStreamService } from '../../services/runtime-operation-stream';
import { ProjectStore } from '../../state/project-store';

@Component({
  selector: 'app-project-overview-page',
  imports: [RouterLink, RouterLinkActive],
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
  protected readonly latestWebhook = signal<WebhookEventRecord | null>(null);
  protected readonly releaseSnapshots = signal<ProjectReleaseSnapshot[]>([]);
  protected readonly notificationHistory = signal<NotificationDeliveryRecord[]>([]);
  protected readonly preflightResult = signal<ProjectPreflightResult | null>(null);
  protected readonly loadingDeployment = signal(false);
  protected readonly loadingRuntimeStatus = signal(false);
  protected readonly loadingRuntimeLogs = signal(false);
  protected readonly loadingRuntimeOperations = signal(false);
  protected readonly loadingWebhook = signal(false);
  protected readonly loadingReleases = signal(false);
  protected readonly runningPreflight = signal(false);
  protected readonly deploying = signal(false);
  protected readonly cancelingDeployment = signal(false);
  protected readonly rollingBackReleaseId = signal('');
  protected readonly deployMessage = signal('');
  protected readonly deployError = signal('');
  protected readonly releaseError = signal('');
  protected readonly preflightError = signal('');
  protected readonly showAllPreflightChecks = signal(false);
  protected readonly runtimeStatusError = signal('');
  protected readonly runtimeLogsError = signal('');
  protected readonly runtimeOperationsError = signal('');
  protected readonly runtimeActionMessage = signal('');
  protected readonly runtimeActionError = signal('');
  protected readonly runtimeActionKey = signal('');
  protected readonly runtimeActionOutput = signal('');
  protected readonly selectedRuntimeOperationId = signal('');
  protected readonly selectedLogView = signal<'runtime' | 'deployment' | 'actions'>('runtime');
  protected readonly projectSection = signal<'overview' | 'compose' | 'deployments' | 'logs'>('overview');
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
  protected readonly isSwarmProject = computed(() => this.store.selectedProject()?.deploymentStrategy === 'swarm');
  protected readonly rollbackCandidate = computed(() => {
    const releases = this.releaseSnapshots().filter((release) => release.rollbackAvailable);
    if (!releases.length) {
      return null;
    }

    const latest = this.latestDeployment();
    if (!latest || latest.status === 'failed') {
      return releases[0];
    }

    return releases.find((release) => release.deploymentId !== latest.id && release.runId !== latest.runId) ?? releases[1] ?? releases[0];
  });
  protected readonly strategySummary = computed(() => {
    const project = this.store.selectedProject();
    if (!project) {
      return null;
    }

    return deploymentStrategySummary(project, this.selectedServer());
  });
  protected readonly targetServerLabel = computed(() => {
    const project = this.store.selectedProject();
    if (!project) {
      return 'local';
    }

    const ids = project.serverIds?.length ? project.serverIds : [project.serverId || 'local'];
    const names = ids.map((id) => this.store.servers().find((server) => server.id === id)?.name || id);
    return names.length > 1 ? `${names.length} deploy targets` : names[0] || 'local';
  });
  protected readonly targetServerDetail = computed(() => {
    const project = this.store.selectedProject();
    if (!project) {
      return 'local';
    }

    if (project.deploymentStrategy === 'swarm') {
      return 'Swarm service';
    }

    const ids = project.serverIds?.length ? project.serverIds : [project.serverId || 'local'];
    const names = ids.map((id) => this.store.servers().find((server) => server.id === id)?.name || id);
    return names.join(', ') || 'local';
  });
  protected readonly overviewTimeline = computed(() => {
    const items: Array<{ id: string; title: string; detail: string; time: string; tone: 'neutral' | 'success' | 'warning' | 'danger' }> = [];
    const deployment = this.latestDeployment();
    if (deployment) {
      items.push({
        id: `deployment:${deployment.id}`,
        title: `Deployment ${deployment.status}`,
        detail: `${deployment.trigger} on ${deployment.serverId || 'local'}${deployment.error ? ` · ${deployment.error}` : ''}`,
        time: deployment.finishedAt || deployment.startedAt,
        tone: deployment.status === 'succeeded' ? 'success' : deployment.status === 'failed' ? 'danger' : 'warning',
      });
    }

    const runtime = this.runtimeStatus();
    if (runtime) {
      items.push({
        id: `runtime:${runtime.checkedAt}`,
        title: `Runtime ${runtime.status}`,
        detail: `${runtime.services.length} service${runtime.services.length === 1 ? '' : 's'} checked${runtime.error ? ` · ${runtime.error}` : ''}`,
        time: runtime.checkedAt,
        tone: runtime.status === 'running' ? 'success' : runtime.status === 'partial' ? 'warning' : runtime.status === 'error' ? 'danger' : 'neutral',
      });
    }

    const webhook = this.latestWebhook();
    if (webhook) {
      items.push({
        id: `webhook:${webhook.id}`,
        title: `Webhook ${webhook.status}`,
        detail: webhook.reason,
        time: webhook.receivedAt,
        tone: webhook.status === 'dispatched' ? 'success' : webhook.status === 'error' ? 'danger' : 'neutral',
      });
    }

    const release = this.releaseSnapshots()[0];
    if (release) {
      items.push({
        id: `release:${release.id}`,
        title: 'Release snapshot saved',
        detail: `${release.images.length} image${release.images.length === 1 ? '' : 's'} · ${release.serverId}`,
        time: release.createdAt,
        tone: release.rollbackAvailable ? 'success' : 'warning',
      });
    }

    for (const notification of this.notificationHistory().slice(0, 4)) {
      items.push({
        id: `notification:${notification.id}`,
        title: `${notification.channelName || 'Notification'} ${notification.status}`,
        detail: notification.title,
        time: notification.createdAt,
        tone: notification.status === 'sent' ? 'success' : notification.status === 'failed' ? 'danger' : 'warning',
      });
    }

    return items.sort((left, right) => new Date(right.time).getTime() - new Date(left.time).getTime()).slice(0, 6);
  });

  private readonly deploymentStream = inject(DeploymentStreamService);
  private readonly runtimeLogStream = inject(RuntimeLogStreamService);
  private readonly runtimeOperationStream = inject(RuntimeOperationStreamService);
  private streamSubscription: Subscription | undefined;
  private runtimeLogSubscription: Subscription | undefined;
  private runtimeOperationSubscription: Subscription | undefined;
  private activeProjectRef = '';
  private readonly runtimeStatusSync = effect(() => {
    const status = this.activeProjectRef ? this.store.runtimeStatusFor(this.activeProjectRef) : null;
    if (!status) {
      return;
    }

    this.runtimeStatus.set(status);
    this.loadingRuntimeStatus.set(false);
    if (!this.selectedRuntimeService() && status.services[0]?.service) {
      this.selectedRuntimeService.set(status.services[0].service);
    }
  });
  private readonly deploymentSync = effect(() => {
    const project = this.store.selectedProject();
    if (!project || !this.activeProjectRef || (project.id !== this.activeProjectRef && project.name !== this.activeProjectRef)) {
      return;
    }

    const deployment = project.lastDeployment ?? null;
    if (deployment === this.latestDeployment()) {
      return;
    }

    this.setLatestDeployment(deployment);
    this.loadingDeployment.set(false);
  });

  @ViewChild('deployLog') private deployLog?: ElementRef<HTMLElement>;
  @ViewChild('runtimeLog') private runtimeLog?: ElementRef<HTMLElement>;

  ngOnInit() {
    this.route.url.subscribe((segments) => {
      const section = segments[2]?.path;
      this.projectSection.set(section === 'compose' || section === 'deployments' || section === 'logs' ? section : 'overview');
      if (section === 'deployments') {
        this.queueLogScroll();
      } else if (section === 'logs') {
        this.queueRuntimeLogScroll();
      }
    });

    this.route.paramMap.subscribe((params) => {
      const projectRef = params.get('name');
      if (projectRef) {
        this.resetProjectState(projectRef);
        this.store.selectProject(projectRef);
        this.connectDeploymentStream(projectRef);
        this.loadRuntimeStatus(projectRef);
        this.loadRuntimeOperations(projectRef);
        this.loadLatestWebhook(projectRef);
        this.loadReleases(projectRef);
        this.loadNotificationHistory(projectRef);
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
    this.selectedLogView.set('deployment');

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

  protected runPreflight(projectRef: string) {
    const project = this.projectByRef(projectRef);
    const projectName = project?.name ?? projectRef;
    const requestRef = project?.id ?? projectRef;

    this.runningPreflight.set(true);
    this.preflightError.set('');
    this.deployMessage.set(`Running deployment preflight for ${projectName}...`);
    this.deployError.set('');
    this.showAllPreflightChecks.set(false);

    this.api.runPreflight(requestRef).subscribe({
      next: (result) => {
        if (this.activeProjectRef !== projectRef) {
          return;
        }

        this.preflightResult.set(result);
        this.store.setPreflight(requestRef, result);
        this.runningPreflight.set(false);
        this.deployMessage.set(result.status === 'pass'
          ? `Preflight passed for ${projectName}.`
          : result.status === 'warn'
            ? `Preflight finished with warnings for ${projectName}.`
            : `Preflight found blockers for ${projectName}.`);
      },
      error: (error) => {
        if (this.activeProjectRef !== projectRef) {
          return;
        }

        this.runningPreflight.set(false);
        this.deployMessage.set('');
        this.preflightError.set(error?.error?.error || `Could not run preflight for ${projectName}.`);
      },
    });
  }

  protected rollbackRelease(projectRef: string, release: ProjectReleaseSnapshot) {
    if (!release.rollbackAvailable || this.rollingBackReleaseId()) {
      return;
    }

    const project = this.projectByRef(projectRef);
    const projectName = project?.name ?? release.projectName;
    const label = this.shortReleaseLabel(release);
    if (!window.confirm(`Rollback ${projectName} to ${label}?`)) {
      return;
    }

    this.rollingBackReleaseId.set(release.id);
    this.deployMessage.set(`Starting rollback for ${projectName} to ${label}...`);
    this.deployError.set('');
    this.releaseError.set('');
    this.selectedLogView.set('deployment');

    this.api.rollbackRelease(project?.id ?? projectRef, release.id).subscribe({
      next: () => {
        if (this.activeProjectRef !== projectRef) {
          return;
        }

        this.rollingBackReleaseId.set('');
        this.deployMessage.set(`Rollback started for ${projectName}.`);
        this.store.loadProjects();
        this.loadLatestDeployment(project?.id ?? projectRef, projectName);
      },
      error: (error) => {
        if (this.activeProjectRef !== projectRef) {
          return;
        }

        this.rollingBackReleaseId.set('');
        this.deployMessage.set('');
        this.deployError.set(error?.error?.error || `Could not start rollback for ${projectName}.`);
      },
    });
  }

  protected cancelDeployment(projectRef: string) {
    this.cancelingDeployment.set(true);
    this.deployMessage.set('Canceling deployment...');
    this.deployError.set('');

    this.api.cancelDeployment(projectRef).subscribe({
      next: (deployment) => {
        if (this.activeProjectRef !== projectRef) {
          return;
        }

        this.setLatestDeployment(deployment);
        this.cancelingDeployment.set(false);
        this.deployMessage.set('Deployment canceled.');
        this.store.loadProjects();
        this.loadRuntimeStatus(projectRef);
      },
      error: (error) => {
        if (this.activeProjectRef !== projectRef) {
          return;
        }

        this.cancelingDeployment.set(false);
        this.deployMessage.set('');
        this.deployError.set(error?.error?.error || 'Could not cancel deployment.');
      },
    });
  }

  protected refresh(projectRef: string) {
    const project = this.projectByRef(projectRef);
    this.loadLatestDeployment(project?.id ?? projectRef, project?.name ?? projectRef);
    this.loadRuntimeStatus(project?.id ?? projectRef);
    this.loadRuntimeOperations(project?.id ?? projectRef);
    this.loadLatestWebhook(project?.id ?? projectRef);
    this.loadReleases(project?.id ?? projectRef);
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

    return 'Manual deploy';
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
    return project.hasComposeOverride ? 'Stored override' : 'Repository compose';
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

  protected scaleToZeroLabel(status: RuntimeStatus | null) {
    const state = status?.scaleToZero?.state;
    return state === 'idle'
      ? 'Idle'
      : state === 'suspended'
        ? 'Suspended'
        : state === 'waking'
          ? 'Waking'
          : state === 'error'
            ? 'Wake error'
            : 'Running';
  }

  protected scaleToZeroDetail(status: RuntimeStatus | null) {
    const scale = status?.scaleToZero;
    if (!scale) {
      return 'Scale-to-zero status unavailable.';
    }
    if (scale.state === 'idle' && scale.idleSince) {
      return `Idle since ${this.formatDate(scale.idleSince)}.`;
    }
    if (scale.state === 'suspended' && scale.suspendedSince) {
      return `Suspended since ${this.formatDate(scale.suspendedSince)}. The next request will wake it.`;
    }
    if (scale.state === 'waking') {
      return 'Starting services and waiting for health checks.';
    }
    if (scale.state === 'error') {
      return scale.error || 'The application could not be woken.';
    }
    return 'Application services are running.';
  }

  protected webhookStatusLabel(webhook: WebhookEventRecord | null) {
    if (!webhook) {
      return 'No webhook yet';
    }

    return webhook.status === 'dispatched'
      ? 'Dispatched'
      : webhook.status === 'ignored'
        ? 'Ignored'
        : 'Error';
  }

  protected webhookCandidateLabel(webhook: WebhookEventRecord) {
    return webhook.candidates.length ? webhook.candidates.slice(0, 4).join(', ') : 'No candidates recorded';
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
    if (this.isSwarmProject()) {
      return action === 'restart'
        ? 'Force update'
        : action === 'start'
          ? 'Scale to 1'
          : action === 'stop'
            ? 'Scale to 0'
            : 'Update';
    }

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

  protected selectedRuntimeServiceStatus() {
    const selected = this.selectedRuntimeService();
    return this.runtimeStatus()?.services.find((service) => service.service === selected) ?? this.runtimeStatus()?.services[0] ?? null;
  }

  protected selectLogView(view: 'runtime' | 'deployment' | 'actions') {
    this.selectedLogView.set(view);
    if (view === 'deployment') {
      this.queueLogScroll();
    } else if (view === 'runtime') {
      this.queueRuntimeLogScroll();
    }
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

  protected decodedAnsiLog(value: string | null | undefined, fallback = '') {
    return ansiLogToHtml(value || fallback);
  }

  protected shortSha(value?: string) {
    return value ? value.slice(0, 8) : 'unknown';
  }

  protected shortReleaseLabel(release: ProjectReleaseSnapshot) {
    const sha = release.gitSha ? ` @ ${this.shortSha(release.gitSha)}` : '';
    return `${this.formatDate(release.createdAt)}${sha}`;
  }

  protected releaseImageLabel(release: ProjectReleaseSnapshot) {
    if (!release.images.length) {
      return 'No image metadata';
    }

    const first = release.images[0];
    const rest = release.images.length > 1 ? ` +${release.images.length - 1}` : '';
    return `${first.service}: ${first.image}${rest}`;
  }

  protected releaseStatusLabel(release: ProjectReleaseSnapshot) {
    return release.rollbackAvailable ? 'Image snapshot' : 'Stored only';
  }

  protected preflightStatusLabel(status: ProjectPreflightResult['status']) {
    return status === 'pass' ? 'Ready' : status === 'warn' ? 'Warnings' : 'Blocked';
  }

  protected preflightChecksToShow(result: ProjectPreflightResult) {
    const checks = [
      ...result.checks,
      ...result.targets.flatMap((target) => target.checks)
    ];
    return this.showAllPreflightChecks() || result.status === 'pass'
      ? checks
      : checks.filter((check) => check.status !== 'pass');
  }

  protected preflightCounts(result: ProjectPreflightResult) {
    const checks = [
      ...result.checks,
      ...result.targets.flatMap((target) => target.checks)
    ];
    return {
      pass: checks.filter((check) => check.status === 'pass').length,
      warn: checks.filter((check) => check.status === 'warn').length,
      fail: checks.filter((check) => check.status === 'fail').length,
      total: checks.length
    };
  }

  protected preflightCheckTrack(index: number, check: ProjectPreflightCheck) {
    return `${check.target || 'project'}:${check.key}:${index}`;
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
        this.store.setRuntimeStatus(projectRef, status);
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

  protected loadLatestWebhook(projectRef: string) {
    this.loadingWebhook.set(true);

    this.api.getLatestWebhook(projectRef).subscribe({
      next: (webhook) => {
        if (this.activeProjectRef !== projectRef) {
          return;
        }

        this.latestWebhook.set(webhook);
        this.loadingWebhook.set(false);
      },
      error: () => {
        if (this.activeProjectRef !== projectRef) {
          return;
        }

        this.latestWebhook.set(null);
        this.loadingWebhook.set(false);
      },
    });
  }

  protected loadReleases(projectRef: string) {
    this.loadingReleases.set(true);
    this.releaseError.set('');

    this.api.listReleases(projectRef).subscribe({
      next: (releases) => {
        if (this.activeProjectRef !== projectRef) {
          return;
        }

        this.releaseSnapshots.set(releases);
        this.loadingReleases.set(false);
      },
      error: (error) => {
        if (this.activeProjectRef !== projectRef) {
          return;
        }

        this.releaseSnapshots.set([]);
        this.loadingReleases.set(false);
        this.releaseError.set(error?.error?.error || 'Could not load release snapshots.');
      },
    });
  }

  private loadNotificationHistory(projectRef: string) {
    this.api.listNotificationHistory(100).subscribe({
      next: (history) => {
        if (this.activeProjectRef !== projectRef) {
          return;
        }

        const project = this.projectByRef(projectRef);
        const projectKeys = new Set([projectRef, project?.id, project?.name].filter(Boolean));
        this.notificationHistory.set(history.filter((item) => projectKeys.has(item.projectId) || projectKeys.has(item.projectName)));
      },
      error: () => {
        if (this.activeProjectRef === projectRef) {
          this.notificationHistory.set([]);
        }
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
          this.loadReleases(projectRef);
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
    this.latestWebhook.set(null);
    this.releaseSnapshots.set([]);
    this.preflightResult.set(this.store.preflightFor(projectRef));
    this.runtimeStatusError.set('');
    this.runtimeLogsError.set('');
    this.runtimeOperationsError.set('');
    this.releaseError.set('');
    this.preflightError.set('');
    this.showAllPreflightChecks.set(false);
    this.runtimeActionMessage.set('');
    this.runtimeActionError.set('');
    this.runtimeActionKey.set('');
    this.runtimeActionOutput.set('');
    this.selectedRuntimeOperationId.set('');
    this.selectedLogView.set('runtime');
    this.deployError.set('');
    this.deployMessage.set('');
    this.selectedRuntimeService.set('');
    this.runtimeLogTail.set(200);
    this.deploymentLogExpanded.set(false);
    this.loadingDeployment.set(true);
    this.loadingRuntimeStatus.set(true);
    this.loadingRuntimeLogs.set(false);
    this.loadingRuntimeOperations.set(false);
    this.loadingWebhook.set(false);
    this.cancelingDeployment.set(false);
    this.rollingBackReleaseId.set('');
    this.loadingReleases.set(false);
    this.runningPreflight.set(false);

    const cachedStatus = this.store.runtimeStatusFor(projectRef);
    if (cachedStatus) {
      this.runtimeStatus.set(cachedStatus);
      this.loadingRuntimeStatus.set(false);
    }
  }

  private setLatestDeployment(deployment: DeploymentRecord | null) {
    this.latestDeployment.set(deployment);
    if (deployment?.status === 'running') {
      this.deploymentLogExpanded.set(true);
      if (this.projectSection() !== 'deployments') {
        void this.router.navigate(['/projects', this.activeProjectRef, 'deployments']);
      }
    }
    this.queueLogScroll();
  }

  private queueLogScroll() {
    if (!this.autoScroll() || this.projectSection() !== 'deployments') {
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

const ansiColorClasses: Record<number, string> = {
  30: 'ansi-fg-black',
  31: 'ansi-fg-red',
  32: 'ansi-fg-green',
  33: 'ansi-fg-yellow',
  34: 'ansi-fg-blue',
  35: 'ansi-fg-magenta',
  36: 'ansi-fg-cyan',
  37: 'ansi-fg-white',
  90: 'ansi-fg-bright-black',
  91: 'ansi-fg-bright-red',
  92: 'ansi-fg-bright-green',
  93: 'ansi-fg-bright-yellow',
  94: 'ansi-fg-bright-blue',
  95: 'ansi-fg-bright-magenta',
  96: 'ansi-fg-bright-cyan',
  97: 'ansi-fg-bright-white',
};

interface StrategySummary {
  label: string;
  reason: string;
  details: string[];
}

function deploymentStrategySummary(project: ProjectSummary, server: ServerRecord | null): StrategySummary {
  const strategy = project.deploymentStrategy === 'swarm' ? 'swarm' : 'compose';
  const targetCount = project.serverIds?.length || (project.serverId ? 1 : 0);
  const traefikNetwork = project.traefik.network || server?.capabilities?.traefik.dockerProviderNetwork || server?.capabilities?.traefik.networks?.[0] || '';
  const recommendation = recommendedDeploymentStrategy(server, project.traefik.enabled, targetCount);
  const recommendationDetail = recommendation.strategy !== strategy
    ? `Detected topology recommends ${recommendation.strategy === 'swarm' ? 'Swarm stack' : 'Single host Compose'}: ${recommendation.reason}`
    : `Detected topology matches this mode: ${recommendation.reason}`;

  if (strategy === 'swarm') {
    const details = [
      recommendationDetail,
      'Deploy runs as a Swarm stack.',
      targetCount > 1
        ? 'One manager target dispatches the stack; placement constraints decide worker nodes.'
        : 'A Swarm manager agent must run the stack deploy.',
      project.traefik.enabled
        ? `Proxy settings are generated for ${traefikNetwork || 'the selected overlay network'}.`
        : 'No proxy routing is configured for this stack.'
    ];

    return {
      label: 'Swarm stack',
      reason: project.traefik.enabled
        ? 'Selected because this project is configured for Swarm deployment with shared proxy networking.'
        : 'Selected because this project is configured for Swarm deployment.',
      details
    };
  }

  return {
    label: 'Single host Compose',
    reason: project.traefik.enabled
      ? 'Selected because this project deploys containers on the target host and routes through the configured Docker network.'
      : 'Selected because this project deploys containers directly on the target host.',
    details: [
      recommendationDetail,
      'Deploy runs with Docker Compose on the selected target server.',
      project.traefik.enabled
        ? `Proxy settings are generated for ${traefikNetwork || 'the selected Docker network'}.`
        : 'No proxy routing is configured for this project.',
      targetCount > 1
        ? `${targetCount} target servers are configured for fan-out deploys.`
        : `Target server: ${server?.name || project.serverId || 'local'}.`
    ]
  };
}

function recommendedDeploymentStrategy(server: ServerRecord | null, traefikEnabled: boolean, targetCount: number): { strategy: DeploymentStrategy; reason: string } {
  const dockerMode = server?.capabilities?.docker.mode;
  const providerMode = server?.capabilities?.traefik.providerMode;
  const providerNetwork = server?.capabilities?.traefik.networkDetails?.find((network) => network.name === server.capabilities?.traefik.dockerProviderNetwork);

  if (dockerMode === 'swarm-worker') {
    return { strategy: 'swarm', reason: 'the selected target is a Swarm worker and stack deploys must be dispatched by a manager.' };
  }
  if (dockerMode === 'swarm-manager' && (providerMode === 'swarm' || providerMode === 'mixed')) {
    return { strategy: 'swarm', reason: `Traefik is using the ${providerMode} provider on a Swarm manager.` };
  }
  if (targetCount > 1 && dockerMode === 'swarm-manager') {
    return { strategy: 'swarm', reason: 'multiple targets can be represented with Swarm placement constraints from one manager deploy.' };
  }
  if (traefikEnabled && providerNetwork?.driver === 'overlay' && providerNetwork.attachable === false) {
    return { strategy: 'swarm', reason: `${providerNetwork.name} is a non-attachable overlay network.` };
  }

  return { strategy: 'compose', reason: dockerMode ? `${dockerMode.replace(/-/g, ' ')} with Docker-provider compatible networking.` : 'no Swarm-only topology was detected.' };
}

const ansi256ColorClasses: Record<number, string> = {
  0: 'ansi-fg-black',
  1: 'ansi-fg-red',
  2: 'ansi-fg-green',
  3: 'ansi-fg-yellow',
  4: 'ansi-fg-blue',
  5: 'ansi-fg-magenta',
  6: 'ansi-fg-cyan',
  7: 'ansi-fg-white',
  8: 'ansi-fg-bright-black',
  9: 'ansi-fg-bright-red',
  10: 'ansi-fg-bright-green',
  11: 'ansi-fg-bright-yellow',
  12: 'ansi-fg-bright-blue',
  13: 'ansi-fg-bright-magenta',
  14: 'ansi-fg-bright-cyan',
  15: 'ansi-fg-bright-white',
};

function ansiLogToHtml(value: string) {
  const tokenPattern = /(?:\u001b\[[0-9;]*m|\[[0-9;]*m)/g;
  let cursor = 0;
  let foreground = '';
  let html = '';
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(value)) !== null) {
    html += wrapAnsiSegment(value.slice(cursor, match.index), foreground);
    foreground = applyAnsiCodes(match[0], foreground);
    cursor = match.index + match[0].length;
  }

  html += wrapAnsiSegment(value.slice(cursor), foreground);
  return html;
}

function applyAnsiCodes(token: string, foreground: string) {
  const rawCodes = token.replace(/^\u001b?\[/, '').replace(/m$/, '');
  const codes = rawCodes ? rawCodes.split(';').map((code) => Number(code)) : [0];
  let nextForeground = foreground;

  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index];
    if (code === 0 || code === 39) {
      nextForeground = '';
    } else if (ansiColorClasses[code]) {
      nextForeground = ansiColorClasses[code];
    } else if (code === 38 && codes[index + 1] === 5) {
      nextForeground = ansi256ColorClasses[codes[index + 2]] || '';
      index += 2;
    } else if (code === 38 && codes[index + 1] === 2) {
      index += 4;
    }
  }

  return nextForeground;
}

function wrapAnsiSegment(value: string, foreground: string) {
  if (!value) {
    return '';
  }

  const escaped = escapeHtml(value);
  return foreground ? `<span class="${foreground}">${escaped}</span>` : escaped;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
