import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { AuthService } from './auth';

export type RuntimeLogStreamEvent =
  | { type: 'status'; status: 'connecting' | 'live' | 'closed' }
  | { type: 'log'; stream: 'stdout' | 'stderr'; chunk: string }
  | { type: 'error'; error: string };

@Injectable({ providedIn: 'root' })
export class RuntimeLogStreamService {
  private readonly auth = inject(AuthService);

  follow(projectRef: string, service: string, tail: number) {
    return new Observable<RuntimeLogStreamEvent>((subscriber) => {
      const websocket = new WebSocket(this.streamUrl(projectRef, service, tail));

      websocket.onmessage = (event) => {
        try {
          subscriber.next(JSON.parse(event.data) as RuntimeLogStreamEvent);
        } catch (error) {
          subscriber.error(error);
        }
      };

      websocket.onerror = () => {
        subscriber.error(new Error('Runtime log stream failed.'));
      };

      websocket.onclose = () => {
        subscriber.complete();
      };

      return () => {
        websocket.close();
      };
    });
  }

  private streamUrl(projectRef: string, service: string, tail: number) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = new URL(`${protocol}//${window.location.host}/api/projects/${encodeURIComponent(projectRef)}/runtime-logs/stream`);
    const token = this.auth.currentToken();

    url.searchParams.set('service', service);
    url.searchParams.set('tail', String(tail));
    if (token) {
      url.searchParams.set('token', token);
    }

    return url.toString();
  }
}
