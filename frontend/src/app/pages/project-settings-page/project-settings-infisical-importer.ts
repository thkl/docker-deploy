import { Component, inject, input, output, signal } from '@angular/core';
import { ProjectApi } from '../../services/project-api';
import { ProjectSettingsPageStore } from './project-settings-page.store';

interface InfisicalImportBinding {
  id: string;
  name: string;
  path: string;
}

@Component({
  selector: 'app-project-settings-infisical-importer',
  templateUrl: './project-settings-infisical-importer.html',
  styleUrl: './project-settings-page.scss',
})
export class ProjectSettingsInfisicalImporter {
  protected readonly state = inject(ProjectSettingsPageStore);
  private readonly api = inject(ProjectApi);
  readonly serviceId = input.required<number>();
  readonly projectRef = input('');
  readonly configureInfisical = output<void>();
  protected readonly importPath = signal('');
  protected readonly secretNames = signal<InfisicalImportBinding[]>([]);
  protected readonly selectedSecretIds = signal<string[]>([]);
  protected readonly loading = signal(false);
  protected readonly importError = signal('');
  protected readonly importMessage = signal('');
  private readonly loadedScope = signal<string | null>(null);
  private requestId = 0;

  protected pathValue() {
    return this.importPath() || this.state.infisicalForm.controls.secretPath.value || '/';
  }

  protected loadSecretNames() {
    this.importError.set('');
    this.importMessage.set('');
    this.secretNames.set([]);
    this.selectedSecretIds.set([]);
    if (!this.state.infisicalReady()) {
      this.importError.set('Complete the Infisical connection settings first.');
      return;
    }
    if (!this.state.builderServices().some((service) => service.id === this.serviceId())) {
      this.importError.set('This service is no longer available.');
      return;
    }

    const paths = [...new Set(this.pathValue().split(/[\r\n,]+/).map((path) => path.trim()).filter(Boolean))];
    if (!paths.length) paths.push(this.state.infisicalForm.controls.secretPath.value.trim() || '/');
    this.importPath.set(paths.join('\n'));
    const requestId = ++this.requestId;
    const requestSettings = this.state.infisicalPayload();
    const requestProjectRef = this.projectRef();
    this.loading.set(true);
    this.api.listInfisicalSecretNames({
      ...(requestProjectRef ? { projectRef: requestProjectRef } : {}),
      infisical: requestSettings,
      paths
    }).subscribe({
      next: (result) => {
        if (requestId !== this.requestId) return;
        this.importPath.set(result.paths.join('\n'));
        this.loadedScope.set(this.scope(result.paths, requestSettings, requestProjectRef));
        this.secretNames.set(result.secretNames.map((secret) => ({
          ...secret,
          id: JSON.stringify([secret.path, secret.name])
        })));
        if (!result.secretNames.length) {
          this.importMessage.set(`No secret names found in ${result.paths.join(', ')}.`);
        }
        this.loading.set(false);
      },
      error: (error) => {
        if (requestId !== this.requestId) return;
        this.importError.set(error?.error?.error || 'Could not load Infisical secret names.');
        this.loading.set(false);
      }
    });
  }

  protected updatePath(event: Event) {
    this.requestId += 1;
    this.loading.set(false);
    this.importPath.set((event.target as HTMLInputElement | HTMLTextAreaElement).value);
    this.secretNames.set([]);
    this.selectedSecretIds.set([]);
    this.loadedScope.set(null);
    this.importMessage.set('');
  }

  protected toggleSelection(secretId: string, event: Event) {
    const checked = (event.target as HTMLInputElement).checked;
    this.selectedSecretIds.update((ids) => checked
      ? [...new Set([...ids, secretId])]
      : ids.filter((id) => id !== secretId));
  }

  protected selectAll(event: Event) {
    this.selectedSecretIds.set((event.target as HTMLInputElement).checked ? this.secretNames().map((secret) => secret.id) : []);
  }

  protected addSelected() {
    const selectedIds = this.selectedSecretIds();
    if (!selectedIds.length) {
      this.importError.set('Select at least one variable to add.');
      return;
    }
    if (this.loadedScope() !== this.scope(this.currentPaths())) {
      this.importError.set('Infisical settings or paths changed. Load the variable names again before adding them.');
      return;
    }

    const bindings = this.secretNames()
      .filter((secret) => selectedIds.includes(secret.id))
      .map(({ name, path }) => ({ name, path }));
    const result = this.state.addInfisicalEnvironmentBindings(this.serviceId(), bindings);
    this.selectedSecretIds.set([]);
    this.importError.set('');
    this.importMessage.set(result.skipped
      ? `Added ${result.added}; skipped ${result.skipped} variable${result.skipped === 1 ? '' : 's'} already defined for this service.`
      : `Added ${result.added} runtime environment variable${result.added === 1 ? '' : 's'}.`);
  }

  private currentPaths() {
    return [...new Set(this.pathValue().split(/[\r\n,]+/).map((path) => path.trim()).filter(Boolean))];
  }

  private scope(paths: string[], settings = this.state.infisicalPayload(), projectRef = this.projectRef()) {
    return JSON.stringify([
      this.serviceId(),
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
