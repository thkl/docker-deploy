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
  infisicalSecretPath: string;
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

  testInfisicalConnection(projectRef: string, secretBindings: Array<{ name: string; path: string }>) {
    this.infisicalTestState.set('testing');
    this.infisicalTestMessage.set('Checking credentials and mapped secret access…');
    this.api.testInfisicalConnection({
      ...(projectRef ? { projectRef } : {}),
      infisical: this.infisicalPayload(),
      secretBindings,
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

  addInfisicalEnvironmentBindings(serviceId: number, secretBindings: Array<{ name: string; path: string }>) {
    let added = 0;
    let skipped = 0;
    this.resetInfisicalTest();
    this.builderServices.update((services) => services.map((service) => {
      if (service.id !== serviceId) return service;

      const secretEnvironment = [...service.secretEnvironment];
      const environmentKeys = new Set(service.environment.split(/\r?\n/).map((entry) => entry.split('=')[0]?.trim()).filter(Boolean));
      const seenReferences = new Set<string>();
      for (const binding of secretBindings) {
        const secretName = binding.name.trim();
        const infisicalSecretPath = binding.path.trim().startsWith('/') ? binding.path.trim() : `/${binding.path.trim()}`;
        if (!secretName) continue;
        const referenceId = JSON.stringify([infisicalSecretPath || '/', secretName]);
        if (seenReferences.has(referenceId)) continue;
        seenReferences.add(referenceId);
        if (environmentKeys.has(secretName) || secretEnvironment.some((secret) => secret.key.trim() === secretName)) {
          skipped += 1;
          continue;
        }
        secretEnvironment.push({
          key: secretName,
          value: '',
          mode: 'env',
          source: 'infisical',
          vaultSecretId: '',
          infisicalSecretName: secretName,
          infisicalSecretPath: infisicalSecretPath || '/',
          exposure: 'file'
        });
        added += 1;
      }
      return { ...service, secretEnvironment };
    }));
    return { added, skipped };
  }

  infisicalRuntimeBindings(serviceId: number) {
    const service = this.builderServices().find((candidate) => candidate.id === serviceId);
    return (service?.secretEnvironment ?? [])
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.source === 'infisical' && entry.mode === 'env');
  }

  secretEnvironmentBindings(service: ComposeBuilderService) {
    return service.secretEnvironment
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => !(entry.source === 'infisical' && entry.mode === 'env'));
  }

  updateInfisicalRuntimeBinding(serviceId: number, index: number, field: 'key' | 'infisicalSecretPath', event: Event) {
    const value = (event.target as HTMLInputElement).value;
    this.resetInfisicalTest();
    this.builderServices.update((services) => services.map((service) => {
      if (service.id !== serviceId) return service;
      const secretEnvironment = [...service.secretEnvironment];
      const entry = secretEnvironment[index];
      if (!entry || entry.source !== 'infisical' || entry.mode !== 'env') return service;
      secretEnvironment[index] = { ...entry, [field]: value };
      return { ...service, secretEnvironment };
    }));
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
        secretEnvironment: [...service.secretEnvironment, { key: 'SECRET_KEY', value: 'value', mode: 'docker_secret', source: 'inline', vaultSecretId: '', infisicalSecretName: '', infisicalSecretPath: '', exposure: 'file' }]
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
      const current = entries[index] ?? { key: '', value: '', mode: 'docker_secret' as const, source: 'inline' as const, vaultSecretId: '', infisicalSecretName: '', infisicalSecretPath: '', exposure: 'file' as const };
      const next = field === 'delivery'
        ? { ...current }
        : { ...current, [field]: target.value };
      if (field === 'source' && target.value === 'vault') {
        next.source = 'vault';
        next.mode = 'docker_secret';
        next.value = '';
        next.vaultSecretId = next.vaultSecretId || this.vaultSecrets()[0]?.id || '';
        next.infisicalSecretName = '';
        next.infisicalSecretPath = '';
      }
      if (field === 'source' && target.value === 'infisical') {
        next.source = 'infisical';
        next.mode = 'docker_secret';
        next.value = '';
        next.vaultSecretId = '';
        next.infisicalSecretPath = next.infisicalSecretPath || this.infisicalForm.controls.secretPath.value.trim() || '/';
      }
      if (field === 'source' && target.value === 'inline') {
        next.source = 'inline';
        next.vaultSecretId = '';
        next.infisicalSecretName = '';
        next.infisicalSecretPath = '';
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
        const qualifiedRef = parseQualifiedInfisicalSecretName(target.value);
        if (qualifiedRef) {
          next.infisicalSecretName = qualifiedRef.name;
          next.infisicalSecretPath = qualifiedRef.path;
        }
      }
      if (field === 'infisicalSecretPath') {
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
    return this.builderServices().reduce((count, service) => count + this.secretEnvironmentBindings(service).length, 0);
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

function parseQualifiedInfisicalSecretName(value: string) {
  const trimmed = value.trim();
  if (!trimmed.startsWith('/')) {
    return null;
  }

  const segments = trimmed.split('/').filter(Boolean);
  if (!segments.length) {
    return null;
  }

  return {
    name: segments[segments.length - 1],
    path: segments.length > 1 ? `/${segments.slice(0, -1).join('/')}` : '/',
  };
}
