import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { DeploymentRecord } from '../models/project';
import { AuthService } from './auth';

interface DeploymentStreamMessage {
  type: 'snapshot' | 'deployment';
  deployment: DeploymentRecord | null;
}

@Injectable({ providedIn: 'root' })
export class DeploymentStreamService {
  private readonly auth = inject(AuthService);

  streamLatest(projectRef: string) {
    return new Observable<DeploymentRecord | null>((subscriber) => {
      let websocket: WebSocket | undefined;
      let reconnectTimer: ReturnType<typeof window.setTimeout> | undefined;
      let reconnectDelay = 1000;
      let closed = false;

      const connect = () => {
        websocket = new WebSocket(this.streamUrl(projectRef));

        websocket.onopen = () => {
          reconnectDelay = 1000;
        };

        websocket.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data) as DeploymentStreamMessage;
            subscriber.next(message.deployment);
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

  private streamUrl(projectRef: string) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = new URL(`${protocol}//${window.location.host}/api/projects/${encodeURIComponent(projectRef)}/deployments/stream`);
    const token = this.auth.currentToken();

    if (token) {
      url.searchParams.set('token', token);
    }

    return url.toString();
  }
}
