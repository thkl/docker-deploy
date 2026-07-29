import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { DeleteProjectPayload, DeleteProjectResult, DeploymentRecord, GlobalSettings, ProjectPayload, ProjectSummary, ServerPayload, ServerRecord } from '../models/project';

@Injectable({ providedIn: 'root' })
export class ProjectApi {
  private readonly http = inject(HttpClient);

  listProjects(): Observable<ProjectSummary[]> {
    return this.http.get<ProjectSummary[]>('/api/projects');
  }

  createProject(payload: ProjectPayload): Observable<{ name: string }> {
    return this.http.post<{ name: string }>('/api/projects', payload);
  }

  updateProject(currentName: string, payload: ProjectPayload): Observable<{ name: string }> {
    return this.http.put<{ name: string }>(`/api/projects/${encodeURIComponent(currentName)}`, payload);
  }

  deleteProject(name: string, payload: DeleteProjectPayload): Observable<DeleteProjectResult> {
    return this.http.delete<DeleteProjectResult>(`/api/projects/${encodeURIComponent(name)}`, { body: payload });
  }

  deployProject(name: string): Observable<{ status: string; deploymentId: string }> {
    return this.http.post<{ status: string; deploymentId: string }>(`/api/projects/${encodeURIComponent(name)}/deploy`, {});
  }

  importCompose(name: string): Observable<{ composeFile: string; compose: string }> {
    return this.http.post<{ composeFile: string; compose: string }>(`/api/projects/${encodeURIComponent(name)}/compose/import`, {});
  }

  getLatestDeployment(name: string): Observable<DeploymentRecord | null> {
    return this.http.get<DeploymentRecord | null>(`/api/projects/${encodeURIComponent(name)}/deployments/latest`);
  }

  listDeployments(name: string): Observable<DeploymentRecord[]> {
    return this.http.get<DeploymentRecord[]>(`/api/projects/${encodeURIComponent(name)}/deployments`);
  }

  getGlobalSettings(): Observable<GlobalSettings> {
    return this.http.get<GlobalSettings>('/api/settings');
  }

  updateGlobalSettings(payload: GlobalSettings): Observable<GlobalSettings> {
    return this.http.put<GlobalSettings>('/api/settings', payload);
  }

  listServers(): Observable<ServerRecord[]> {
    return this.http.get<ServerRecord[]>('/api/servers');
  }

  createServer(payload: ServerPayload): Observable<ServerRecord> {
    return this.http.post<ServerRecord>('/api/servers', payload);
  }

  updateServer(id: string, payload: ServerPayload): Observable<ServerRecord> {
    return this.http.put<ServerRecord>(`/api/servers/${encodeURIComponent(id)}`, payload);
  }

  pairServer(id: string, pairingToken: string): Observable<ServerRecord> {
    return this.http.post<ServerRecord>(`/api/servers/${encodeURIComponent(id)}/pair`, { pairingToken });
  }

  deleteServer(id: string): Observable<{ deleted: boolean }> {
    return this.http.delete<{ deleted: boolean }>(`/api/servers/${encodeURIComponent(id)}`);
  }
}
