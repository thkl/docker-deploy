import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { AuthService } from './auth';

export type ContainerLogStreamEvent =
  | { type: 'status'; status: 'connecting' | 'live' | 'closed' }
  | { type: 'log'; stream: 'stdout' | 'stderr'; chunk: string }
  | { type: 'error'; error: string };

@Injectable({ providedIn: 'root' })
export class ContainerLogStreamService {
  private readonly auth = inject(AuthService);

  follow(serverId: string, containerId: string, tail: number) {
    return new Observable<ContainerLogStreamEvent>((subscriber) => {
      const websocket = new WebSocket(this.streamUrl(serverId, containerId, tail));

      websocket.onmessage = (event) => {
        try {
          subscriber.next(JSON.parse(event.data) as ContainerLogStreamEvent);
        } catch (error) {
          subscriber.error(error);
        }
      };
      websocket.onerror = () => subscriber.error(new Error('Container log stream failed.'));
      websocket.onclose = () => subscriber.complete();

      return () => websocket.close();
    });
  }

  private streamUrl(serverId: string, containerId: string, tail: number) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = new URL(`${protocol}//${window.location.host}/api/containers/${encodeURIComponent(serverId)}/${encodeURIComponent(containerId)}/logs/stream`);
    const token = this.auth.currentToken();
    url.searchParams.set('tail', String(tail));
    if (token) {
      url.searchParams.set('token', token);
    }
    return url.toString();
  }
}
