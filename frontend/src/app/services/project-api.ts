import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { ComposeInspection, ComposeValidation, DeleteProjectPayload, DeleteProjectResult, DeploymentRecord, GlobalSettings, NotificationDeliveryRecord, PathBrowseResult, ProjectPayload, ProjectPreflightResult, ProjectReleaseSnapshot, ProjectSummary, RuntimeActionResult, RuntimeLogs, RuntimeOperationRecord, RuntimeServiceAction, RuntimeStatus, ServerCapabilities, ServerPayload, ServerRecord, TraefikConfigApplyResult, TraefikConfigBackup, TraefikConfigValidation, TraefikDefaultsPayload, TraefikDiagnostics, TraefikImpactPreview, VaultSecret, VaultSecretPayload, WebhookEventRecord } from '../models/project';

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

  runPreflight(projectRef: string): Observable<ProjectPreflightResult> {
    return this.http.post<ProjectPreflightResult>(`/api/projects/${encodeURIComponent(projectRef)}/preflight`, {});
  }

  exportProject(projectRef: string): Observable<string> {
    return this.http.get(`/api/projects/${encodeURIComponent(projectRef)}/export`, { responseType: 'text' });
  }

  importProjectCompose(content: string): Observable<ProjectPayload> {
    return this.http.post<ProjectPayload>('/api/projects/import', { content });
  }

  cancelDeployment(projectRef: string): Observable<DeploymentRecord | null> {
    return this.http.post<DeploymentRecord | null>(`/api/projects/${encodeURIComponent(projectRef)}/deployments/cancel`, {});
  }

  listReleases(projectRef: string): Observable<ProjectReleaseSnapshot[]> {
    return this.http.get<ProjectReleaseSnapshot[]>(`/api/projects/${encodeURIComponent(projectRef)}/releases`);
  }

  rollbackRelease(projectRef: string, releaseId: string): Observable<{ status: string; deploymentId: string; deploymentIds?: string[] }> {
    return this.http.post<{ status: string; deploymentId: string; deploymentIds?: string[] }>(`/api/projects/${encodeURIComponent(projectRef)}/releases/${encodeURIComponent(releaseId)}/rollback`, {});
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

  getLatestWebhook(projectRef: string): Observable<WebhookEventRecord | null> {
    return this.http.get<WebhookEventRecord | null>(`/api/projects/${encodeURIComponent(projectRef)}/webhooks/latest`);
  }

  getGlobalSettings(): Observable<GlobalSettings> {
    return this.http.get<GlobalSettings>('/api/settings');
  }

  updateGlobalSettings(payload: GlobalSettings): Observable<GlobalSettings> {
    return this.http.put<GlobalSettings>('/api/settings', payload);
  }

  testNotification(channelId?: string): Observable<{ ok: boolean; channels: Array<{ id: string; name: string; type: string }> }> {
    return this.http.post<{ ok: boolean; channels: Array<{ id: string; name: string; type: string }> }>('/api/settings/notifications/test', { channelId });
  }

  listNotificationHistory(limit = 100): Observable<NotificationDeliveryRecord[]> {
    return this.http.get<NotificationDeliveryRecord[]>(`/api/settings/notifications/history?limit=${limit}`);
  }

  exportBackup(): Observable<unknown> {
    return this.http.get<unknown>('/api/settings/backup');
  }

  restoreBackup(backup: unknown): Observable<{ restored: boolean; restartRecommended?: boolean }> {
    return this.http.post<{ restored: boolean }>('/api/settings/backup/restore', backup);
  }

  listVaultSecrets(namespace?: string): Observable<VaultSecret[]> {
    const query = namespace ? `?namespace=${encodeURIComponent(namespace)}` : '';
    return this.http.get<VaultSecret[]>(`/api/secrets${query}`);
  }

  createVaultSecret(payload: VaultSecretPayload): Observable<VaultSecret> {
    return this.http.post<VaultSecret>('/api/secrets', payload);
  }

  updateVaultSecret(id: string, payload: VaultSecretPayload): Observable<VaultSecret> {
    return this.http.put<VaultSecret>(`/api/secrets/${encodeURIComponent(id)}`, payload);
  }

  deleteVaultSecret(id: string): Observable<{ deleted: boolean }> {
    return this.http.delete<{ deleted: boolean }>(`/api/secrets/${encodeURIComponent(id)}`);
  }

  testBackup(payload: GlobalSettings): Observable<{ ok: boolean; path: string; createdAt: string }> {
    return this.http.post<{ ok: boolean; path: string; createdAt: string }>('/api/settings/backup/test', payload);
  }

  browseControllerPath(path: string): Observable<PathBrowseResult> {
    const params = new URLSearchParams({ path });
    return this.http.get<PathBrowseResult>(`/api/settings/paths/browse?${params.toString()}`);
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

  browseServerPath(serverId: string, path: string): Observable<PathBrowseResult> {
    const params = new URLSearchParams({ path });
    return this.http.get<PathBrowseResult>(`/api/servers/${encodeURIComponent(serverId)}/paths/browse?${params.toString()}`);
  }

  backupTraefik(serverId: string): Observable<TraefikConfigBackup> {
    return this.http.get<TraefikConfigBackup>(`/api/servers/${encodeURIComponent(serverId)}/traefik/backup`);
  }

  validateTraefik(serverId: string): Observable<TraefikConfigValidation> {
    return this.http.get<TraefikConfigValidation>(`/api/servers/${encodeURIComponent(serverId)}/traefik/validate`);
  }

  previewTraefikImpact(serverId: string): Observable<TraefikImpactPreview> {
    return this.http.get<TraefikImpactPreview>(`/api/servers/${encodeURIComponent(serverId)}/traefik/impact`);
  }

  applyTraefikDefaults(serverId: string, payload: TraefikDefaultsPayload): Observable<{ settings: GlobalSettings; applyResult: TraefikConfigApplyResult | null; server?: ServerRecord }> {
    return this.http.post<{ settings: GlobalSettings; applyResult: TraefikConfigApplyResult | null; server?: ServerRecord }>(`/api/servers/${encodeURIComponent(serverId)}/traefik/defaults`, payload);
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
