import { Component, inject, OnInit, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { VaultSecret } from '../../models/project';
import { ProjectApi } from '../../services/project-api';

@Component({
  selector: 'app-secrets-page',
  imports: [ReactiveFormsModule],
  templateUrl: './secrets-page.html',
  styleUrl: './secrets-page.scss',
})
export class SecretsPage implements OnInit {
  private readonly api = inject(ProjectApi);
  private readonly fb = inject(NonNullableFormBuilder);

  protected readonly secrets = signal<VaultSecret[]>([]);
  protected readonly loading = signal(false);
  protected readonly saving = signal(false);
  protected readonly deleting = signal('');
  protected readonly editingId = signal('');
  protected readonly message = signal('');
  protected readonly error = signal('');
  protected readonly form = this.fb.group({
    namespace: ['default', [Validators.required]],
    key: ['', [Validators.required]],
    description: [''],
    value: ['', [Validators.required]],
  });

  ngOnInit() {
    this.loadSecrets();
  }

  protected save() {
    this.message.set('');
    this.error.set('');

    if (this.form.invalid) {
      this.form.markAllAsTouched();
      this.error.set('Namespace, key, and value are required for new secrets.');
      return;
    }

    const payload = this.form.getRawValue();
    const editingId = this.editingId();
    this.saving.set(true);
    const request = editingId
      ? this.api.updateVaultSecret(editingId, {
          namespace: payload.namespace,
          key: payload.key,
          description: payload.description,
          ...(payload.value.trim() ? { value: payload.value } : {}),
        })
      : this.api.createVaultSecret(payload);

    request.subscribe({
      next: (secret) => {
        this.message.set(editingId ? `${secret.namespace}/${secret.key} updated.` : `${secret.namespace}/${secret.key} created.`);
        this.cancelEdit();
        this.loadSecrets();
        this.saving.set(false);
      },
      error: (error) => {
        this.error.set(error?.error?.error || 'Could not save secret.');
        this.saving.set(false);
      },
    });
  }

  protected startEdit(secret: VaultSecret) {
    this.editingId.set(secret.id);
    this.message.set('');
    this.error.set('');
    this.form.reset({
      namespace: secret.namespace,
      key: secret.key,
      description: secret.description ?? '',
      value: '',
    });
    this.form.controls.value.clearValidators();
    this.form.controls.value.updateValueAndValidity();
  }

  protected cancelEdit() {
    this.editingId.set('');
    this.form.reset({
      namespace: 'default',
      key: '',
      description: '',
      value: '',
    });
    this.form.controls.value.setValidators([Validators.required]);
    this.form.controls.value.updateValueAndValidity();
  }

  protected deleteSecret(secret: VaultSecret) {
    if (!window.confirm(`Delete ${secret.namespace}/${secret.key}?`)) {
      return;
    }

    this.deleting.set(secret.id);
    this.message.set('');
    this.error.set('');
    this.api.deleteVaultSecret(secret.id).subscribe({
      next: () => {
        this.message.set(`${secret.namespace}/${secret.key} deleted.`);
        this.loadSecrets();
        this.deleting.set('');
      },
      error: (error) => {
        this.error.set(error?.error?.error || 'Could not delete secret.');
        this.deleting.set('');
      },
    });
  }

  protected referenceLabel(secret: VaultSecret) {
    const refs = secret.referencedByProjects ?? [];
    return refs.length ? refs.join(', ') : 'Unused';
  }

  protected formatDate(value: string) {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date(value));
  }

  private loadSecrets() {
    this.loading.set(true);
    this.api.listVaultSecrets().subscribe({
      next: (secrets) => {
        this.secrets.set(secrets);
        this.loading.set(false);
      },
      error: (error) => {
        this.error.set(error?.error?.error || 'Could not load secrets.');
        this.loading.set(false);
      },
    });
  }
}
