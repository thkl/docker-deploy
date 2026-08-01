import { inject, Injectable } from '@angular/core';
import { Observable, shareReplay } from 'rxjs';
import { DeploymentRecord, RuntimeOperationRecord, RuntimeStatus, ServerRecord } from '../models/project';
import { AuthService } from './auth';

export type ControllerEvent =
  | { type: 'connected'; connectedAt: string }
  | { type: 'projects.updated'; changedAt: string }
  | { type: 'servers.updated'; changedAt: string }
  | { type: 'server.health'; server: ServerRecord }
  | { type: 'deployment.updated'; projectId?: string; projectName: string; deployment: DeploymentRecord | null }
  | { type: 'runtime.status'; projectId?: string; projectName: string; status: RuntimeStatus }
  | { type: 'runtime.operation.updated'; projectId?: string; projectName: string; operation: RuntimeOperationRecord };

@Injectable({ providedIn: 'root' })
export class EventBusService {
  private readonly auth = inject(AuthService);
  private readonly events$ = this.createStream().pipe(shareReplay({ bufferSize: 200, refCount: true }));

  stream() {
    return this.events$;
  }

  private createStream() {
    return new Observable<ControllerEvent>((subscriber) => {
      let websocket: WebSocket | undefined;
      let reconnectTimer: ReturnType<typeof window.setTimeout> | undefined;
      let reconnectDelay = 1000;
      let closed = false;

      const connect = () => {
        websocket = new WebSocket(this.streamUrl());

        websocket.onopen = () => {
          reconnectDelay = 1000;
        };

        websocket.onmessage = (event) => {
          try {
            subscriber.next(JSON.parse(event.data) as ControllerEvent);
          } catch (error) {
            subscriber.error(error);
          }
        };

        websocket.onerror = () => {
          websocket?.close();
        };

        websocket.onclose = () => {
          if (closed || subscriber.closed) {
            return;
          }

          reconnectTimer = window.setTimeout(connect, reconnectDelay);
          reconnectDelay = Math.min(reconnectDelay * 2, 10_000);
        };
      };

      connect();

      return () => {
        closed = true;
        if (reconnectTimer) {
          window.clearTimeout(reconnectTimer);
        }
        websocket?.close();
      };
    });
  }

  private streamUrl() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = new URL(`${protocol}//${window.location.host}/api/events/stream`);
    const token = this.auth.currentToken();

    if (token) {
      url.searchParams.set('token', token);
    }

    return url.toString();
  }
}
