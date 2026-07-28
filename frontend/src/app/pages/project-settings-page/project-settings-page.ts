import { Component, computed, effect, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { GlobalSettings, ProjectPayload, ProjectSummary } from '../../models/project';
import { ProjectApi } from '../../services/project-api';
import { ProjectStore } from '../../state/project-store';

@Component({
  selector: 'app-project-settings-page',
  imports: [ReactiveFormsModule],
  templateUrl: './project-settings-page.html',
  styleUrl: './project-settings-page.scss',
})
export class ProjectSettingsPage implements OnInit {
  protected readonly store = inject(ProjectStore);
  private readonly api = inject(ProjectApi);
  private readonly fb = inject(NonNullableFormBuilder);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly isNew = signal(true);
  protected readonly currentName = signal('');
  protected readonly saving = signal<'save' | 'deploy' | ''>('');
  protected readonly message = signal('');
  protected readonly error = signal('');
  protected readonly traefikEnabled = signal(false);
  protected readonly wildcardCertificate = signal(false);
  protected readonly title = computed(() => (this.isNew() ? 'New project' : `Settings for ${this.currentName()}`));
  protected readonly submitLabel = computed(() => (this.isNew() ? 'Create project' : 'Save'));
  private readonly globalDefaults = signal<GlobalSettings>({
    dataRoot: '/root/docker-apps',
    defaultTraefikNetwork: 'proxy',
    defaultTraefikEntryPoints: 'websecure',
    defaultTraefikCertResolver: 'letsencrypt',
    sshKeyPath: '~/.ssh',
    cleanupAfterDeploy: false,
  });

  protected readonly form = this.fb.group({
    name: ['', [Validators.required, Validators.pattern(/^[a-zA-Z0-9._-]+$/)]],
    repositoryUrl: [''],
    token: [''],
    deployToken: [''],
    path: [''],
    composeOverride: [''],
    traefikEnabled: [false],
    traefikHostname: [''],
    traefikService: [''],
    traefikPort: ['3000'],
    traefikEntryPoints: ['websecure'],
    traefikCertResolver: ['letsencrypt'],
    traefikNetwork: ['proxy'],
    traefikWildcardCertificate: [false],
    traefikWildcardDomain: [''],
    traefikWebsocket: [false],
    traefikRemovePublishedPorts: [true],
  });

  private patchedProjectName = '';

  constructor() {
    this.form.controls.traefikEnabled.valueChanges.pipe(takeUntilDestroyed()).subscribe((enabled) => {
      this.traefikEnabled.set(enabled);
    });
    this.form.controls.traefikWildcardCertificate.valueChanges.pipe(takeUntilDestroyed()).subscribe((enabled) => {
      this.wildcardCertificate.set(enabled);
    });

    effect(() => {
      if (this.isNew()) {
        return;
      }

      const project = this.store.selectedProject();
      if (project?.name === this.currentName() && this.patchedProjectName !== project.name) {
        this.patchFromProject(project);
      }
    });
  }

  ngOnInit() {
    this.api.getGlobalSettings().subscribe({
      next: (settings) => {
        this.globalDefaults.set(settings);
        if (this.isNew()) {
          this.resetForNewProject();
        }
      },
    });

    this.route.paramMap.subscribe((params) => {
      const name = params.get('name');

      this.message.set('');
      this.error.set('');

      if (!name) {
        this.isNew.set(true);
        this.currentName.set('');
        this.store.selectProject('');
        this.resetForNewProject();
        return;
      }

      this.isNew.set(false);
      this.currentName.set(name);
      this.store.selectProject(name);
      this.patchedProjectName = '';
    });
  }

  protected async save(mode: 'save' | 'deploy') {
    this.message.set('');
    this.error.set('');

    if (this.form.invalid) {
      this.form.markAllAsTouched();
      this.error.set('Repository name is required and can only use letters, numbers, dots, underscores, and hyphens.');
      return;
    }

    if (this.isNew() && !this.form.controls.token.value.trim()) {
      this.error.set('Webhook secret token is required for new projects.');
      return;
    }

    this.saving.set(mode);

    try {
      const payload = this.toPayload();
      const result = this.isNew()
        ? await firstValueFrom(this.api.createProject(payload))
        : await firstValueFrom(this.api.updateProject(this.currentName(), payload));
      const savedName = result.name || payload.name;

      this.store.selectProject(savedName);
      this.store.loadProjects();

      if (mode === 'deploy') {
        this.message.set(`Saving ${savedName} and starting deployment...`);
        await firstValueFrom(this.api.deployProject(savedName));
      }

      await this.router.navigate(['/projects', savedName, 'overview']);
    } catch (error) {
      this.error.set(this.readApiError(error));
    } finally {
      this.saving.set('');
    }
  }

  protected cancel() {
    const name = this.currentName();
    void this.router.navigate(name ? ['/projects', name, 'overview'] : ['/projects']);
  }

  private resetForNewProject() {
    this.patchedProjectName = '';
    this.traefikEnabled.set(false);
    this.wildcardCertificate.set(false);
    this.form.reset({
      name: '',
      repositoryUrl: '',
      token: '',
      deployToken: '',
      path: '',
      composeOverride: '',
      traefikEnabled: false,
      traefikHostname: '',
      traefikService: '',
      traefikPort: '3000',
      traefikEntryPoints: this.globalDefaults().defaultTraefikEntryPoints,
      traefikCertResolver: this.globalDefaults().defaultTraefikCertResolver,
      traefikNetwork: this.globalDefaults().defaultTraefikNetwork,
      traefikWildcardCertificate: false,
      traefikWildcardDomain: '',
      traefikWebsocket: false,
      traefikRemovePublishedPorts: true,
    });
  }

  private patchFromProject(project: ProjectSummary) {
    const traefik = project.traefik ?? { enabled: false };
    this.patchedProjectName = project.name;
    this.traefikEnabled.set(Boolean(traefik.enabled));
    this.wildcardCertificate.set(Boolean(traefik.wildcardCertificate));
    this.form.reset({
      name: project.name,
      repositoryUrl: project.repositoryUrl ?? '',
      token: '',
      deployToken: '',
      path: project.path ?? '',
      composeOverride: project.composeOverride ?? '',
      traefikEnabled: Boolean(traefik.enabled),
      traefikHostname: traefik.hostname ?? '',
      traefikService: traefik.service ?? '',
      traefikPort: traefik.port ? String(traefik.port) : '3000',
      traefikEntryPoints: traefik.entryPoints ?? this.globalDefaults().defaultTraefikEntryPoints,
      traefikCertResolver: traefik.certResolver ?? this.globalDefaults().defaultTraefikCertResolver,
      traefikNetwork: traefik.network ?? this.globalDefaults().defaultTraefikNetwork,
      traefikWildcardCertificate: Boolean(traefik.wildcardCertificate),
      traefikWildcardDomain: traefik.wildcardDomain ?? '',
      traefikWebsocket: Boolean(traefik.websocket),
      traefikRemovePublishedPorts: traefik.removePublishedPorts !== false,
    });
  }

  private toPayload(): ProjectPayload {
    const value = this.form.getRawValue();

    return {
      name: value.name.trim(),
      repositoryUrl: value.repositoryUrl.trim(),
      token: value.token.trim(),
      deployToken: value.deployToken.trim(),
      path: value.path.trim(),
      composeOverride: value.composeOverride.trim(),
      traefikEnabled: value.traefikEnabled,
      traefikHostname: value.traefikHostname.trim(),
      traefikService: value.traefikService.trim(),
      traefikPort: value.traefikPort.trim(),
      traefikEntryPoints: value.traefikEntryPoints.trim(),
      traefikCertResolver: value.traefikCertResolver.trim(),
      traefikNetwork: value.traefikNetwork.trim(),
      traefikWildcardCertificate: value.traefikWildcardCertificate,
      traefikWildcardDomain: value.traefikWildcardDomain.trim(),
      traefikWebsocket: value.traefikWebsocket,
      traefikRemovePublishedPorts: value.traefikRemovePublishedPorts,
    };
  }

  private readApiError(error: unknown) {
    const apiError = (error as { error?: { error?: string } }).error?.error;
    return apiError || 'Could not save project.';
  }
}
