import { Component, inject } from '@angular/core';
import { ReactiveFormsModule } from '@angular/forms';
import { ProjectSettingsPageStore } from './project-settings-page.store';

@Component({
  selector: 'app-project-settings-secrets-section',
  imports: [ReactiveFormsModule],
  templateUrl: './project-settings-secrets-section.html',
  styleUrl: './project-settings-page.scss',
})
export class ProjectSettingsSecretsSection {
  protected readonly state = inject(ProjectSettingsPageStore);
}
