import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { RuntimeOperationRecord, RuntimeServiceAction } from '../models/project';
import { AuthService } from './auth';

export type RuntimeOperationStreamEvent =
  | { type: 'status'; status: 'connecting' | 'live' | 'closed' | 'error' }
  | { type: 'log'; stream: 'stdout' | 'stderr'; chunk: string }
  | { type: 'operation'; operation: RuntimeOperationRecord }
  | { type: 'error'; error: string };

@Injectable({ providedIn: 'root' })
export class RuntimeOperationStreamService {
  private readonly auth = inject(AuthService);

  run(projectRef: string, service: string, action: RuntimeServiceAction) {
    return new Observable<RuntimeOperationStreamEvent>((subscriber) => {
      const websocket = new WebSocket(this.streamUrl(projectRef, service, action));

      websocket.onmessage = (event) => {
        try {
          subscriber.next(JSON.parse(event.data) as RuntimeOperationStreamEvent);
        } catch (error) {
          subscriber.error(error);
        }
      };

      websocket.onerror = () => {
        subscriber.error(new Error('Runtime action stream failed.'));
      };

      websocket.onclose = () => {
        subscriber.complete();
      };

      return () => {
        websocket.close();
      };
    });
  }

  private streamUrl(projectRef: string, service: string, action: RuntimeServiceAction) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = new URL(`${protocol}//${window.location.host}/api/projects/${encodeURIComponent(projectRef)}/runtime-actions/stream`);
    const token = this.auth.currentToken();

    url.searchParams.set('service', service);
    url.searchParams.set('action', action);
    if (token) {
      url.searchParams.set('token', token);
    }

    return url.toString();
  }
}
