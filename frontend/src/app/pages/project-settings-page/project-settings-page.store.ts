import { computed, inject, Injectable, signal } from '@angular/core';
import { NonNullableFormBuilder, Validators } from '@angular/forms';
import {
  ProjectEnvironmentSecretExposure,
  ProjectEnvironmentSecretMode,
  ProjectEnvironmentSecretSource,
  ProjectInfisicalSettings,
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
  infisicalSecretName: string;
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
  readonly infisicalSecretConfigured = signal(false);
  readonly infisicalWebhookSecretConfigured = signal(false);
  readonly infisicalTestState = signal<'idle' | 'testing' | 'success' | 'error'>('idle');
  readonly infisicalTestMessage = signal('');
  readonly message = signal('');
  readonly error = signal('');
  readonly projectName = signal('');
  readonly projectSecretNamespace = computed(() => this.projectName().trim() || 'project');

  readonly vaultSecretForm = this.fb.group({
    key: ['', [Validators.required]],
    description: [''],
    value: ['', [Validators.required]],
  });

  readonly infisicalForm = this.fb.group({
    enabled: [false],
    siteUrl: ['https://app.infisical.com'],
    clientId: [''],
    clientSecret: [''],
    projectId: [''],
    environment: ['prod'],
    secretPath: ['/'],
    deployOnSecretChange: [false],
    webhookSecret: [''],
  });

  constructor() {
    this.infisicalForm.valueChanges.subscribe(() => this.resetInfisicalTest());
    this.infisicalForm.controls.enabled.valueChanges.subscribe((enabled) => {
      if (!enabled && this.infisicalForm.controls.deployOnSecretChange.value) {
        this.infisicalForm.controls.deployOnSecretChange.setValue(false);
      }
    });
  }

  patchInfisical(settings?: Partial<ProjectInfisicalSettings>) {
    this.infisicalSecretConfigured.set(Boolean(settings?.hasClientSecret || settings?.clientSecret));
    this.infisicalWebhookSecretConfigured.set(Boolean(settings?.hasWebhookSecret || settings?.webhookSecret));
    this.infisicalForm.reset({
      enabled: Boolean(settings?.enabled),
      siteUrl: settings?.siteUrl || 'https://app.infisical.com',
      clientId: settings?.clientId ?? '',
      clientSecret: '',
      projectId: settings?.projectId ?? '',
      environment: settings?.environment || 'prod',
      secretPath: settings?.secretPath || '/',
      deployOnSecretChange: Boolean(settings?.deployOnSecretChange),
      webhookSecret: '',
    });
  }

  resetInfisical() {
    this.patchInfisical();
  }

  resetInfisicalTest() {
    this.infisicalTestState.set('idle');
    this.infisicalTestMessage.set('');
  }

  testInfisicalConnection(projectRef: string, secretNames: string[]) {
    this.infisicalTestState.set('testing');
    this.infisicalTestMessage.set('Checking credentials and mapped secret access…');
    this.api.testInfisicalConnection({
      ...(projectRef ? { projectRef } : {}),
      infisical: this.infisicalPayload(),
      secretNames,
    }).subscribe({
      next: (result) => {
        this.infisicalTestState.set('success');
        this.infisicalTestMessage.set(result.message);
      },
      error: (error) => {
        this.infisicalTestState.set('error');
        this.infisicalTestMessage.set(error?.error?.error || 'Could not verify Infisical settings.');
      },
    });
  }

  infisicalPayload(): ProjectInfisicalSettings {
    const value = this.infisicalForm.getRawValue();
    return {
      ...value,
      siteUrl: value.siteUrl.trim(),
      clientId: value.clientId.trim(),
      clientSecret: value.clientSecret.trim(),
      projectId: value.projectId.trim(),
      environment: value.environment.trim(),
      secretPath: value.secretPath.trim() || '/',
      deployOnSecretChange: value.deployOnSecretChange,
      webhookSecret: value.webhookSecret.trim(),
    };
  }

  infisicalWebhookReady() {
    const value = this.infisicalForm.getRawValue();
    return !value.deployOnSecretChange || Boolean(
      value.enabled && (value.webhookSecret.trim() || this.infisicalWebhookSecretConfigured())
    );
  }

  infisicalReady() {
    const value = this.infisicalForm.getRawValue();
    return value.enabled && Boolean(
      value.siteUrl.trim() &&
      value.clientId.trim() &&
      (value.clientSecret.trim() || this.infisicalSecretConfigured()) &&
      value.projectId.trim() &&
      value.environment.trim()
    );
  }

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
    this.resetInfisicalTest();
    this.builderServices.update((services) => services.map((service) => {
      if (service.id !== id) {
        return service;
      }

      return {
        ...service,
        secretEnvironment: [...service.secretEnvironment, { key: 'SECRET_KEY', value: 'value', mode: 'docker_secret', source: 'inline', vaultSecretId: '', infisicalSecretName: '', exposure: 'file' }]
      };
    }));
  }

  updateBuilderSecretEnvironmentEntry(id: number, index: number, field: keyof ComposeSecretEnvironmentEntry | 'delivery', event: Event) {
    this.resetInfisicalTest();
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    this.builderServices.update((services) => services.map((service) => {
      if (service.id !== id) {
        return service;
      }

      const entries = [...service.secretEnvironment];
      const current = entries[index] ?? { key: '', value: '', mode: 'docker_secret' as const, source: 'inline' as const, vaultSecretId: '', infisicalSecretName: '', exposure: 'file' as const };
      const next = field === 'delivery'
        ? { ...current }
        : { ...current, [field]: target.value };
      if (field === 'source' && target.value === 'vault') {
        next.source = 'vault';
        next.mode = 'docker_secret';
        next.value = '';
        next.vaultSecretId = next.vaultSecretId || this.vaultSecrets()[0]?.id || '';
        next.infisicalSecretName = '';
      }
      if (field === 'source' && target.value === 'infisical') {
        next.source = 'infisical';
        next.mode = 'docker_secret';
        next.value = '';
        next.vaultSecretId = '';
      }
      if (field === 'source' && target.value === 'inline') {
        next.source = 'inline';
        next.vaultSecretId = '';
        next.infisicalSecretName = '';
      }
      if (field === 'vaultSecretId') {
        next.source = 'vault';
        next.mode = 'docker_secret';
        next.value = '';
      }
      if (field === 'infisicalSecretName') {
        next.source = 'infisical';
        next.mode = 'docker_secret';
        next.value = '';
        next.vaultSecretId = '';
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
    this.resetInfisicalTest();
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
