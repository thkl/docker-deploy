import { Component, inject, OnInit, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { PathBrowseResult } from '../../models/project';
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
  protected readonly exportingBackup = signal(false);
  protected readonly restoringBackup = signal(false);
  protected readonly testingBackup = signal(false);
  protected readonly browsingBackupPath = signal(false);
  protected readonly backupPathBrowser = signal<PathBrowseResult | null>(null);
  protected readonly backupPathBrowserError = signal('');
  protected readonly message = signal('');
  protected readonly error = signal('');
  protected readonly form = this.fb.group({
    dataRoot: ['/root/docker-apps', [Validators.required]],
    defaultTraefikNetwork: ['proxy', [Validators.required]],
    defaultTraefikEntryPoints: ['websecure', [Validators.required]],
    defaultTraefikCertResolver: ['letsencrypt', [Validators.required]],
    sshKeyPath: ['~/.ssh', [Validators.required]],
    cleanupAfterDeploy: [false],
    autoBackupEnabled: [false],
    autoBackupCron: ['0 3 * * *', [Validators.required]],
    autoBackupPath: ['/root/docker-apps/.updater/backups', [Validators.required]],
    registryAddress: [''],
    registryUsername: [''],
    registryPassword: [''],
  });

  ngOnInit() {
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

  protected exportBackup() {
    this.message.set('');
    this.error.set('');
    this.exportingBackup.set(true);

    this.api.exportBackup().subscribe({
      next: (backup) => {
        const createdAt = typeof backup === 'object' && backup !== null && 'createdAt' in backup
          ? String((backup as { createdAt?: unknown }).createdAt ?? new Date().toISOString())
          : new Date().toISOString();
        const blob = new Blob([`${JSON.stringify(backup, null, 2)}\n`], { type: 'application/json' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `deploy-backup-${createdAt.slice(0, 10)}.json`;
        link.click();
        URL.revokeObjectURL(link.href);
        this.message.set('Backup exported.');
        this.exportingBackup.set(false);
      },
      error: (error) => {
        this.error.set(error?.error?.error || 'Could not export backup.');
        this.exportingBackup.set(false);
      },
    });
  }

  protected testBackup() {
    this.message.set('');
    this.error.set('');

    if (this.form.invalid) {
      this.form.markAllAsTouched();
      this.error.set('Complete the required settings before testing the backup path.');
      return;
    }

    this.testingBackup.set(true);
    this.api.testBackup(this.form.getRawValue()).subscribe({
      next: (result) => {
        this.message.set(`Test backup written to ${result.path}.`);
        this.testingBackup.set(false);
      },
      error: (error) => {
        this.error.set(error?.error?.error || 'Could not write test backup.');
        this.testingBackup.set(false);
      },
    });
  }

  protected toggleBackupPathBrowser() {
    if (this.backupPathBrowser()) {
      this.backupPathBrowser.set(null);
      this.backupPathBrowserError.set('');
      return;
    }

    this.browseBackupPath(this.form.controls.autoBackupPath.value || '/');
  }

  protected closeBackupPathBrowserFromBackdrop(event: MouseEvent) {
    if (event.target !== event.currentTarget) {
      return;
    }

    this.toggleBackupPathBrowser();
  }

  protected browseBackupPath(path: string) {
    this.backupPathBrowserError.set('');
    this.browsingBackupPath.set(true);
    this.api.browseControllerPath(path || '/').subscribe({
      next: (result) => {
        this.backupPathBrowser.set(result);
        this.form.controls.autoBackupPath.setValue(result.path);
        this.browsingBackupPath.set(false);
      },
      error: (error) => {
        this.backupPathBrowserError.set(error?.error?.error || 'Could not browse this path.');
        this.browsingBackupPath.set(false);
      },
    });
  }

  protected selectBackupPath(path: string) {
    this.form.controls.autoBackupPath.setValue(path);
    this.backupPathBrowser.set(null);
    this.backupPathBrowserError.set('');
  }

  protected restoreBackup(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    this.message.set('');
    this.error.set('');

    if (!file) {
      return;
    }

    if (!window.confirm('Restore this backup and replace current projects, servers, agents, and settings?')) {
      return;
    }

    this.restoringBackup.set(true);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const backup = JSON.parse(String(reader.result || ''));
        this.api.restoreBackup(backup).subscribe({
          next: (result) => {
            this.store.loadServers();
            this.store.loadProjects();
            this.loadSettings();
            this.message.set(result.restartRecommended ? 'Backup restored. Restart the controller so restored pairing keys are active.' : 'Backup restored.');
            this.restoringBackup.set(false);
          },
          error: (error) => {
            this.error.set(error?.error?.error || 'Could not restore backup.');
            this.restoringBackup.set(false);
          },
        });
      } catch {
        this.error.set('Backup file is not valid JSON.');
        this.restoringBackup.set(false);
      }
    };
    reader.onerror = () => {
      this.error.set('Could not read backup file.');
      this.restoringBackup.set(false);
    };
    reader.readAsText(file);
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
