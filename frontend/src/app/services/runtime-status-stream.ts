import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { RuntimeStatus } from '../models/project';
import { AuthService } from './auth';

export interface RuntimeStatusStreamMessage {
  type: 'runtime-status';
  projectId?: string;
  projectName: string;
  status: RuntimeStatus;
}

@Injectable({ providedIn: 'root' })
export class RuntimeStatusStreamService {
  private readonly auth = inject(AuthService);

  streamStatuses() {
    return new Observable<RuntimeStatusStreamMessage>((subscriber) => {
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
            subscriber.next(JSON.parse(event.data) as RuntimeStatusStreamMessage);
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
    const url = new URL(`${protocol}//${window.location.host}/api/projects/runtime-status/stream`);
    const token = this.auth.currentToken();

    if (token) {
      url.searchParams.set('token', token);
    }

    return url.toString();
  }
}
