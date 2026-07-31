import { Component, inject, OnInit, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { forkJoin } from 'rxjs';
import { ServerRecord } from '../../models/project';
import { ProjectApi } from '../../services/project-api';
import { ProjectStore } from '../../state/project-store';

const pairingTokenStorageKey = 'updater.agentPairingTokens';

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
  protected readonly refreshingServer = signal('');
  protected readonly deletingServer = signal('');
  protected readonly message = signal('');
  protected readonly error = signal('');
  protected readonly pairingTokens = signal<Record<string, string>>({});
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
    name: [''],
    baseUrl: ['http://', [Validators.required]],
    pairingToken: ['', [Validators.required]],
  });

  ngOnInit() {
    this.pairingTokens.set(readStoredPairingTokens());
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
      this.error.set('Enter the agent URL and pairing token before saving.');
      return;
    }

    const payload = this.serverForm.getRawValue();
    this.savingServer.set(true);
    this.api.createServer(payload).subscribe({
      next: (server) => {
        this.storePairingToken(server.id, payload.pairingToken);
        this.serverForm.patchValue({
          name: server.name,
        });
        this.store.loadServers();
        this.message.set(`Remote server ${server.name} saved. Pairing token is loaded for this agent.`);
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
        this.removeStoredPairingToken(serverId);
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

  protected refreshServer(serverId: string) {
    this.refreshingServer.set(serverId);
    this.message.set('');
    this.error.set('');

    this.api.refreshServerHealth(serverId).subscribe({
      next: (server) => {
        this.store.loadServers();
        this.message.set(`${server.name} health refreshed.`);
        this.refreshingServer.set('');
      },
      error: (error) => {
        this.error.set(error?.error?.error || 'Could not refresh agent health.');
        this.refreshingServer.set('');
      },
    });
  }

  protected refreshAllServers() {
    const servers = this.servers();
    if (!servers.length) {
      return;
    }

    this.refreshingServer.set('all');
    this.message.set('');
    this.error.set('');

    forkJoin(servers.map((server) => this.api.refreshServerHealth(server.id))).subscribe({
      next: () => {
        this.store.loadServers();
        this.message.set('Agent health refreshed.');
        this.refreshingServer.set('');
      },
      error: (error) => {
        this.error.set(error?.error?.error || 'Could not refresh agent health.');
        this.refreshingServer.set('');
      },
    });
  }

  protected formatDate(value?: string) {
    if (!value) {
      return 'Never';
    }

    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date(value));
  }

  protected activeJobLabel(server: ServerRecord) {
    const count = server.activeJobs?.length ?? 0;
    return count === 1 ? '1 active job' : `${count} active jobs`;
  }

  protected traefikLabel(server: ServerRecord) {
    const traefik = server.capabilities?.traefik;
    if (!traefik) {
      return 'Traefik unknown';
    }

    if (traefik.available) {
      return `Traefik available · ${traefik.containerCount} containers`;
    }

    return traefik.networkPresent ? 'Traefik network only' : 'Traefik unavailable';
  }

  protected pairServer(serverId: string) {
    const pairingToken = this.pairingTokens()[serverId] || this.serverForm.controls.pairingToken.value.trim();
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
        this.removeStoredPairingToken(server.id);
        this.serverForm.reset({
          name: '',
          baseUrl: 'http://',
          pairingToken: '',
        });
        this.pairingServer.set('');
      },
      error: (error) => {
        this.error.set(error?.error?.error || 'Could not pair remote server.');
        this.pairingServer.set('');
      },
    });
  }

  private storePairingToken(serverId: string, pairingToken: string) {
    if (!pairingToken) {
      return;
    }

    this.pairingTokens.update((tokens) => {
      const next = { ...tokens, [serverId]: pairingToken };
      sessionStorage.setItem(pairingTokenStorageKey, JSON.stringify(next));
      return next;
    });
  }

  private removeStoredPairingToken(serverId: string) {
    this.pairingTokens.update((tokens) => {
      const next = { ...tokens };
      delete next[serverId];
      sessionStorage.setItem(pairingTokenStorageKey, JSON.stringify(next));
      return next;
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

function readStoredPairingTokens(): Record<string, string> {
  try {
    return JSON.parse(sessionStorage.getItem(pairingTokenStorageKey) || '{}') as Record<string, string>;
  } catch {
    return {};
  }
}
