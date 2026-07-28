import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { ProjectPayload, ProjectSummary } from '../models/project';

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

  deployProject(name: string): Observable<{ status: string }> {
    return this.http.post<{ status: string }>(`/api/projects/${encodeURIComponent(name)}/deploy`, {});
  }
}

