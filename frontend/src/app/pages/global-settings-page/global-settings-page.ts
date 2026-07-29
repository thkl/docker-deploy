import { Component, inject, OnInit, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ProjectApi } from '../../services/project-api';
import { ProjectStore } from '../../state/project-store';

@Component({
  selector: 'app-global-settings-page',
  imports: [ReactiveFormsModule],
  templateUrl: './global-settings-page.html',
  styleUrl: './global-settings-page.scss',
})
export class GlobalSettingsPage implements OnInit {
  private readonly api = inject(ProjectApi);
  private readonly fb = inject(NonNullableFormBuilder);
  private readonly store = inject(ProjectStore);

  protected readonly loading = signal(false);
  protected readonly saving = signal(false);
  protected readonly message = signal('');
  protected readonly error = signal('');
  protected readonly servers = this.store.servers;
  protected readonly form = this.fb.group({
    dataRoot: ['/root/docker-apps', [Validators.required]],
    defaultTraefikNetwork: ['proxy', [Validators.required]],
    defaultTraefikEntryPoints: ['websecure', [Validators.required]],
    defaultTraefikCertResolver: ['letsencrypt', [Validators.required]],
    sshKeyPath: ['~/.ssh', [Validators.required]],
    cleanupAfterDeploy: [false],
  });

  ngOnInit() {
    this.store.loadServers();
    this.loadSettings();
  }

  protected save() {
    this.message.set('');
    this.error.set('');

    if (this.form.invalid) {
      this.form.markAllAsTouched();
      this.error.set('Complete the required settings before saving.');
      return;
    }

    this.saving.set(true);
    this.api.updateGlobalSettings(this.form.getRawValue()).subscribe({
      next: (settings) => {
        this.form.reset(settings);
        this.store.loadProjects();
        this.message.set('Global settings saved.');
        this.saving.set(false);
      },
      error: (error) => {
        this.error.set(error?.error?.error || 'Could not save global settings.');
        this.saving.set(false);
      },
    });
  }

  private loadSettings() {
    this.loading.set(true);
    this.api.getGlobalSettings().subscribe({
      next: (settings) => {
        this.form.reset(settings);
        this.loading.set(false);
      },
      error: () => {
        this.error.set('Could not load global settings.');
        this.loading.set(false);
      },
    });
  }
}
