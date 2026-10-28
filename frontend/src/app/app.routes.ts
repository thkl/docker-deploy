import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    redirectTo: 'containers',
  },
  {
    path: 'projects',
    loadComponent: () =>
      import('./pages/projects-page/projects-page').then((m) => m.ProjectsPage),
  },
  {
    path: 'login',
    loadComponent: () =>
      import('./pages/login-page/login-page').then((m) => m.LoginPage),
  },
  {
    path: 'projects/new/advanced',
    loadComponent: () =>
      import('./pages/project-settings-page/project-settings-page').then((m) => m.ProjectSettingsPage),
  },
  {
    path: 'projects/new',
    loadComponent: () =>
      import('./pages/project-setup-wizard-page/project-setup-wizard-page').then((m) => m.ProjectSetupWizardPage),
  },
  {
    path: 'projects/:name/overview',
    loadComponent: () =>
      import('./pages/project-overview-page/project-overview-page').then((m) => m.ProjectOverviewPage),
  },
  {
    path: 'projects/:name/compose',
    loadComponent: () =>
      import('./pages/project-overview-page/project-overview-page').then((m) => m.ProjectOverviewPage),
  },
  {
    path: 'projects/:name/deployments',
    loadComponent: () =>
      import('./pages/project-overview-page/project-overview-page').then((m) => m.ProjectOverviewPage),
  },
  {
    path: 'projects/:name/logs',
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
  {
    path: 'secrets',
    loadComponent: () =>
      import('./pages/secrets-page/secrets-page').then((m) => m.SecretsPage),
  },
  {
    path: 'servers',
    loadComponent: () =>
      import('./pages/servers-page/servers-page').then((m) => m.ServersPage),
  },
  {
    path: 'activity',
    loadComponent: () =>
      import('./pages/activity-page/activity-page').then((m) => m.ActivityPage),
  },
  {
    path: 'containers',
    loadComponent: () =>
      import('./pages/containers-page/containers-page').then((m) => m.ContainersPage),
  },
];
