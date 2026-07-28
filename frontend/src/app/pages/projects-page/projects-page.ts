import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ProjectApi } from '../../services/project-api';
import { ProjectStore } from '../../state/project-store';

@Component({
  selector: 'app-projects-page',
  imports: [RouterLink],
  templateUrl: './projects-page.html',
  styleUrl: './projects-page.scss',
})
export class ProjectsPage {
  protected readonly store = inject(ProjectStore);
  private readonly api = inject(ProjectApi);
  protected readonly deploying = signal('');
  protected readonly message = signal('');

  deploy(name: string) {
    this.deploying.set(name);
    this.message.set(`Deploying ${name}...`);

    this.api.deployProject(name).subscribe({
      next: () => {
        this.message.set(`Deployment started for ${name}.`);
        this.deploying.set('');
      },
      error: () => {
        this.message.set(`Could not start deployment for ${name}.`);
        this.deploying.set('');
      },
    });
  }
}

