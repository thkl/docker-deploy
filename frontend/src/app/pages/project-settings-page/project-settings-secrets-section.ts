import { Component, inject, input, output, signal } from '@angular/core';
import { ReactiveFormsModule } from '@angular/forms';
import { ProjectApi } from '../../services/project-api';
import { ProjectSettingsPageStore } from './project-settings-page.store';

interface InfisicalImportBinding {
  id: string;
  name: string;
  path: string;
}

@Component({
  selector: 'app-project-settings-secrets-section',
  imports: [ReactiveFormsModule],
  templateUrl: './project-settings-secrets-section.html',
  styleUrl: './project-settings-page.scss',
})
export class ProjectSettingsSecretsSection {
  protected readonly state = inject(ProjectSettingsPageStore);
  private readonly api = inject(ProjectApi);
  readonly webhookEndpoint = input('');
  readonly projectRef = input('');
  readonly testConnection = output<void>();
  protected readonly infisicalImportPath = signal('');
  protected readonly infisicalImportServiceId = signal<number | null>(null);
  protected readonly infisicalImportSecretNames = signal<InfisicalImportBinding[]>([]);
  protected readonly selectedInfisicalImportNames = signal<string[]>([]);
  protected readonly infisicalImportLoading = signal(false);
  protected readonly infisicalImportError = signal('');
  protected readonly infisicalImportMessage = signal('');
  private readonly loadedInfisicalScope = signal<string | null>(null);
  private infisicalImportRequestId = 0;

  protected infisicalImportPathValue() {
    return this.infisicalImportPath() || this.state.infisicalForm.controls.secretPath.value || '/';
  }

  protected loadInfisicalSecretNames() {
    this.infisicalImportError.set('');
    this.infisicalImportMessage.set('');
    this.infisicalImportSecretNames.set([]);
    this.selectedInfisicalImportNames.set([]);
    if (!this.state.infisicalReady()) {
      this.infisicalImportError.set('Enable Infisical and complete its connection settings first.');
      return;
    }
    if (!this.state.builderServices().length) {
      this.infisicalImportError.set('Add a service before importing environment variables.');
      return;
    }

    const paths = [...new Set(this.infisicalImportPathValue().split(/[\r\n,]+/).map((path) => path.trim()).filter(Boolean))];
    if (!paths.length) paths.push(this.state.infisicalForm.controls.secretPath.value.trim() || '/');
    this.infisicalImportPath.set(paths.join('\n'));
    const requestId = ++this.infisicalImportRequestId;
    const requestSettings = this.state.infisicalPayload();
    const requestProjectRef = this.projectRef();
    this.infisicalImportLoading.set(true);
    this.api.listInfisicalSecretNames({
      ...(requestProjectRef ? { projectRef: requestProjectRef } : {}),
      infisical: requestSettings,
      paths
    }).subscribe({
      next: (result) => {
        if (requestId !== this.infisicalImportRequestId) return;
        this.infisicalImportPath.set(result.paths.join('\n'));
        this.loadedInfisicalScope.set(this.infisicalImportScope(result.paths, requestSettings, requestProjectRef));
        this.infisicalImportSecretNames.set(result.secretNames.map((secret) => ({
          ...secret,
          id: JSON.stringify([secret.path, secret.name])
        })));
        if (!result.secretNames.length) {
          this.infisicalImportMessage.set(`No secret names found in ${result.paths.join(', ')}.`);
        }
        this.infisicalImportLoading.set(false);
      },
      error: (error) => {
        if (requestId !== this.infisicalImportRequestId) return;
        this.infisicalImportError.set(error?.error?.error || 'Could not load Infisical secret names.');
        this.infisicalImportLoading.set(false);
      }
    });
  }

  protected updateInfisicalImportPath(event: Event) {
    this.infisicalImportRequestId += 1;
    this.infisicalImportLoading.set(false);
    this.infisicalImportPath.set((event.target as HTMLInputElement | HTMLTextAreaElement).value);
    this.infisicalImportSecretNames.set([]);
    this.selectedInfisicalImportNames.set([]);
    this.loadedInfisicalScope.set(null);
    this.infisicalImportMessage.set('');
  }

  protected setInfisicalImportService(event: Event) {
    const value = Number((event.target as HTMLSelectElement).value);
    this.infisicalImportServiceId.set(Number.isFinite(value) ? value : null);
  }

  protected toggleInfisicalImportSelection(secretId: string, event: Event) {
    const checked = (event.target as HTMLInputElement).checked;
    this.selectedInfisicalImportNames.update((names) => checked
      ? [...new Set([...names, secretId])]
      : names.filter((name) => name !== secretId));
  }

  protected selectAllInfisicalImportNames(event: Event) {
    const checked = (event.target as HTMLInputElement).checked;
    this.selectedInfisicalImportNames.set(checked ? this.infisicalImportSecretNames().map((secret) => secret.id) : []);
  }

  protected addSelectedInfisicalVariables() {
    const selectedIds = this.selectedInfisicalImportNames();
    if (!selectedIds.length) {
      this.infisicalImportError.set('Select at least one variable to add.');
      return;
    }
    const paths = this.currentInfisicalImportPaths();
    if (this.loadedInfisicalScope() !== this.infisicalImportScope(paths)) {
      this.infisicalImportError.set('Infisical settings or paths changed. Load the variable names again before adding them.');
      return;
    }

    const services = this.state.builderServices();
    const selectedServiceId = this.infisicalImportServiceId();
    const serviceId = selectedServiceId !== null && services.some((service) => service.id === selectedServiceId)
      ? selectedServiceId
      : services[0]?.id;
    if (serviceId === undefined) {
      this.infisicalImportError.set('Add a service before importing environment variables.');
      return;
    }

    const secretBindings = this.infisicalImportSecretNames()
      .filter((secret) => selectedIds.includes(secret.id))
      .map(({ name, path }) => ({ name, path }));
    const result = this.state.addInfisicalEnvironmentBindings(serviceId, secretBindings);
    this.selectedInfisicalImportNames.set([]);
    this.infisicalImportError.set('');
    this.infisicalImportMessage.set(result.skipped
      ? `Added ${result.added}; skipped ${result.skipped} variable${result.skipped === 1 ? '' : 's'} already defined for this service.`
      : `Added ${result.added} runtime environment variable${result.added === 1 ? '' : 's'}.`);
  }

  private currentInfisicalImportPaths() {
    return [...new Set(this.infisicalImportPathValue().split(/[\r\n,]+/).map((path) => path.trim()).filter(Boolean))];
  }

  private infisicalImportScope(paths: string[], settings = this.state.infisicalPayload(), projectRef = this.projectRef()) {
    return JSON.stringify([
      projectRef,
      settings.enabled,
      settings.siteUrl,
      settings.clientId,
      settings.projectId,
      settings.environment,
      settings.secretPath,
      paths
    ]);
  }
}
