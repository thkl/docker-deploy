import { HttpClient } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import { tap } from 'rxjs';
import { AuthStatus } from '../models/project';

export const adminTokenKey = 'updater.adminToken';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly token = signal(localStorage.getItem(adminTokenKey) ?? '');

  readonly status = signal<AuthStatus | null>(null);
  readonly loading = signal(false);
  readonly authenticated = computed(() => {
    const status = this.status();
    return status ? !status.required || Boolean(this.token()) : false;
  });
  readonly authRequired = computed(() => Boolean(this.status()?.required));

  loadStatus() {
    this.loading.set(true);
    return this.http.get<AuthStatus>('/api/auth/status').pipe(
      tap({
        next: (status) => {
          this.status.set(status);
          this.loading.set(false);
        },
        error: () => {
          this.status.set({ required: true });
          this.loading.set(false);
        },
      }),
    );
  }

  login(token: string) {
    return this.http.post<{ authenticated: boolean; token: string }>('/api/auth/login', { token }).pipe(
      tap((result) => {
        this.setToken(result.token);
      }),
    );
  }

  logout() {
    this.setToken('');
  }

  currentToken() {
    return this.token();
  }

  private setToken(token: string) {
    this.token.set(token);
    if (token) {
      localStorage.setItem(adminTokenKey, token);
    } else {
      localStorage.removeItem(adminTokenKey);
    }
  }
}
