import { Component, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../../services/auth';
import { ProjectStore } from '../../state/project-store';

@Component({
  selector: 'app-login-page',
  imports: [ReactiveFormsModule],
  templateUrl: './login-page.html',
  styleUrl: './login-page.scss',
})
export class LoginPage {
  private readonly auth = inject(AuthService);
  private readonly fb = inject(NonNullableFormBuilder);
  private readonly router = inject(Router);
  private readonly store = inject(ProjectStore);

  protected readonly error = signal('');
  protected readonly loading = signal(false);
  protected readonly form = this.fb.group({
    token: ['', [Validators.required]],
  });

  protected submit() {
    this.error.set('');

    if (this.form.invalid) {
      this.form.markAllAsTouched();
      this.error.set('Enter the admin token.');
      return;
    }

    this.loading.set(true);
    this.auth.login(this.form.controls.token.value).subscribe({
      next: () => {
        this.loading.set(false);
        this.store.loadProjects();
        void this.router.navigate(['/projects']);
      },
      error: () => {
        this.loading.set(false);
        this.error.set('Invalid admin token.');
      },
    });
  }
}
