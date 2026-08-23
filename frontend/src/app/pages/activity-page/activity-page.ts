import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Subscription } from 'rxjs';
import { NotificationDeliveryRecord } from '../../models/project';
import { ControllerEvent, EventBusService } from '../../services/event-bus';
import { ProjectApi } from '../../services/project-api';

interface ActivityItem {
  id: string;
  dedupeKey: string;
  type: string;
  title: string;
  detail: string;
  time: string;
  tone: 'neutral' | 'success' | 'warning' | 'danger';
  projectId?: string;
  serverId?: string;
}

@Component({
  selector: 'app-activity-page',
  imports: [RouterLink],
  templateUrl: './activity-page.html',
  styleUrl: './activity-page.scss',
})
export class ActivityPage implements OnInit, OnDestroy {
  private readonly eventBus = inject(EventBusService);
  private readonly api = inject(ProjectApi);
  private subscription?: Subscription;

  protected readonly events = signal<ActivityItem[]>([]);
  protected readonly streamState = signal<'connecting' | 'live' | 'error'>('connecting');

  ngOnInit() {
    this.loadNotificationHistory();
    this.subscription = this.eventBus.stream().subscribe({
      next: (event) => {
        this.streamState.set('live');
        this.upsertActivityItem(this.toActivityItem(event));
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

  protected eventTypeLabel(value: string) {
    return value.replace(/\./g, ' ');
  }

  private upsertActivityItem(item: ActivityItem) {
    this.events.update((events) => {
      const existing = events.findIndex((event) => event.dedupeKey === item.dedupeKey);
      if (existing === -1) {
        return [item, ...events].slice(0, 200);
      }

      const next = events.filter((event) => event.dedupeKey !== item.dedupeKey);
      return [item, ...next].slice(0, 200);
    });
  }

  private toActivityItem(event: ControllerEvent): ActivityItem {
    if (event.type === 'connected') {
      return {
        id: this.eventId(event.type, event.connectedAt),
        dedupeKey: 'connected',
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
        dedupeKey: 'projects.updated',
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
        dedupeKey: 'servers.updated',
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
        dedupeKey: `server.health:${event.server.id}`,
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
        serverId: event.server.id,
      };
    }

    if (event.type === 'deployment.updated') {
      const deployment = event.deployment;
      return {
        id: this.eventId(event.type, event.projectId || event.projectName, deployment?.id || 'none'),
        dedupeKey: `deployment.updated:${deployment?.id || event.projectId || event.projectName}`,
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
        serverId: deployment?.serverId,
      };
    }

    if (event.type === 'runtime.status') {
      return {
        id: this.eventId(event.type, event.projectId || event.projectName, event.status.checkedAt),
        dedupeKey: `runtime.status:${event.projectId || event.projectName}`,
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

    if (event.type === 'notification.sent') {
      return this.notificationToActivityItem(event.notification);
    }

    return {
      id: this.eventId(event.type, event.operation.id, event.operation.finishedAt),
      dedupeKey: `runtime.operation.updated:${event.operation.id}`,
      type: event.type,
      title: `${event.projectName} ${event.operation.action} ${event.operation.status}`,
      detail: `${event.operation.service} on ${event.operation.serverId}${event.operation.error ? ` · ${event.operation.error}` : ''}`,
      time: event.operation.finishedAt,
      tone: event.operation.status === 'succeeded' ? 'success' : 'danger',
      projectId: event.projectId,
      serverId: event.operation.serverId,
    };
  }

  private loadNotificationHistory() {
    this.api.listNotificationHistory(50).subscribe({
      next: (records) => {
        for (const record of records.reverse()) {
          this.upsertActivityItem(this.notificationToActivityItem(record));
        }
      },
    });
  }

  private notificationToActivityItem(record: NotificationDeliveryRecord): ActivityItem {
    return {
      id: this.eventId('notification', record.id),
      dedupeKey: `notification:${record.id}`,
      type: 'notification.sent',
      title: `${record.channelName || 'Notification'} ${record.status}`,
      detail: `${record.title}${record.error ? ` · ${record.error}` : ''}`,
      time: record.createdAt,
      tone: record.status === 'sent' ? 'success' : record.status === 'failed' ? 'danger' : 'warning',
      projectId: record.projectId,
    };
  }

  private eventId(...parts: string[]) {
    return parts.join(':');
  }
}
