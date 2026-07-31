import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { ComposeInspection, ComposeValidation, DeleteProjectPayload, DeleteProjectResult, DeploymentRecord, GlobalSettings, ProjectPayload, ProjectSummary, RuntimeActionResult, RuntimeLogs, RuntimeOperationRecord, RuntimeServiceAction, RuntimeStatus, ServerCapabilities, ServerPayload, ServerRecord, TraefikDiagnostics } from '../models/project';

@Injectable({ providedIn: 'root' })
export class ProjectApi {
  private readonly http = inject(HttpClient);

  listProjects(): Observable<ProjectSummary[]> {
    return this.http.get<ProjectSummary[]>('/api/projects');
  }

  createProject(payload: ProjectPayload): Observable<{ id?: string; name: string }> {
    return this.http.post<{ id?: string; name: string }>('/api/projects', payload);
  }

  updateProject(projectRef: string, payload: ProjectPayload): Observable<{ id?: string; name: string }> {
    return this.http.put<{ id?: string; name: string }>(`/api/projects/${encodeURIComponent(projectRef)}`, payload);
  }

  deleteProject(projectRef: string, payload: DeleteProjectPayload): Observable<DeleteProjectResult> {
    return this.http.delete<DeleteProjectResult>(`/api/projects/${encodeURIComponent(projectRef)}`, { body: payload });
  }

  deployProject(projectRef: string): Observable<{ status: string; deploymentId: string }> {
    return this.http.post<{ status: string; deploymentId: string }>(`/api/projects/${encodeURIComponent(projectRef)}/deploy`, {});
  }

  cancelDeployment(projectRef: string): Observable<DeploymentRecord | null> {
    return this.http.post<DeploymentRecord | null>(`/api/projects/${encodeURIComponent(projectRef)}/deployments/cancel`, {});
  }

  importCompose(projectRef: string): Observable<{ composeFile: string; compose: string }> {
    return this.http.post<{ composeFile: string; compose: string }>(`/api/projects/${encodeURIComponent(projectRef)}/compose/import`, {});
  }

  inspectCompose(projectRef: string): Observable<ComposeInspection> {
    return this.http.get<ComposeInspection>(`/api/projects/${encodeURIComponent(projectRef)}/compose/inspect`);
  }

  validateCompose(projectRef: string, payload?: ProjectPayload): Observable<ComposeValidation> {
    const url = `/api/projects/${encodeURIComponent(projectRef)}/compose/validate`;
    return payload ? this.http.post<ComposeValidation>(url, payload) : this.http.get<ComposeValidation>(url);
  }

  getLatestDeployment(projectRef: string): Observable<DeploymentRecord | null> {
    return this.http.get<DeploymentRecord | null>(`/api/projects/${encodeURIComponent(projectRef)}/deployments/latest`);
  }

  getProjectStatus(projectRef: string): Observable<RuntimeStatus> {
    return this.http.get<RuntimeStatus>(`/api/projects/${encodeURIComponent(projectRef)}/status`);
  }

  diagnoseTraefik(projectRef: string): Observable<TraefikDiagnostics> {
    return this.http.get<TraefikDiagnostics>(`/api/projects/${encodeURIComponent(projectRef)}/traefik/diagnostics`);
  }

  getRuntimeLogs(projectRef: string, service: string, tail: number): Observable<RuntimeLogs> {
    const params = new URLSearchParams({ service, tail: String(tail) });
    return this.http.get<RuntimeLogs>(`/api/projects/${encodeURIComponent(projectRef)}/runtime-logs?${params.toString()}`);
  }

  runRuntimeAction(projectRef: string, service: string, action: RuntimeServiceAction): Observable<RuntimeActionResult> {
    return this.http.post<RuntimeActionResult>(`/api/projects/${encodeURIComponent(projectRef)}/runtime-actions`, { service, action });
  }

  listRuntimeOperations(projectRef: string): Observable<RuntimeOperationRecord[]> {
    return this.http.get<RuntimeOperationRecord[]>(`/api/projects/${encodeURIComponent(projectRef)}/runtime-operations`);
  }

  listDeployments(projectRef: string): Observable<DeploymentRecord[]> {
    return this.http.get<DeploymentRecord[]>(`/api/projects/${encodeURIComponent(projectRef)}/deployments`);
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

  getServerCapabilities(serverId: string): Observable<ServerCapabilities> {
    return this.http.get<ServerCapabilities>(`/api/servers/${encodeURIComponent(serverId)}/capabilities`);
  }

  refreshServerHealth(serverId: string): Observable<ServerRecord> {
    return this.http.post<ServerRecord>(`/api/servers/${encodeURIComponent(serverId)}/health`, {});
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
