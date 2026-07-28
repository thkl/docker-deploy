import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { DeploymentRecord } from '../models/project';

interface DeploymentStreamMessage {
  type: 'snapshot' | 'deployment';
  deployment: DeploymentRecord | null;
}

@Injectable({ providedIn: 'root' })
export class DeploymentStreamService {
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
    return `${protocol}//${window.location.host}/api/projects/${encodeURIComponent(projectName)}/deployments/stream`;
  }
}
