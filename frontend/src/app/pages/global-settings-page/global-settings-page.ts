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
  protected readonly savingServer = signal(false);
  protected readonly pairingServer = signal('');
  protected readonly deletingServer = signal('');
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
  protected readonly serverForm = this.fb.group({
    id: ['', [Validators.required, Validators.pattern(/^[a-zA-Z0-9._-]+$/)]],
    name: ['', [Validators.required]],
    baseUrl: ['http://', [Validators.required]],
    agentPublicEncryptionKey: ['', [Validators.required]],
    agentPublicSigningKey: ['', [Validators.required]],
    pairingToken: ['', [Validators.required]],
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

  protected saveServer() {
    this.message.set('');
    this.error.set('');

    if (this.serverForm.invalid) {
      this.serverForm.markAllAsTouched();
      this.error.set('Complete the remote agent fields before saving.');
      return;
    }

    this.savingServer.set(true);
    this.api.createServer(this.serverForm.getRawValue()).subscribe({
      next: (server) => {
        this.serverForm.reset({
          id: '',
          name: '',
          baseUrl: 'http://',
          agentPublicEncryptionKey: '',
          agentPublicSigningKey: '',
          pairingToken: '',
        });
        this.store.loadServers();
        this.message.set(`Remote server ${server.name} saved. Pair it before assigning projects.`);
        this.savingServer.set(false);
      },
      error: (error) => {
        this.error.set(error?.error?.error || 'Could not save remote server.');
        this.savingServer.set(false);
      },
    });
  }

  protected deleteServer(serverId: string) {
    this.deletingServer.set(serverId);
    this.message.set('');
    this.error.set('');
    this.api.deleteServer(serverId).subscribe({
      next: () => {
        this.store.loadServers();
        this.message.set(`Remote agent ${serverId} removed.`);
        this.deletingServer.set('');
      },
      error: (error) => {
        this.error.set(error?.error?.error || 'Could not remove remote agent.');
        this.deletingServer.set('');
      },
    });
  }

  protected pairServer(serverId: string) {
    const pairingToken = this.serverForm.controls.pairingToken.value.trim();
    if (!pairingToken) {
      this.error.set('Enter the agent pairing token before pairing.');
      return;
    }

    this.pairingServer.set(serverId);
    this.message.set('');
    this.error.set('');
    this.api.pairServer(serverId, pairingToken).subscribe({
      next: (server) => {
        this.store.loadServers();
        this.message.set(`Remote server ${server.name} paired.`);
        this.pairingServer.set('');
      },
      error: (error) => {
        this.error.set(error?.error?.error || 'Could not pair remote server.');
        this.pairingServer.set('');
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
