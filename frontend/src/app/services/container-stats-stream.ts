import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { ContainerStatsSample } from '../models/project';
import { AuthService } from './auth';

export type ContainerStatsStreamEvent =
  | { type: 'status'; status: 'connecting' | 'live' | 'closed' }
  | { type: 'stats'; samples: ContainerStatsSample[] }
  | { type: 'error'; error: string };

@Injectable({ providedIn: 'root' })
export class ContainerStatsStreamService {
  private readonly auth = inject(AuthService);

  follow(serverId: string) {
    return new Observable<ContainerStatsStreamEvent>((subscriber) => {
      let websocket: WebSocket | undefined;
      let reconnectTimer: ReturnType<typeof window.setTimeout> | undefined;
      let reconnectDelay = 1000;
      let closed = false;

      const connect = () => {
        subscriber.next({ type: 'status', status: 'connecting' });
        const nextSocket = new WebSocket(this.streamUrl(serverId));
        websocket = nextSocket;
        nextSocket.onopen = () => {
          reconnectDelay = 1000;
        };
        nextSocket.onmessage = (event) => {
          try {
            subscriber.next(JSON.parse(event.data) as ContainerStatsStreamEvent);
          } catch (error) {
            subscriber.error(error);
          }
        };
        nextSocket.onerror = () => nextSocket.close();
        nextSocket.onclose = () => {
          if (closed || subscriber.closed) return;
          reconnectTimer = window.setTimeout(connect, reconnectDelay);
          reconnectDelay = Math.min(reconnectDelay * 2, 10_000);
        };
      };

      connect();
      return () => {
        closed = true;
        if (reconnectTimer) window.clearTimeout(reconnectTimer);
        websocket?.close();
      };
    });
  }

  private streamUrl(serverId: string) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = new URL(`${protocol}//${window.location.host}/api/containers/${encodeURIComponent(serverId)}/stats/stream`);
    const token = this.auth.currentToken();
    if (token) url.searchParams.set('token', token);
    return url.toString();
  }
}
