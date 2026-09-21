import { computed, inject, Injectable, signal } from '@angular/core';
import { NonNullableFormBuilder, Validators } from '@angular/forms';
import {
  ProjectEnvironmentSecretExposure,
  ProjectEnvironmentSecretMode,
  ProjectEnvironmentSecretSource,
  VaultSecret
} from '../../models/project';
import { ProjectApi } from '../../services/project-api';

export type ComposeHealthcheckMode = '' | 'http' | 'command' | 'disabled';

export interface ComposeSecretEnvironmentEntry {
  key: string;
  value: string;
  mode: ProjectEnvironmentSecretMode;
  source: ProjectEnvironmentSecretSource;
  vaultSecretId: string;
  exposure: ProjectEnvironmentSecretExposure;
}

export interface ComposeBuilderService {
  id: number;
  name: string;
  image: string;
  build: string;
  dockerfile: string;
  buildTarget: string;
  containerName: string;
  user: string;
  command: string;
  restart: string;
  networkMode: string;
  init: boolean;
  healthcheckMode: ComposeHealthcheckMode;
  healthcheckHttpUrl: string;
  healthcheckCommand: string;
  healthcheckInterval: string;
  healthcheckTimeout: string;
  healthcheckRetries: string;
  healthcheckStartPeriod: string;
  healthcheckExtra: string;
  ports: string;
  expose: string;
  environment: string;
  secretEnvironment: ComposeSecretEnvironmentEntry[];
  secretHelperCommand: string;
  volumes: string;
  networks: string;
  dependsOn: string;
  dependsOnAdvanced: string;
  deployMode: string;
  deployReplicas: string;
  deployPlacementConstraints: string;
  deployAdvanced: string;
  deployLabels: string;
  profiles: string;
  extra: string;
}

@Injectable()
export class ProjectSettingsPageStore {
  private readonly api = inject(ProjectApi);
  private readonly fb = inject(NonNullableFormBuilder);

  readonly builderServices = signal<ComposeBuilderService[]>([]);
  readonly vaultSecrets = signal<VaultSecret[]>([]);
  readonly savingVaultSecret = signal(false);
  readonly deletingVaultSecret = signal('');
  readonly editingVaultSecretId = signal('');
  readonly message = signal('');
  readonly error = signal('');
  readonly projectName = signal('');
  readonly projectSecretNamespace = computed(() => this.projectName().trim() || 'project');

  readonly vaultSecretForm = this.fb.group({
    key: ['', [Validators.required]],
    description: [''],
    value: ['', [Validators.required]],
  });

  setProjectName(name: string) {
    this.projectName.set(name.trim());
  }

  loadVaultSecrets() {
    this.api.listVaultSecrets(this.projectSecretNamespace()).subscribe({
      next: (secrets) => this.vaultSecrets.set(secrets),
      error: () => this.error.set('Could not load Updater vault secrets.'),
    });
  }

  saveProjectVaultSecret() {
    this.message.set('');
    this.error.set('');

    if (this.vaultSecretForm.invalid) {
      this.vaultSecretForm.markAllAsTouched();
      this.error.set('Secret key and value are required.');
      return;
    }

    const payload = this.vaultSecretForm.getRawValue();
    const editingId = this.editingVaultSecretId();
    this.savingVaultSecret.set(true);
    const request = editingId
      ? this.api.updateVaultSecret(editingId, {
          namespace: this.projectSecretNamespace(),
          key: payload.key,
          description: payload.description,
          ...(payload.value.trim() ? { value: payload.value } : {}),
        })
      : this.api.createVaultSecret({
          namespace: this.projectSecretNamespace(),
          key: payload.key,
          description: payload.description,
          value: payload.value,
        });

    request.subscribe({
      next: (secret) => {
        this.message.set(`${secret.key} ${editingId ? 'updated' : 'created'}.`);
        this.cancelProjectVaultSecretEdit();
        this.loadVaultSecrets();
        this.savingVaultSecret.set(false);
      },
      error: (error) => {
        this.error.set(error?.error?.error || 'Could not save secret.');
        this.savingVaultSecret.set(false);
      },
    });
  }

  editProjectVaultSecret(secret: VaultSecret) {
    this.editingVaultSecretId.set(secret.id);
    this.message.set('');
    this.error.set('');
    this.vaultSecretForm.reset({
      key: secret.key,
      description: secret.description ?? '',
      value: '',
    });
    this.vaultSecretForm.controls.value.clearValidators();
    this.vaultSecretForm.controls.value.updateValueAndValidity();
  }

  cancelProjectVaultSecretEdit() {
    this.editingVaultSecretId.set('');
    this.vaultSecretForm.reset({
      key: '',
      description: '',
      value: '',
    });
    this.vaultSecretForm.controls.value.setValidators([Validators.required]);
    this.vaultSecretForm.controls.value.updateValueAndValidity();
  }

  deleteProjectVaultSecret(secret: VaultSecret) {
    if (!window.confirm(`Delete ${secret.key}?`)) {
      return;
    }

    this.deletingVaultSecret.set(secret.id);
    this.message.set('');
    this.error.set('');
    this.api.deleteVaultSecret(secret.id).subscribe({
      next: () => {
        this.message.set(`${secret.key} deleted.`);
        this.loadVaultSecrets();
        this.deletingVaultSecret.set('');
      },
      error: (error) => {
        this.error.set(error?.error?.error || 'Could not delete secret.');
        this.deletingVaultSecret.set('');
      },
    });
  }

  addBuilderSecretEnvironmentEntry(id: number) {
    this.builderServices.update((services) => services.map((service) => {
      if (service.id !== id) {
        return service;
      }

      return {
        ...service,
        secretEnvironment: [...service.secretEnvironment, { key: 'SECRET_KEY', value: 'value', mode: 'docker_secret', source: 'inline', vaultSecretId: '', exposure: 'file' }]
      };
    }));
  }

  updateBuilderSecretEnvironmentEntry(id: number, index: number, field: keyof ComposeSecretEnvironmentEntry | 'delivery', event: Event) {
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    this.builderServices.update((services) => services.map((service) => {
      if (service.id !== id) {
        return service;
      }

      const entries = [...service.secretEnvironment];
      const current = entries[index] ?? { key: '', value: '', mode: 'docker_secret' as const, source: 'inline' as const, vaultSecretId: '', exposure: 'file' as const };
      const next = field === 'delivery'
        ? { ...current }
        : { ...current, [field]: target.value };
      if (field === 'source' && target.value === 'vault') {
        next.source = 'vault';
        next.mode = 'docker_secret';
        next.value = '';
        next.vaultSecretId = next.vaultSecretId || this.vaultSecrets()[0]?.id || '';
      }
      if (field === 'source' && target.value === 'inline') {
        next.source = 'inline';
        next.vaultSecretId = '';
      }
      if (field === 'vaultSecretId') {
        next.source = 'vault';
        next.mode = 'docker_secret';
        next.value = '';
      }
      if (field === 'delivery') {
        if (target.value === 'env') {
          next.mode = 'env';
          next.exposure = 'file';
        } else {
          next.mode = 'docker_secret';
          next.exposure = target.value === 'helper' ? 'env' : 'file';
        }
      }
      if (next.source === 'vault') {
        next.mode = 'docker_secret';
      }
      entries[index] = next;
      return { ...service, secretEnvironment: entries };
    }));
  }

  removeBuilderSecretEnvironmentEntry(id: number, index: number) {
    this.builderServices.update((services) => services.map((service) => {
      if (service.id !== id) {
        return service;
      }

      const entries = [...service.secretEnvironment];
      entries.splice(index, 1);
      return { ...service, secretEnvironment: entries };
    }));
  }

  updateBuilderService(id: number, field: keyof ComposeBuilderService, event: Event) {
    const target = event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    this.builderServices.update((services) => services.map((service) => service.id === id ? { ...service, [field]: target.value } : service));
  }

  secretDeliveryValue(entry: ComposeSecretEnvironmentEntry) {
    if (entry.mode === 'env' && (entry.source || 'inline') !== 'vault') {
      return 'env';
    }
    return entry.exposure === 'env' ? 'helper' : 'file';
  }

  serviceHasSecretEnvHelper(service: ComposeBuilderService) {
    return service.secretEnvironment.some((secret) => secret.mode === 'docker_secret' && secret.exposure === 'env');
  }

  builderSecretCount() {
    return this.builderServices().reduce((count, service) => count + service.secretEnvironment.length, 0);
  }

  vaultSecretLabel(secret: VaultSecret) {
    return `${secret.namespace}/${secret.key}`;
  }

  vaultSecretExists(secretId: string) {
    return this.vaultSecrets().some((secret) => secret.id === secretId);
  }

  vaultSecretDescription(secretId: string) {
    const secret = this.vaultSecrets().find((candidate) => candidate.id === secretId);
    return secret?.description || (secret ? `${secret.namespace}/${secret.key}` : 'Select an Updater secret.');
  }

  vaultSecretReferenceLabel(secret: VaultSecret) {
    const refs = secret.referencedByProjects ?? [];
    return refs.length ? refs.join(', ') : 'Unused';
  }
}
