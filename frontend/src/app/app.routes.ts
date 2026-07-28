import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    redirectTo: 'projects',
  },
  {
    path: 'projects',
    loadComponent: () =>
      import('./pages/projects-page/projects-page').then((m) => m.ProjectsPage),
  },
  {
    path: 'projects/new',
    loadComponent: () =>
      import('./pages/project-settings-page/project-settings-page').then((m) => m.ProjectSettingsPage),
  },
  {
    path: 'projects/:name/overview',
    loadComponent: () =>
      import('./pages/project-overview-page/project-overview-page').then((m) => m.ProjectOverviewPage),
  },
  {
    path: 'projects/:name/settings',
    loadComponent: () =>
      import('./pages/project-settings-page/project-settings-page').then((m) => m.ProjectSettingsPage),
  },
  {
    path: 'settings',
    loadComponent: () =>
      import('./pages/global-settings-page/global-settings-page').then((m) => m.GlobalSettingsPage),
  },
];
