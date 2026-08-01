import { Component, inject, OnInit, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { forkJoin } from 'rxjs';
import { ServerRecord } from '../../models/project';
import { ProjectApi } from '../../services/project-api';
import { ProjectStore } from '../../state/project-store';

const pairingTokenStorageKey = 'updater.agentPairingTokens';

@Component({
  selector: 'app-servers-page',
  imports: [ReactiveFormsModule],
  templateUrl: './servers-page.html',
  styleUrl: './servers-page.scss',
})
export class ServersPage implements OnInit {
  private readonly api = inject(ProjectApi);
  private readonly fb = inject(NonNullableFormBuilder);
  private readonly store = inject(ProjectStore);

  protected readonly savingServer = signal(false);
  protected readonly pairingServer = signal('');
  protected readonly refreshingServer = signal('');
  protected readonly deletingServer = signal('');
  protected readonly message = signal('');
  protected readonly error = signal('');
  protected readonly pairingTokens = signal<Record<string, string>>({});
  protected readonly servers = this.store.servers;
  protected readonly serverForm = this.fb.group({
    name: [''],
    baseUrl: ['http://', [Validators.required]],
    pairingToken: ['', [Validators.required]],
  });

  ngOnInit() {
    this.pairingTokens.set(readStoredPairingTokens());
    this.store.loadServers();
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
        this.error.set(error?.status === 409
          ? error?.error?.error || 'This remote agent is already registered.'
          : error?.error?.error || 'Could not save remote server.');
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
      return `Available · ${traefik.containerCount} container${traefik.containerCount === 1 ? '' : 's'}`;
    }

    return traefik.networkPresent ? 'Network exists, no container' : 'Not detected';
  }

  protected memoryLabel(server: ServerRecord) {
    const memory = server.capabilities?.system?.memory;
    if (!memory) {
      return 'Memory unknown';
    }

    return `${this.formatBytes(memory.usedBytes)} / ${this.formatBytes(memory.totalBytes)}`;
  }

  protected memoryPercent(server: ServerRecord) {
    const memory = server.capabilities?.system?.memory;
    return memory?.totalBytes ? Math.round((memory.usedBytes / memory.totalBytes) * 100) : 0;
  }

  protected diskLabel(server: ServerRecord) {
    const disk = server.capabilities?.system?.disk;
    if (!disk) {
      return 'Disk unknown';
    }

    return `${this.formatBytes(disk.usedBytes)} / ${this.formatBytes(disk.totalBytes)}`;
  }

  protected diskPercent(server: ServerRecord) {
    return Math.round(server.capabilities?.system?.disk?.usedPercent ?? 0);
  }

  protected loadLabel(server: ServerRecord) {
    const system = server.capabilities?.system;
    if (!system) {
      return 'Load unknown';
    }

    const load = system.loadAverage[0] ?? 0;
    return `${load.toFixed(2)} on ${system.cpuCount} CPU${system.cpuCount === 1 ? '' : 's'}`;
  }

  protected loadPercent(server: ServerRecord) {
    const system = server.capabilities?.system;
    if (!system?.cpuCount) {
      return 0;
    }

    return Math.min(100, Math.round(((system.loadAverage[0] ?? 0) / system.cpuCount) * 100));
  }

  protected metricCheckedAt(server: ServerRecord) {
    return this.formatDate(server.capabilities?.system?.checkedAt);
  }

  protected statusTone(server: ServerRecord) {
    return server.status === 'online'
      ? 'online'
      : server.status === 'unpaired'
        ? 'unpaired'
        : 'offline';
  }

  private formatBytes(value: number) {
    if (!Number.isFinite(value)) {
      return 'unknown';
    }

    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let current = value;
    let unit = 0;
    while (current >= 1024 && unit < units.length - 1) {
      current /= 1024;
      unit += 1;
    }

    return `${current >= 10 || unit === 0 ? current.toFixed(0) : current.toFixed(1)} ${units[unit]}`;
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
}

function readStoredPairingTokens(): Record<string, string> {
  try {
    return JSON.parse(sessionStorage.getItem(pairingTokenStorageKey) || '{}') as Record<string, string>;
  } catch {
    return {};
  }
}
