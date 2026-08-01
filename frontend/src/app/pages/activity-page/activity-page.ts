import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { ControllerEvent, EventBusService } from '../../services/event-bus';

interface ActivityItem {
  id: string;
  type: ControllerEvent['type'];
  title: string;
  detail: string;
  time: string;
  tone: 'neutral' | 'success' | 'warning' | 'danger';
  projectId?: string;
}

@Component({
  selector: 'app-activity-page',
  imports: [RouterLink],
  templateUrl: './activity-page.html',
  styleUrl: './activity-page.scss',
})
export class ActivityPage implements OnInit, OnDestroy {
  private readonly eventBus = inject(EventBusService);
  private subscription?: Subscription;

  protected readonly events = signal<ActivityItem[]>([]);
  protected readonly streamState = signal<'connecting' | 'live' | 'error'>('connecting');

  ngOnInit() {
    this.subscription = this.eventBus.stream().subscribe({
      next: (event) => {
        this.streamState.set('live');
        this.events.update((events) => [this.toActivityItem(event), ...events].slice(0, 200));
      },
      error: () => {
        this.streamState.set('error');
      },
    });
  }

  ngOnDestroy() {
    this.subscription?.unsubscribe();
  }

  protected streamLabel() {
    return this.streamState() === 'live'
      ? 'Live'
      : this.streamState() === 'error'
        ? 'Stream lost'
        : 'Connecting';
  }

  protected formatDate(value: string) {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'short',
      timeStyle: 'medium',
    }).format(new Date(value));
  }

  protected eventTypeLabel(value: ControllerEvent['type']) {
    return value.replace(/\./g, ' ');
  }

  private toActivityItem(event: ControllerEvent): ActivityItem {
    if (event.type === 'connected') {
      return {
        id: this.eventId(event.type, event.connectedAt),
        type: event.type,
        title: 'Event stream connected',
        detail: 'Controller events are flowing to this browser.',
        time: event.connectedAt,
        tone: 'success',
      };
    }

    if (event.type === 'projects.updated') {
      return {
        id: this.eventId(event.type, event.changedAt),
        type: event.type,
        title: 'Projects changed',
        detail: 'Project configuration was updated.',
        time: event.changedAt,
        tone: 'neutral',
      };
    }

    if (event.type === 'servers.updated') {
      return {
        id: this.eventId(event.type, event.changedAt),
        type: event.type,
        title: 'Servers changed',
        detail: 'Server or agent configuration was updated.',
        time: event.changedAt,
        tone: 'neutral',
      };
    }

    if (event.type === 'server.health') {
      return {
        id: this.eventId(event.type, event.server.id, event.server.updatedAt),
        type: event.type,
        title: `${event.server.name} is ${event.server.status || 'unknown'}`,
        detail: [
          event.server.agentVersion ? `version ${event.server.agentVersion}` : 'version unknown',
          `${event.server.activeJobs?.length ?? 0} active jobs`,
          event.server.lastHealthError || '',
        ].filter(Boolean).join(' · '),
        time: event.server.lastSeenAt || event.server.updatedAt,
        tone: event.server.status === 'online'
          ? 'success'
          : event.server.status === 'unpaired'
            ? 'warning'
            : 'danger',
      };
    }

    if (event.type === 'deployment.updated') {
      const deployment = event.deployment;
      return {
        id: this.eventId(event.type, event.projectId || event.projectName, deployment?.id || 'none', deployment?.finishedAt || deployment?.startedAt || new Date().toISOString()),
        type: event.type,
        title: deployment ? `${deployment.projectName} deployment ${deployment.status}` : `${event.projectName} deployment updated`,
        detail: deployment
          ? `${deployment.trigger} deploy on ${deployment.serverId || 'local'}${deployment.error ? ` · ${deployment.error}` : ''}`
          : 'No deployment record is available.',
        time: deployment?.finishedAt || deployment?.startedAt || new Date().toISOString(),
        tone: deployment?.status === 'succeeded'
          ? 'success'
          : deployment?.status === 'failed'
            ? 'danger'
            : 'warning',
        projectId: event.projectId,
      };
    }

    if (event.type === 'runtime.status') {
      return {
        id: this.eventId(event.type, event.projectId || event.projectName, event.status.checkedAt),
        type: event.type,
        title: `${event.projectName} runtime ${event.status.status}`,
        detail: `${event.status.services.length} services checked${event.status.error ? ` · ${event.status.error}` : ''}`,
        time: event.status.checkedAt,
        tone: event.status.status === 'running'
          ? 'success'
          : event.status.status === 'partial'
            ? 'warning'
            : event.status.status === 'error'
              ? 'danger'
              : 'neutral',
        projectId: event.projectId,
      };
    }

    return {
      id: this.eventId(event.type, event.operation.id, event.operation.finishedAt),
      type: event.type,
      title: `${event.projectName} ${event.operation.action} ${event.operation.status}`,
      detail: `${event.operation.service} on ${event.operation.serverId}${event.operation.error ? ` · ${event.operation.error}` : ''}`,
      time: event.operation.finishedAt,
      tone: event.operation.status === 'succeeded' ? 'success' : 'danger',
      projectId: event.projectId,
    };
  }

  private eventId(...parts: string[]) {
    return `${parts.join(':')}:${Math.random().toString(36).slice(2)}`;
  }
}
