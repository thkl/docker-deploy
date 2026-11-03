import { Component, inject, input, output } from '@angular/core';
import { ReactiveFormsModule } from '@angular/forms';
import { ProjectSettingsPageStore } from './project-settings-page.store';

@Component({
  selector: 'app-project-settings-infisical-section',
  imports: [ReactiveFormsModule],
  templateUrl: './project-settings-infisical-section.html',
  styleUrl: './project-settings-page.scss',
})
export class ProjectSettingsInfisicalSection {
  protected readonly state = inject(ProjectSettingsPageStore);
  readonly webhookEndpoint = input('');
  readonly testConnection = output<void>();
}
