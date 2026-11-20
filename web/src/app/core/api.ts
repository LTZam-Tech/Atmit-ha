import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import type {
  Agent, AssetContent, AuditEntry, CaseSummary, ChangeSet, ChangeSetDetail, Comparison, CreatedAgent, Environment, Execution, ExecutionDetail,
  Artifact, Branding, Channel, CiToken, Coverage, Dashboard, ElementInfo, FeatureFlag, Findings, HealingReport, LoginSettings, OrgSetting, PageDetail, WorkflowDetail, WorkflowSummary, Delivery, FiledIssue, Integration, SaveChannel, SaveSchedule, Schedule, Suite, IntegrationCheck, Me, Member, PageSummary, PlatformOrganization, Problem, Project, PublishResult, Role, TestUser, TrendPoint, Workspace,
  Permission,
} from './models';

/** Typed client for the platform API v1 (platform/README.md). */
@Injectable({ providedIn: 'root' })
export class Api {
  private readonly http = inject(HttpClient);
  private readonly base = environment.apiBase;

  me(): Observable<Me> { return this.http.get<Me>(`${this.base}/me`); }

  workspaces(): Observable<Workspace[]> { return this.http.get<Workspace[]>(`${this.base}/workspaces`); }
  createWorkspace(body: { key: string; name: string }): Observable<Workspace> { return this.http.post<Workspace>(`${this.base}/workspaces`, body); }
  renameWorkspace(key: string, name: string): Observable<Workspace> { return this.http.patch<Workspace>(`${this.base}/workspaces/${encodeURIComponent(key)}`, { name }); }
  archiveWorkspace(key: string): Observable<void> { return this.http.delete<void>(`${this.base}/workspaces/${encodeURIComponent(key)}`); }
  platformOrganizations(): Observable<PlatformOrganization[]> { return this.http.get<PlatformOrganization[]>(`${this.base}/platform/organizations`); }
  createOrganization(body: { key: string; name: string; adminEmail: string; adminName?: string }): Observable<PlatformOrganization> {
    return this.http.post<PlatformOrganization>(`${this.base}/platform/organizations`, body);
  }
  updateOrganization(key: string, body: { name?: string; archived?: boolean }): Observable<void> {
    return this.http.patch<void>(`${this.base}/platform/organizations/${encodeURIComponent(key)}`, body);
  }

  projects(workspaceKey: string): Observable<Project[]> { return this.http.get<Project[]>(`${this.base}/workspaces/${encodeURIComponent(workspaceKey)}/projects`); }
  createProject(workspaceKey: string, body: Partial<Project> & { key: string; name: string }): Observable<Project> {
    return this.http.post<Project>(`${this.base}/workspaces/${encodeURIComponent(workspaceKey)}/projects`, body);
  }
  importProject(workspaceKey: string, snapshot: unknown): Observable<{ project: Project; pages: number; elements: number; cases: number; dataRows: number; workflows: number }> {
    return this.http.post<{ project: Project; pages: number; elements: number; cases: number; dataRows: number; workflows: number }>(
      `${this.base}/workspaces/${encodeURIComponent(workspaceKey)}/projects/import`, snapshot);
  }
  project(id: string): Observable<Project> { return this.http.get<Project>(`${this.base}/projects/${id}`); }
  updateProject(id: string, body: Partial<{ name: string; description: string | null; testIdAttribute: string; healingPolicy: string; languages: string[];
    run: { workers: number | null; retries: number | null; testTimeoutSeconds: number | null; waitTimeoutSeconds: number | null } }>): Observable<Project> {
    return this.http.patch<Project>(`${this.base}/projects/${id}`, body);
  }
  messages(projectId: string): Observable<Record<string, Record<string, string>>> { return this.http.get<Record<string, Record<string, string>>>(`${this.base}/projects/${projectId}/messages`); }
  putMessages(projectId: string, body: Record<string, Record<string, string>>): Observable<unknown> { return this.http.put(`${this.base}/projects/${projectId}/messages`, body); }
  login(projectId: string): Observable<LoginSettings> { return this.http.get<LoginSettings>(`${this.base}/projects/${projectId}/login`); }
  putLogin(projectId: string, body: LoginSettings): Observable<LoginSettings> { return this.http.put<LoginSettings>(`${this.base}/projects/${projectId}/login`, body); }
  deleteLogin(projectId: string): Observable<unknown> { return this.http.delete(`${this.base}/projects/${projectId}/login`); }

  environments(projectId: string): Observable<Environment[]> { return this.http.get<Environment[]>(`${this.base}/projects/${projectId}/environments`); }
  pages(projectId: string): Observable<PageSummary[]> { return this.http.get<PageSummary[]>(`${this.base}/projects/${projectId}/pages`); }
  cases(projectId: string): Observable<CaseSummary[]> { return this.http.get<CaseSummary[]>(`${this.base}/projects/${projectId}/cases`); }

  executions(projectId: string): Observable<Execution[]> { return this.http.get<Execution[]>(`${this.base}/projects/${projectId}/executions`); }
  startExecution(projectId: string, body: {
    environment?: string; engine?: string; selection?: { cases?: string[]; tags?: string[]; suite?: string; flows?: string[] }; locale?: string; healing?: string;
    kind?: 'run' | 'explore' | 'export'; explore?: { urls: string[]; as?: string | null }; shards?: number;
  }): Observable<Execution> {
    return this.http.post<Execution>(`${this.base}/projects/${projectId}/executions`, body);
  }
  execution(id: string): Observable<ExecutionDetail> { return this.http.get<ExecutionDetail>(`${this.base}/executions/${id}`); }
  cancelExecution(id: string): Observable<unknown> { return this.http.post(`${this.base}/executions/${id}/cancel`, {}); }

  putEnvironment(projectId: string, key: string, body: { baseUrl: string; isDefault?: boolean; startDemoApp?: boolean; ignoreHttpsErrors?: boolean; httpUsername?: string | null; httpPasswordSecretRef?: string | null }): Observable<Environment> {
    return this.http.put<Environment>(`${this.base}/projects/${projectId}/environments/${encodeURIComponent(key)}`, body);
  }
  deleteEnvironment(projectId: string, key: string): Observable<unknown> { return this.http.delete(`${this.base}/projects/${projectId}/environments/${encodeURIComponent(key)}`); }

  testUsers(projectId: string): Observable<TestUser[]> { return this.http.get<TestUser[]>(`${this.base}/projects/${projectId}/users`); }
  putTestUser(projectId: string, key: string, body: { username: string; description?: string | null; passwordSecretRef?: string | null }): Observable<TestUser> {
    return this.http.put<TestUser>(`${this.base}/projects/${projectId}/users/${encodeURIComponent(key)}`, body);
  }
  deleteTestUser(projectId: string, key: string): Observable<unknown> { return this.http.delete(`${this.base}/projects/${projectId}/users/${encodeURIComponent(key)}`); }

  roles(): Observable<Role[]> { return this.http.get<Role[]>(`${this.base}/roles`); }
  permissions(): Observable<Permission[]> { return this.http.get<Permission[]>(`${this.base}/permissions`); }
  createRole(body: { key: string; name: string; permissions: string[] }): Observable<Role> { return this.http.post<Role>(`${this.base}/roles`, body); }
  updateRole(key: string, body: { key: string; name: string; permissions: string[] }): Observable<Role> { return this.http.put<Role>(`${this.base}/roles/${encodeURIComponent(key)}`, body); }
  deleteRole(key: string): Observable<unknown> { return this.http.delete(`${this.base}/roles/${encodeURIComponent(key)}`); }
  members(): Observable<Member[]> { return this.http.get<Member[]>(`${this.base}/members`); }
  invite(body: { email: string; displayName?: string; role: string; workspace?: string | null }): Observable<Member> { return this.http.post<Member>(`${this.base}/members`, body); }
  changeRole(id: string, role: string): Observable<unknown> { return this.http.patch(`${this.base}/members/${id}`, { role }); }
  removeMember(id: string): Observable<unknown> { return this.http.delete(`${this.base}/members/${id}`); }

  trend(projectId: string, take = 30): Observable<TrendPoint[]> { return this.http.get<TrendPoint[]>(`${this.base}/projects/${projectId}/trend`, { params: { take } }); }
  compare(before: string, after: string): Observable<Comparison> { return this.http.get<Comparison>(`${this.base}/executions/compare`, { params: { before, after } }); }
  audit(filter: { resourceType?: string; action?: string; before?: number } = {}): Observable<AuditEntry[]> {
    const params: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(filter)) if (v !== undefined && v !== '') params[k] = v;
    return this.http.get<AuditEntry[]>(`${this.base}/audit`, { params });
  }

  flowContent(projectId: string, key: string): Observable<AssetContent> { return this.http.get<AssetContent>(`${this.base}/projects/${projectId}/flows/${encodeURIComponent(key)}/content`); }
  pageContent(projectId: string, key: string): Observable<AssetContent> { return this.http.get<AssetContent>(`${this.base}/projects/${projectId}/pages/${encodeURIComponent(key)}/content`); }
  caseContent(projectId: string, key: string): Observable<AssetContent> { return this.http.get<AssetContent>(`${this.base}/projects/${projectId}/cases/${encodeURIComponent(key)}`); }
  changeSets(projectId: string, status?: string): Observable<ChangeSet[]> {
    return this.http.get<ChangeSet[]>(`${this.base}/projects/${projectId}/change-sets`, status ? { params: { status } } : {});
  }
  submitChangeSet(projectId: string, body: { title: string; source?: 'central' | 'local'; items: { assetType: 'test_case' | 'page' | 'workflow'; key: string; baseVersion: number | null; content: unknown }[] }): Observable<ChangeSet> {
    return this.http.post<ChangeSet>(`${this.base}/projects/${projectId}/change-sets`, body);
  }
  changeSet(id: string): Observable<ChangeSetDetail> { return this.http.get<ChangeSetDetail>(`${this.base}/change-sets/${id}`); }
  approveChangeSet(id: string, note?: string): Observable<ChangeSet> { return this.http.post<ChangeSet>(`${this.base}/change-sets/${id}/approve`, { note }); }
  rejectChangeSet(id: string, note?: string): Observable<ChangeSet> { return this.http.post<ChangeSet>(`${this.base}/change-sets/${id}/reject`, { note }); }

  integrations(): Observable<Integration[]> { return this.http.get<Integration[]>(`${this.base}/integrations`); }
  createIntegration(body: { kind: 'jira' | 'azure_devops' | 'testrail'; name: string; config: object; credentialSecretRef?: string | null; enabled?: boolean }): Observable<Integration> {
    return this.http.post<Integration>(`${this.base}/integrations`, body);
  }
  updateIntegration(id: string, body: { kind: 'jira' | 'azure_devops' | 'testrail'; name?: string; config?: object; credentialSecretRef?: string | null; enabled?: boolean }): Observable<Integration> {
    return this.http.put<Integration>(`${this.base}/integrations/${id}`, body);
  }
  deleteIntegration(id: string): Observable<unknown> { return this.http.delete(`${this.base}/integrations/${id}`); }
  checkIntegration(id: string): Observable<IntegrationCheck> { return this.http.post<IntegrationCheck>(`${this.base}/integrations/${id}/check`, {}); }
  elements(projectId: string): Observable<ElementInfo[]> { return this.http.get<ElementInfo[]>(`${this.base}/projects/${projectId}/elements`); }
  flows(projectId: string): Observable<WorkflowSummary[]> { return this.http.get<WorkflowSummary[]>(`${this.base}/projects/${projectId}/flows`); }
  flow(projectId: string, key: string): Observable<WorkflowDetail> {
    return this.http.get<WorkflowDetail>(`${this.base}/projects/${projectId}/flows/${encodeURIComponent(key)}`);
  }
  pageDetail(projectId: string, key: string): Observable<PageDetail> {
    return this.http.get<PageDetail>(`${this.base}/projects/${projectId}/pages/${encodeURIComponent(key)}`);
  }
  branding(): Observable<Branding[]> { return this.http.get<Branding[]>(`${this.base}/branding`); }
  putBranding(key: string, body: Partial<Omit<Branding, 'key' | 'hasLogo' | 'projects'>>): Observable<Branding> {
    return this.http.put<Branding>(`${this.base}/branding/${encodeURIComponent(key)}`, body);
  }
  deleteBranding(key: string): Observable<unknown> { return this.http.delete(`${this.base}/branding/${encodeURIComponent(key)}`); }
  brandingLogo(key: string): Observable<Blob> { return this.http.get(`${this.base}/branding/${encodeURIComponent(key)}/logo`, { responseType: 'blob' }); }
  putBrandingLogo(key: string, file: File): Observable<unknown> {
    return this.http.put(`${this.base}/branding/${encodeURIComponent(key)}/logo`, file, { headers: { 'Content-Type': file.type } });
  }
  deleteBrandingLogo(key: string): Observable<unknown> { return this.http.delete(`${this.base}/branding/${encodeURIComponent(key)}/logo`); }
  projectBranding(projectId: string): Observable<{ profile: string | null }> { return this.http.get<{ profile: string | null }>(`${this.base}/projects/${projectId}/branding`); }
  setProjectBranding(projectId: string, profile: string | null): Observable<unknown> { return this.http.put(`${this.base}/projects/${projectId}/branding`, { profile }); }
  ciTokens(): Observable<CiToken[]> { return this.http.get<CiToken[]>(`${this.base}/ci-tokens`); }
  createCiToken(body: { name: string; projectId: string | null; scopes: string[]; expiresInDays: number | null }): Observable<{ token: CiToken; secret: string }> {
    return this.http.post<{ token: CiToken; secret: string }>(`${this.base}/ci-tokens`, body);
  }
  revokeCiToken(id: string): Observable<unknown> { return this.http.delete(`${this.base}/ci-tokens/${id}`); }
  dashboard(): Observable<Dashboard> { return this.http.get<Dashboard>(`${this.base}/dashboard`); }

  channels(): Observable<Channel[]> { return this.http.get<Channel[]>(`${this.base}/notification-channels`); }
  createChannel(body: SaveChannel): Observable<Channel> { return this.http.post<Channel>(`${this.base}/notification-channels`, body); }
  updateChannel(id: string, body: SaveChannel): Observable<Channel> { return this.http.put<Channel>(`${this.base}/notification-channels/${id}`, body); }
  deleteChannel(id: string): Observable<unknown> { return this.http.delete(`${this.base}/notification-channels/${id}`); }
  testChannel(id: string): Observable<{ ok: boolean; error: string | null }> { return this.http.post<{ ok: boolean; error: string | null }>(`${this.base}/notification-channels/${id}/test`, {}); }
  deliveries(id: string): Observable<Delivery[]> { return this.http.get<Delivery[]>(`${this.base}/notification-channels/${id}/deliveries`); }

  suites(projectId: string): Observable<Suite[]> { return this.http.get<Suite[]>(`${this.base}/projects/${projectId}/suites`); }
  putSuite(projectId: string, key: string, body: Omit<Suite, 'key'>): Observable<Suite> {
    return this.http.put<Suite>(`${this.base}/projects/${projectId}/suites/${encodeURIComponent(key)}`, body);
  }
  deleteSuite(projectId: string, key: string): Observable<unknown> { return this.http.delete(`${this.base}/projects/${projectId}/suites/${encodeURIComponent(key)}`); }
  schedules(projectId: string): Observable<Schedule[]> { return this.http.get<Schedule[]>(`${this.base}/projects/${projectId}/schedules`); }
  createSchedule(projectId: string, body: SaveSchedule): Observable<Schedule> { return this.http.post<Schedule>(`${this.base}/projects/${projectId}/schedules`, body); }
  updateSchedule(id: string, body: SaveSchedule): Observable<Schedule> { return this.http.put<Schedule>(`${this.base}/schedules/${id}`, body); }
  deleteSchedule(id: string): Observable<unknown> { return this.http.delete(`${this.base}/schedules/${id}`); }
  previewSchedule(cron: string, timeZone: string): Observable<string[]> { return this.http.post<string[]>(`${this.base}/schedules/preview`, { cron, timeZone }); }

  /** evidence needs the caller's credentials, so it is fetched as a blob rather than linked */
  evidence(id: string): Observable<Blob> { return this.http.get(`${this.base}/evidence/${id}`, { responseType: 'blob' }); }
  findings(executionId: string): Observable<Findings> { return this.http.get<Findings>(`${this.base}/executions/${executionId}/findings`); }
  artifacts(executionId: string): Observable<Artifact[]> { return this.http.get<Artifact[]>(`${this.base}/executions/${executionId}/artifacts`); }
  artifact(id: string): Observable<Blob> { return this.http.get(`${this.base}/artifacts/${id}`, { responseType: 'blob' }); }
  artifactZip(id: string): Observable<Blob> { return this.http.get(`${this.base}/artifacts/${id}/zip`, { responseType: 'blob' }); }
  resultsCsv(executionId: string): Observable<Blob> { return this.http.get(`${this.base}/executions/${executionId}/results.csv`, { responseType: 'blob' }); }
  coverage(projectId: string, days: number): Observable<Coverage> { return this.http.get<Coverage>(`${this.base}/projects/${projectId}/analytics/coverage`, { params: { days } }); }
  healing(projectId: string, days: number): Observable<HealingReport> { return this.http.get<HealingReport>(`${this.base}/projects/${projectId}/analytics/healing`, { params: { days } }); }
  orgSettings(): Observable<OrgSetting[]> { return this.http.get<OrgSetting[]>(`${this.base}/organization/settings`); }
  putOrgSetting(key: string, value: number | string | null): Observable<unknown> { return this.http.put(`${this.base}/organization/settings/${encodeURIComponent(key)}`, { value }); }
  featureFlags(): Observable<FeatureFlag[]> { return this.http.get<FeatureFlag[]>(`${this.base}/feature-flags`); }
  putFeatureFlag(key: string, enabled: boolean | null): Observable<unknown> { return this.http.put(`${this.base}/feature-flags/${encodeURIComponent(key)}`, { enabled }); }
  publishResults(executionId: string, integrationId: string): Observable<{ integration: string; runId: string; url: string; published: number; notLinked: number }> {
    return this.http.post<{ integration: string; runId: string; url: string; published: number; notLinked: number }>(`${this.base}/executions/${executionId}/publish`, { integrationId });
  }
  projectZip(projectId: string): Observable<Blob> { return this.http.get(`${this.base}/projects/${projectId}/download.zip`, { responseType: 'blob' }); }
  issues(executionId: string): Observable<FiledIssue[]> { return this.http.get<FiledIssue[]>(`${this.base}/executions/${executionId}/issues`); }
  publishIssues(executionId: string, integrationId: string, resultIds?: string[]): Observable<PublishResult> {
    return this.http.post<PublishResult>(`${this.base}/executions/${executionId}/issues`, { integrationId, resultIds });
  }

  agents(): Observable<Agent[]> { return this.http.get<Agent[]>(`${this.base}/agents`); }
  createAgent(body: { name: string; kind: string; engines: string[] }): Observable<CreatedAgent> { return this.http.post<CreatedAgent>(`${this.base}/agents`, body); }
  revokeAgent(id: string): Observable<unknown> { return this.http.delete(`${this.base}/agents/${id}`); }
  rotateAgentToken(id: string): Observable<CreatedAgent> { return this.http.post<CreatedAgent>(`${this.base}/agents/${id}/rotate-token`, {}); }
}

/** A readable message from a platform error (problem details), for the user's screen */
export function problemText(e: unknown): string {
  if (e instanceof HttpErrorResponse) {
    const p = e.error as Problem | null;
    const fields = p?.errors ? Object.entries(p.errors).map(([k, v]) => `${k}: ${v.join(' ')}`).join('\n') : '';
    return [p?.detail ?? p?.title ?? e.statusText, fields].filter(Boolean).join('\n') || `HTTP ${e.status}`;
  }
  return e instanceof Error ? e.message : String(e);
}
