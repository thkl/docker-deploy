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

  streamLatest(projectName: string) {
    return new Observable<DeploymentRecord | null>((subscriber) => {
      const websocket = new WebSocket(this.streamUrl(projectName));

      websocket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as DeploymentStreamMessage;
          subscriber.next(message.deployment);
        } catch (error) {
          subscriber.error(error);
        }
      };

      websocket.onerror = () => {
        subscriber.error(new Error('Deployment log stream failed.'));
      };

      websocket.onclose = () => {
        subscriber.complete();
      };

      return () => {
        websocket.close();
      };
    });
  }

  private streamUrl(projectName: string) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = new URL(`${protocol}//${window.location.host}/api/projects/${encodeURIComponent(projectName)}/deployments/stream`);
    const token = this.auth.currentToken();

    if (token) {
      url.searchParams.set('token', token);
    }

    return url.toString();
  }
}
