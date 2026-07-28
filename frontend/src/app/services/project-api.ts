import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { DeploymentRecord, GlobalSettings, ProjectPayload, ProjectSummary } from '../models/project';

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

  deployProject(name: string): Observable<{ status: string; deploymentId: string }> {
    return this.http.post<{ status: string; deploymentId: string }>(`/api/projects/${encodeURIComponent(name)}/deploy`, {});
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
}
