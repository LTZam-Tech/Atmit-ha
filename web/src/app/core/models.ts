// Shapes of the platform API v1 (platform/src/Atimtha.Api).

export interface MyOrganization { key: string; name: string; roles: string[]; permissions?: string[] }
export interface Me { id: string; email: string; displayName: string; locale: 'en' | 'ar'; organizations: MyOrganization[]; platformAdmin?: boolean }

/** /api/v1/platform/organizations (platform administrators only) */
export interface PlatformOrganization { id: string; key: string; name: string; createdAt: string; archivedAt: string | null; workspaces: number; projects: number; members: number }

export interface Workspace { id: string; key: string; name: string; createdAt: string }

export interface RunSettings { workers: number | null; retries: number | null; testTimeoutSeconds: number | null; waitTimeoutSeconds: number | null }
export interface Project {
  id: string; workspaceId: string; key: string; name: string; description: string | null; testIdAttribute: string;
  languages: ('en' | 'ar')[]; healingPolicy: 'pass' | 'flag' | 'off'; run: RunSettings; createdAt: string; updatedAt: string;
}

export interface Environment { key: string; baseUrl: string; isDefault: boolean; startDemoApp: boolean; ignoreHttpsErrors: boolean; httpUsername: string | null; hasHttpPassword: boolean }

export interface PageSummary { key: string; url: string | null; openMode: 'url' | 'navigate'; elements: number; version: number }
export interface CaseSummary { key: string; title: string; module: string | null; engine: 'web' | 'api' | 'mobile' | 'performance' | 'mobile' | 'performance'; type: 'positive' | 'negative' | null; rows: number; steps: number; version: number }

export type ExecutionStatus = 'queued' | 'assigned' | 'running' | 'passed' | 'failed' | 'cancelled' | 'error';
export interface Counts { total?: number; passed?: number; failed?: number; flaky?: number; skipped?: number; healed?: number }
export interface Execution {
  id: string; projectId: string; environment: string; engine: 'web' | 'api' | 'mobile' | 'performance' | 'mobile' | 'performance'; status: ExecutionStatus; locale: 'en' | 'ar';
  healingPolicy: string; selection: Record<string, unknown> | null; counts: Counts | null; error: string | null;
  queuedAt: string; startedAt: string | null; finishedAt: string | null; cancelRequested: boolean;
  /** sharded runs: the parent has shards (2–8); a shard has its index and parent */
  shards?: number | null; shardIndex?: number | null; parentId?: string | null;
}
export interface Shard { id: string; index: number; total: number; status: ExecutionStatus; agent: string | null; counts: Counts | null; startedAt: string | null; finishedAt: string | null; error: string | null }
export interface Healing { kind: string; purpose: string; target: string; original: string; healedBy: string; fix: string | null }
export interface TestResult {
  id: string; title: string; module: string | null; kind: string | null; status: string; flaky: boolean; retries: number;
  category: string | null; error: string | null; durationMs: number | null; caseKey: string | null; rowKey: string | null; healing: Healing[];
  evidence?: EvidenceFile[] | null;
}
export interface EvidenceFile { id: string; kind: 'screenshot' | 'video' | 'trace' | 'log' | 'har' | 'other'; name: string; contentType: string; sizeBytes: number; createdAt: string; expiresAt: string | null }
export interface ExecutionDetail { execution: Execution; results: TestResult[]; shards?: Shard[] | null }

export interface Agent { id: string; name: string; kind: 'central' | 'local' | 'private'; status: string; capabilities: { engines?: string[]; slots?: number } | null; version: string | null; lastHeartbeatAt: string | null; registeredAt: string }
export interface CreatedAgent { agent: Agent; token: string }

export interface Role { key: string; name: string; builtIn: boolean; permissions: string[] }
export interface Permission { key: string; description: string }
export interface Member { id: string; userId: string; email: string; displayName: string; userStatus: string; role: string; workspace: string | null; createdAt: string }
export interface TestUser { key: string; username: string; description: string | null; hasPassword: boolean }

export interface TrendPoint { executionId: string; at: string; status: string; environment: string; total: number; passed: number; failed: number; flaky: number; healed: number; passRate: number | null }
export interface ComparisonRow { title: string; module: string | null; before: string | null; after: string | null; change: 'broke' | 'fixed' | 'still_failing' | 'added' | 'removed' | 'unchanged' }
export interface Comparison { before: Execution; after: Execution; summary: Record<string, number>; tests: ComparisonRow[] }

export interface AuditEntry { id: number; at: string; action: string; resourceType: string; resourceId: string | null; actor: string | null; details: string }

export interface AssetContent { key: string; version: number; content: Record<string, unknown> }
export interface ChangeSet {
  id: string; projectId: string; title: string; status: 'submitted' | 'merged' | 'rejected' | 'approved' | 'draft'; source: 'central' | 'local';
  createdBy: string; reviewedBy: string | null; createdAt: string; decidedAt: string | null; decisionNote: string | null; items: number; hasConflicts: boolean;
}
export interface ChangeItem { id: string; assetType: string; key: string; baseVersion: number | null; currentVersion: number | null; isNew: boolean; conflict: boolean; content: Record<string, unknown>; current: Record<string, unknown> | null }
export interface ChangeSetDetail { changeSet: ChangeSet; items: ChangeItem[] }

export interface JiraSettings { baseUrl: string; projectKey: string; issueType: string; auth: 'basic' | 'bearer'; email: string | null; labels: string[] }
export interface Integration { id: string; kind: 'jira' | 'azure_devops' | 'testrail'; name: string; config: Partial<JiraSettings> & Record<string, unknown>; hasCredential: boolean; enabled: boolean; updatedAt: string }
export interface IntegrationCheck { ok: boolean; account: string | null; error: string | null }
export interface FiledIssue { resultId: string; title: string; issueKey: string; issueUrl: string; createdAt: string }
export interface PublishResult { created: FiledIssue[]; alreadyFiled: number; failed: { resultId: string; title: string; error: string }[] }

export interface PageElement {
  key: string; locator: unknown; fallbacks: unknown[]; within: string | null; frame: string | null; nth: number | null; hasText: string | null;
  control: string | null; description: string | null; healed30d: number; lastHealedBy: string | null;
}
export interface PageDetail {
  key: string; url: string | null; openMode: 'url' | 'navigate'; description: string | null; readyWhen: string | null; signedInAs: string | null;
  loggedOut: boolean; tags: string[]; version: number; elements: PageElement[]; leadsTo: { page: string; steps: number }[]; reachedFrom: { page: string; steps: number }[];
}
export interface FoundPage { url: string; page: string | null; tests: number; seenBy: string[] }
export interface FoundMessage { text: string; kind: string; tone: string | null; title: string | null; page: string | null; url: string; selector: string | null; known: boolean; tests: number; seenBy: string[] }
export interface Findings { newPages: FoundPage[]; knownPages: FoundPage[]; messages: FoundMessage[] }
export interface Artifact { id: string; kind: 'report' | 'log' | 'other'; name: string; contentType: string; sizeBytes: number; createdAt: string; expiresAt: string | null }
export interface HealedLocator { target: string; kind: string; count: number; tests: number; lastAt: string; lastHealedBy: string; fix: string | null; duringChecks: boolean }
export interface HealingReport { days: number; heals: number; healedTests: number; locators: HealedLocator[]; perDay: { day: string; heals: number }[] }
export interface CaseCoverage { key: string; title: string; module: string | null; engine: string; rows: number; lastStatus: string | null; lastRunAt: string | null; lastExecutionId: string | null; runs: number; failures: number; suites: string[] }
export interface Coverage { days: number; cases: number; neverRun: number; modules: { module: string; cases: number; rows: number; passing: number; failing: number; neverRun: number }[]; suites: { key: string; cases: number }[]; caseList: CaseCoverage[] }
/** kind int: value is a number (min..max); kind text: value is a string (at most maxLength characters) */
export interface OrgSetting { key: string; value: number | string; default: number | string; min: number; max: number; overridden: boolean; description: string; kind?: 'int' | 'text'; maxLength?: number }
export interface FeatureFlag { key: string; enabled: boolean; platformDefault: boolean; override: boolean | null; description: string }
export interface LoginSettings { page: string | null; fields: { username: string | null; password: string | null; submit: string | null } | null; success: { element: string | null; urlContains: string | null } | null }
export interface ElementInfo { page: string; element: string; control: string | null; description: string | null }
export interface WorkflowSummary { key: string; title: string; module: string | null; tags: string[]; steps: number; version: number }
export interface WorkflowDetail {
  key: string; title: string; description: string | null; module: string | null; tags: string[]; version: number;
  steps: { position: number; caseKey: string; caseTitle: string; row: string | null; runAs: string | null; start: string | null }[];
}
export interface Branding { key: string; name: string; company: string | null; client: string | null; primaryColor: string | null; reportTitle: string | null; footer: string | null; confidentiality: string | null; hasLogo: boolean; projects: number }
export interface CiToken { id: string; name: string; projectId: string | null; scopes: string[]; hint: string; createdAt: string; expiresAt: string | null; lastUsedAt: string | null; revokedAt: string | null }
export interface Channel { id: string; name: string; kind: 'webhook' | 'slack' | 'teams'; projectId: string | null; events: string[]; hasSigningSecret: boolean; enabled: boolean; updatedAt: string }
export interface SaveChannel { name?: string; kind?: string; projectId?: string | null; targetSecretRef?: string; signingSecretRef?: string; events?: string[]; enabled?: boolean }
export interface Delivery { id: string; executionId: string; event: string; status: 'pending' | 'sent' | 'failed'; attempts: number; lastError: string | null; createdAt: string; sentAt: string | null }
export interface DashboardProject { id: string; key: string; name: string; lastStatus: string | null; lastRunAt: string | null; lastExecutionId: string | null; passRate30d: number | null; runs7d: number; failingNow: number }
export interface Dashboard {
  projects: number; runs7d: number; active: number; agentsOnline: number; passRate30d: number | null; healed30d: number;
  projectHealth: DashboardProject[]; flaky: { projectId: string; projectKey: string; title: string; module: string | null; flaky: number; runs: number }[];
}
export interface Suite { key: string; description: string | null; modules: string[]; tags: string[]; cases: string[] }
export interface Selection { cases?: string[] | null; rows?: string[] | null; tags?: string[] | null; suite?: string | null; grep?: string | null }
export interface Schedule {
  id: string; name: string; cron: string; timeZone: string; environment: string; engine: 'web' | 'api' | 'mobile' | 'performance' | 'mobile' | 'performance'; selection: Selection; healing: string | null;
  enabled: boolean; nextRunAt: string | null; lastRunAt: string | null; lastExecutionId: string | null; updatedAt: string; shards?: number | null;
}
export interface SaveSchedule { name?: string; cron?: string; timeZone?: string; environment?: string; engine?: string; selection?: Selection; healing?: string; enabled?: boolean; shards?: number }

/** RFC 9457 problem details as the platform returns them */
export interface Problem { title?: string; detail?: string; status?: number; errors?: Record<string, string[]> }
