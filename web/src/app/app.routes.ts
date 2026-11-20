import { Routes } from '@angular/router';
import { platformGuard, signedInGuard } from './core/session';

export const routes: Routes = [
  { path: 'sign-in', loadComponent: () => import('./pages/sign-in.page').then((m) => m.SignInPage) },
  { path: 'organisations', loadComponent: () => import('./pages/organisations.page').then((m) => m.OrganisationsPage) },
  { path: 'platform', canActivate: [platformGuard], loadComponent: () => import('./pages/platform.page').then((m) => m.PlatformPage) },
  {
    path: '',
    canActivate: [signedInGuard],
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'workspaces' },
      { path: 'workspaces', loadComponent: () => import('./pages/workspaces.page').then((m) => m.WorkspacesPage) },
      { path: 'projects/:projectId', loadComponent: () => import('./pages/project.page').then((m) => m.ProjectPage) },
      { path: 'runs/:executionId', loadComponent: () => import('./pages/run.page').then((m) => m.RunPage) },
      { path: 'projects/:projectId/new-case', loadComponent: () => import('./pages/case-builder.page').then((m) => m.CaseBuilderPage) },
      { path: 'projects/:projectId/cases/:caseKey', loadComponent: () => import('./pages/case-builder.page').then((m) => m.CaseBuilderPage) },
      { path: 'projects/:projectId/new-flow', loadComponent: () => import('./pages/flow-edit.page').then((m) => m.FlowEditPage) },
      { path: 'projects/:projectId/flows/:flowKey/edit', loadComponent: () => import('./pages/flow-edit.page').then((m) => m.FlowEditPage) },
      { path: 'projects/:projectId/new-page', loadComponent: () => import('./pages/page-edit.page').then((m) => m.PageEditPage) },
      { path: 'projects/:projectId/pages/:pageKey/edit', loadComponent: () => import('./pages/page-edit.page').then((m) => m.PageEditPage) },
      { path: 'projects/:projectId/pages/:pageKey', loadComponent: () => import('./pages/page-detail.page').then((m) => m.PageDetailPage) },
      { path: 'change-sets/:changeSetId', loadComponent: () => import('./pages/change-set.page').then((m) => m.ChangeSetPage) },
      { path: 'compare', loadComponent: () => import('./pages/compare.page').then((m) => m.ComparePage) },
      { path: 'members', loadComponent: () => import('./pages/members.page').then((m) => m.MembersPage) },
      { path: 'audit', loadComponent: () => import('./pages/audit.page').then((m) => m.AuditPage) },
      { path: 'dashboard', loadComponent: () => import('./pages/dashboard.page').then((m) => m.DashboardPage) },
      { path: 'notifications', loadComponent: () => import('./pages/notifications.page').then((m) => m.NotificationsPage) },
      { path: 'organisation-settings', loadComponent: () => import('./pages/organization-settings.page').then((m) => m.OrganizationSettingsPage) },
      { path: 'branding', loadComponent: () => import('./pages/branding.page').then((m) => m.BrandingPage) },
      { path: 'ci-tokens', loadComponent: () => import('./pages/ci-tokens.page').then((m) => m.CiTokensPage) },
      { path: 'integrations', loadComponent: () => import('./pages/integrations.page').then((m) => m.IntegrationsPage) },
      { path: 'agents', loadComponent: () => import('./pages/agents.page').then((m) => m.AgentsPage) },
    ],
  },
  { path: '**', redirectTo: '' },
];
