import { Component, inject, OnInit } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { AuthService } from './services/auth';
import { ProjectStore } from './state/project-store';

@Component({
  selector: 'app-root',
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App implements OnInit {
  protected readonly store = inject(ProjectStore);
  protected readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  ngOnInit() {
    this.auth.loadStatus().subscribe({
      next: () => {
        if (!this.auth.authRequired()) {
          this.store.loadProjects();
          return;
        }

        const token = this.auth.currentToken();
        if (!token) {
          void this.router.navigate(['/login']);
          return;
        }

        this.auth.login(token).subscribe({
          next: () => {
            this.store.loadProjects();
          },
          error: () => {
            this.auth.logout();
            void this.router.navigate(['/login']);
          },
        });
      },
      error: () => {
        void this.router.navigate(['/login']);
      },
    });
  }

  protected logout() {
    this.auth.logout();
    void this.router.navigate(['/login']);
  }
}
