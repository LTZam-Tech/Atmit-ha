import { Component, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { Api, problemText } from '../core/api';
import { I18n, TranslatePipe } from '../core/i18n';
import { TabsKeyboard } from '../core/tabs.directive';
import { Session } from '../core/session';
import type { Branding, CaseSummary, ChangeSet, Schedule, Suite, WorkflowDetail, WorkflowSummary, Environment, Execution, PageSummary, Project, TestUser, TrendPoint } from '../core/models';
import { StatusBadge } from './status-badge';
import { ProjectSettingsComponent } from './project-settings.component';
import { ProjectAnalyticsComponent } from './project-analytics.component';
import { EmptyState, ErrorState, LoadingState } from '../core/states';

type Tab = 'overview' | 'environments' | 'users' | 'pages' | 'cases' | 'changes' | 'runs' | 'schedules' | 'suites' | 'flows' | 'settings' | 'analytics';

/** One project: overview, environments, test users, pages, test cases, change sets and runs (trend, compare, start). */
@Component({
  selector: 'at-project',
  standalone: true,
  imports: [FormsModule, RouterLink, TranslatePipe, StatusBadge, ProjectSettingsComponent, ProjectAnalyticsComponent, TabsKeyboard, ErrorState, LoadingState, EmptyState],
  template: `
    <at-error [message]="error()" />
    @if (project(); as p) {
      <div class="at-row"><h1 class="at-grow">{{ p.name }} <span class="at-muted mono">{{ p.key }}</span></h1></div>
      <nav class="at-tabs" role="tablist">
        @for (t of tabs; track t.id) {
          <a href="#" role="tab" [class.active]="tab() === t.id" [attr.aria-selected]="tab() === t.id" [attr.tabindex]="tab() === t.id ? 0 : -1" (click)="$event.preventDefault(); tab.set(t.id)">{{ t.label | t }}</a>
        }
      </nav>

      @switch (tab()) {
        @case ('overview') {
          <div class="grid">
            <div class="at-card"><div class="at-muted">{{ 'Pages' | t }}</div><div class="big">{{ i18n.number(pages().length) }}</div></div>
            <div class="at-card"><div class="at-muted">{{ 'Test cases' | t }}</div><div class="big">{{ i18n.number(cases().length) }}</div></div>
            <div class="at-card"><div class="at-muted">{{ 'Rows' | t }}</div><div class="big">{{ i18n.number(totalRows()) }}</div></div>
            <div class="at-card"><div class="at-muted">{{ 'Self-healing' | t }}</div><div class="big">{{ p.healingPolicy | t }}</div></div>
          </div>
          @if (p.description) { <p>{{ p.description }}</p> }
          <div class="at-card at-row branding">
            <span class="at-grow">{{ 'Project files (0.1.0 layout, for Git)' | t }}</span>
            <button type="button" class="at-btn" (click)="downloadZip()">⤓ {{ 'Download ZIP' | t }}</button>
          </div>
          <div class="at-card at-row branding">
            <span class="at-grow">{{ 'Report branding' | t }}</span>
            <select class="at-select" [ngModel]="brandingKey()" (ngModelChange)="setBranding($event)" [disabled]="!session.can('project.edit')" [attr.aria-label]="'Report branding' | t">
              <option value="">{{ 'Default' | t }}</option>
              @for (b of brandings(); track b.key) { <option [value]="b.key">{{ b.name }}</option> }
            </select>
          </div>
        }

        @case ('environments') {
          @if (session.can('project.edit')) {
            <form class="at-card at-row" (ngSubmit)="saveEnv()">
              <div class="at-field"><label for="ek">{{ 'Key' | t }}</label><input id="ek" class="at-input" name="ek" [(ngModel)]="envForm.key" dir="ltr"></div>
              <div class="at-field at-grow"><label for="eu">{{ 'Address' | t }}</label><input id="eu" class="at-input" name="eu" [(ngModel)]="envForm.baseUrl" dir="ltr" placeholder="https://"></div>
              <div class="at-field"><label for="eh">{{ 'Basic authentication' | t }}</label><input id="eh" class="at-input" name="eh" [(ngModel)]="envForm.httpUsername" dir="ltr"></div>
              <div class="at-field"><label for="es">{{ 'Password reference' | t }}</label><input id="es" class="at-input" name="es" [(ngModel)]="envForm.httpPasswordSecretRef" dir="ltr" placeholder="vault:env/NAME"></div>
              <label class="at-row"><input type="checkbox" name="ed" [(ngModel)]="envForm.isDefault"> {{ 'Default' | t }}</label>
              <label class="at-row"><input type="checkbox" name="ei" [(ngModel)]="envForm.ignoreHttpsErrors"> {{ 'Ignore HTTPS errors' | t }}</label>
              <button type="submit" class="at-btn primary" [disabled]="!envForm.key.trim() || !envForm.baseUrl.trim()">{{ 'Save' | t }}</button>
            </form>
          }
          <table class="at-table">
            <thead><tr><th>{{ 'Key' | t }}</th><th>{{ 'Address' | t }}</th><th>{{ 'Default' | t }}</th><th>{{ 'Basic authentication' | t }}</th><th></th></tr></thead>
            <tbody>
              @for (e of environments(); track e.key) {
                <tr><td class="mono">{{ e.key }}</td><td class="mono" dir="ltr">{{ e.baseUrl }}</td><td>{{ e.isDefault ? '✓' : '' }}</td><td>{{ e.httpUsername ?? '—' }}</td>
                  <td>@if (session.can('project.edit')) {
                    <button type="button" class="at-btn" (click)="editEnv(e)">{{ 'Edit' | t }}</button>
                    <button type="button" class="at-btn danger" (click)="deleteEnv(e)">{{ 'Delete' | t }}</button>
                  }</td></tr>
              } @empty { <tr><td colspan="5"><at-empty /></td></tr> }
            </tbody>
          </table>
        }

        @case ('users') {
          @if (session.can('project.edit')) {
            <form class="at-card at-row" (ngSubmit)="saveUser()">
              <div class="at-field"><label for="uk">{{ 'Key' | t }}</label><input id="uk" class="at-input" name="uk" [(ngModel)]="userForm.key" dir="ltr"></div>
              <div class="at-field"><label for="un">{{ 'User name' | t }}</label><input id="un" class="at-input" name="un" [(ngModel)]="userForm.username" dir="ltr"></div>
              <div class="at-field"><label for="up">{{ 'Password reference' | t }}</label><input id="up" class="at-input" name="up" [(ngModel)]="userForm.passwordSecretRef" dir="ltr" placeholder="vault:env/NAME"></div>
              <div class="at-field at-grow"><label for="ud">{{ 'Description' | t }}</label><input id="ud" class="at-input" name="ud" [(ngModel)]="userForm.description"></div>
              <button type="submit" class="at-btn primary" [disabled]="!userForm.key.trim() || !userForm.username.trim()">{{ 'Save' | t }}</button>
            </form>
          }
          <p class="at-muted">{{ 'Passwords are never stored here: only a reference to the secret store, resolved by the agent at run time.' | t }}</p>
          <table class="at-table">
            <thead><tr><th>{{ 'Key' | t }}</th><th>{{ 'User name' | t }}</th><th>{{ 'Description' | t }}</th><th>{{ 'Password' | t }}</th><th></th></tr></thead>
            <tbody>
              @for (u of users(); track u.key) {
                <tr><td class="mono">{{ u.key }}</td><td class="mono" dir="ltr">{{ u.username }}</td><td>{{ u.description ?? '—' }}</td><td>{{ u.hasPassword ? '✓' : '—' }}</td>
                  <td>@if (session.can('project.edit')) {
                    <button type="button" class="at-btn" (click)="editUser(u)">{{ 'Edit' | t }}</button>
                    <button type="button" class="at-btn danger" (click)="deleteUser(u)">{{ 'Delete' | t }}</button>
                  }</td></tr>
              } @empty { <tr><td colspan="5"><at-empty /></td></tr> }
            </tbody>
          </table>
        }

        @case ('pages') {
          @if (session.can('project.edit')) {
            <div class="at-row filters"><span class="at-grow"></span>
              <a class="at-btn primary" [routerLink]="['/projects', p.id, 'new-page']">+ {{ 'New page' | t }}</a></div>
          }
          <table class="at-table">
            <thead><tr><th>{{ 'Key' | t }}</th><th>{{ 'Address' | t }}</th><th>{{ 'Opens by' | t }}</th><th>{{ 'Elements' | t }}</th><th>{{ 'Version' | t }}</th></tr></thead>
            <tbody>
              @for (pg of pages(); track pg.key) {
                <tr><td class="mono"><a [routerLink]="['/projects', p.id, 'pages', pg.key]">{{ pg.key }}</a></td><td class="mono" dir="ltr">{{ pg.url ?? '—' }}</td><td>{{ (pg.openMode === 'url' ? 'address' : 'navigation') | t }}</td><td>{{ i18n.number(pg.elements) }}</td><td>{{ pg.version }}</td></tr>
              } @empty { <tr><td colspan="5"><at-empty /></td></tr> }
            </tbody>
          </table>
        }

        @case ('cases') {
          <div class="at-row filters"><span class="at-grow"></span>
            @if (session.can('project.edit')) { <a class="at-btn primary" [routerLink]="['/projects', p.id, 'new-case']">+ {{ 'New test case' | t }}</a> }</div>
          <table class="at-table">
            <thead><tr><th>{{ 'Name' | t }}</th><th>{{ 'Module' | t }}</th><th>{{ 'Engine' | t }}</th><th>{{ 'Type' | t }}</th><th>{{ 'Steps' | t }}</th><th>{{ 'Rows' | t }}</th><th></th></tr></thead>
            <tbody>
              @for (c of cases(); track c.key) {
                <tr>
                  <td>{{ c.title }}<div class="at-muted mono">{{ c.key }}</div></td>
                  <td>{{ c.module ?? '—' }}</td>
                  <td>{{ c.engine | t }}</td>
                  <td>{{ c.type ? (c.type | t) : '—' }}</td>
                  <td>{{ i18n.number(c.steps) }}</td>
                  <td>{{ i18n.number(c.rows) }}</td>
                  <td>
                    @if (session.can('execution.run')) { <button type="button" class="at-btn" (click)="start([c.key], c.engine)">{{ 'Run' | t }}</button> }
                    <a class="at-btn" [routerLink]="['/projects', p.id, 'cases', c.key]">{{ 'Edit' | t }}</a>
                  </td>
                </tr>
              } @empty { <tr><td colspan="7"><at-empty /></td></tr> }
            </tbody>
          </table>
        }

        @case ('analytics') {
          <at-project-analytics [projectId]="p.id" />
        }

        @case ('settings') {
          <at-project-settings [project]="p" [canEdit]="session.can('project.edit')" (saved)="load(projectId())" />
        }

        @case ('flows') {
          <div class="at-row filters"><p class="at-muted at-grow">{{ 'A workflow chains test cases in one browser session; each case continues where the previous one ended.' | t }}</p>
            @if (session.can('project.edit')) { <a class="at-btn primary" [routerLink]="['/projects', p.id, 'new-flow']">+ {{ 'New workflow' | t }}</a> }</div>
          <table class="at-table">
            <thead><tr><th>{{ 'Name' | t }}</th><th>{{ 'Module' | t }}</th><th>{{ 'Tags' | t }}</th><th>{{ 'Steps' | t }}</th><th>{{ 'Version' | t }}</th><th></th></tr></thead>
            <tbody>
              @for (f of flows(); track f.key) {
                <tr>
                  <td><a href="#" (click)="$event.preventDefault(); toggleFlow(f.key)">{{ f.title }}</a><div class="at-muted mono">{{ f.key }}</div></td>
                  <td>{{ f.module ?? '—' }}</td>
                  <td class="mono" dir="ltr">{{ f.tags.join(' ') || '—' }}</td>
                  <td>{{ i18n.number(f.steps) }}</td>
                  <td>{{ f.version }}</td>
                  <td>@if (session.can('execution.run')) { <button type="button" class="at-btn primary" [disabled]="busy()" (click)="startFlow(f.key)">{{ 'Run' | t }}</button> }
                    <a class="at-btn" [routerLink]="['/projects', p.id, 'flows', f.key, 'edit']">{{ 'Edit' | t }}</a></td>
                </tr>
                @if (openFlow()?.key === f.key) {
                  <tr><td colspan="6">
                    @if (openFlow()!.description) { <p>{{ openFlow()!.description }}</p> }
                    <ol class="flow">
                      @for (s of openFlow()!.steps; track s.position) {
                        <li>
                          <b>{{ s.caseTitle }}</b> <span class="mono at-muted">{{ s.caseKey }}</span>
                          @if (s.row) { · {{ 'row' | t }} <span class="mono">{{ s.row }}</span> }
                          @if (s.runAs) { · {{ 'as' | t }} <span class="mono">{{ s.runAs }}</span> }
                          @if (s.start) { · {{ s.start | t }} }
                        </li>
                      }
                    </ol>
                  </td></tr>
                }
              } @empty { <tr><td colspan="6"><at-empty /></td></tr> }
            </tbody>
          </table>
        }

        @case ('suites') {
          @if (session.can('project.edit')) {
            <form class="at-card at-stack" (ngSubmit)="saveSuite()">
              <div class="at-row wrap">
                <div class="at-field"><label for="sk">{{ 'Key' | t }}</label><input id="sk" class="at-input mono" name="sk" [(ngModel)]="suite.key" [readonly]="suite.editing" dir="ltr"></div>
                <div class="at-field at-grow"><label for="sd">{{ 'Description' | t }}</label><input id="sd" class="at-input" name="sd" [(ngModel)]="suite.description"></div>
              </div>
              <div class="at-row wrap">
                <div class="at-field at-grow"><label for="sm">{{ 'Modules (comma separated)' | t }}</label><input id="sm" class="at-input" name="sm" [(ngModel)]="suite.modules"></div>
                <div class="at-field at-grow"><label for="stg">{{ 'Tags (comma separated)' | t }}</label><input id="stg" class="at-input" name="stg" [(ngModel)]="suite.tags" dir="ltr" placeholder="@smoke"></div>
              </div>
              <fieldset class="picks">
                <legend>{{ 'Cases' | t }} ({{ i18n.number(suite.cases.size) }})</legend>
                @for (c of cases(); track c.key) {
                  <label class="at-row"><input type="checkbox" [checked]="suite.cases.has(c.key)" (change)="toggleSuiteCase(c.key)"> {{ c.title }} <span class="at-muted mono">{{ c.key }}</span></label>
                }
              </fieldset>
              <div class="at-row">
                <button type="submit" class="at-btn primary" [disabled]="!suite.key.trim()">{{ 'Save' | t }}</button>
                @if (suite.editing) { <button type="button" class="at-btn" (click)="resetSuite()">{{ 'Cancel' | t }}</button> }
              </div>
            </form>
          }
          <table class="at-table">
            <thead><tr><th>{{ 'Key' | t }}</th><th>{{ 'Description' | t }}</th><th>{{ 'Modules' | t }}</th><th>{{ 'Tags' | t }}</th><th>{{ 'Cases' | t }}</th><th></th></tr></thead>
            <tbody>
              @for (s of suites(); track s.key) {
                <tr>
                  <td class="mono">{{ s.key }}</td>
                  <td>{{ s.description ?? '—' }}</td>
                  <td>{{ s.modules.join(', ') || '—' }}</td>
                  <td class="mono" dir="ltr">{{ s.tags.join(' ') || '—' }}</td>
                  <td>{{ i18n.number(s.cases.length) }}</td>
                  <td>
                    @if (session.can('execution.run')) { <button type="button" class="at-btn primary" [disabled]="busy()" (click)="startSuite(s.key)">{{ 'Run' | t }}</button> }
                    @if (session.can('project.edit')) {
                      <button type="button" class="at-btn" (click)="editSuite(s)">{{ 'Edit' | t }}</button>
                      <button type="button" class="at-btn danger" (click)="deleteSuite(s)">{{ 'Delete' | t }}</button>
                    }
                  </td>
                </tr>
              } @empty { <tr><td colspan="6"><at-empty /></td></tr> }
            </tbody>
          </table>
        }

        @case ('schedules') {
          <form class="at-card at-row" (ngSubmit)="saveSchedule()">
            <div class="at-field"><label for="sn">{{ 'Name' | t }}</label><input id="sn" class="at-input" name="sn" [(ngModel)]="sched.name"></div>
            <div class="at-field"><label for="sc">{{ 'When (cron)' | t }}</label>
              <input id="sc" class="at-input mono" name="sc" [(ngModel)]="sched.cron" (ngModelChange)="previewCron()" dir="ltr" placeholder="0 2 * * *"></div>
            <div class="at-field"><label for="sz">{{ 'Time zone' | t }}</label>
              <input id="sz" class="at-input" name="sz" [(ngModel)]="sched.timeZone" (ngModelChange)="previewCron()" dir="ltr"></div>
            <div class="at-field"><label for="se">{{ 'Environment' | t }}</label>
              <select id="se" class="at-select" name="se" [(ngModel)]="sched.environment">
                @for (e of environments(); track e.key) { <option [value]="e.key">{{ e.key }}</option> }
              </select></div>
            <div class="at-field"><label for="sg">{{ 'Engine' | t }}</label>
              <select id="sg" class="at-select" name="sg" [(ngModel)]="sched.engine"><option value="web">{{ 'web' | t }}</option><option value="api">{{ 'api' | t }}</option><option value="mobile">{{ 'mobile' | t }}</option><option value="performance">{{ 'performance' | t }}</option></select></div>
            <div class="at-field"><label for="st">{{ 'Tags (comma separated)' | t }}</label>
              <input id="st" class="at-input" name="st" [(ngModel)]="sched.tags" dir="ltr" placeholder="@smoke"></div>
            <div class="at-field"><label for="ssh">{{ 'Shards' | t }}</label>
              <select id="ssh" class="at-select" name="ssh" [(ngModel)]="sched.shards">
                <option [ngValue]="1">{{ 'One run' | t }}</option>
                @for (n of [2, 3, 4, 5, 6, 7, 8]; track n) { <option [ngValue]="n">{{ n }}</option> }
              </select></div>
            <label class="at-row"><input type="checkbox" name="son" [(ngModel)]="sched.enabled"> {{ 'Switched on' | t }}</label>
            <button type="submit" class="at-btn primary" [disabled]="!sched.name.trim() || !sched.cron.trim()">{{ 'Save' | t }}</button>
            @if (sched.id) { <button type="button" class="at-btn" (click)="resetSchedule()">{{ 'Cancel' | t }}</button> }
          </form>
          @if (cronPreview().length) {
            <p class="at-muted">{{ 'Next runs' | t }}: @for (d of cronPreview(); track d) { <span class="at-badge">{{ i18n.date(d) }}</span> }</p>
          } @else if (cronError()) { <p class="at-error">{{ cronError() }}</p> }
          <table class="at-table">
            <thead><tr><th>{{ 'Name' | t }}</th><th>{{ 'When (cron)' | t }}</th><th>{{ 'Environment' | t }}</th><th>{{ 'Next run' | t }}</th><th>{{ 'Last run' | t }}</th><th>{{ 'Status' | t }}</th><th></th></tr></thead>
            <tbody>
              @for (s of schedules(); track s.id) {
                <tr>
                  <td>{{ s.name }}</td>
                  <td class="mono" dir="ltr">{{ s.cron }} <span class="at-muted">{{ s.timeZone }}</span></td>
                  <td class="mono">{{ s.environment }}</td>
                  <td>{{ s.nextRunAt ? i18n.date(s.nextRunAt) : '—' }}</td>
                  <td>@if (s.lastExecutionId) { <a [routerLink]="['/runs', s.lastExecutionId]">{{ i18n.date(s.lastRunAt) }}</a> } @else { — }</td>
                  <td>{{ (s.enabled ? 'Switched on' : 'Switched off') | t }}</td>
                  <td>
                    <button type="button" class="at-btn" (click)="toggleSchedule(s)">{{ (s.enabled ? 'Pause' : 'Resume') | t }}</button>
                    <button type="button" class="at-btn" (click)="editSchedule(s)">{{ 'Edit' | t }}</button>
                    <button type="button" class="at-btn danger" (click)="deleteSchedule(s)">{{ 'Delete' | t }}</button>
                  </td>
                </tr>
              } @empty { <tr><td colspan="7"><at-empty /></td></tr> }
            </tbody>
          </table>
        }

        @case ('changes') {
          <div class="at-row filters">
            <select class="at-select" [(ngModel)]="changeStatus" (ngModelChange)="loadChanges()" [attr.aria-label]="'Status' | t">
              <option value="submitted">{{ 'submitted' | t }}</option><option value="merged">{{ 'merged' | t }}</option>
              <option value="rejected">{{ 'rejected' | t }}</option><option value="">{{ 'All' | t }}</option>
            </select>
          </div>
          <table class="at-table">
            <thead><tr><th>{{ 'Title' | t }}</th><th>{{ 'Status' | t }}</th><th>{{ 'Author' | t }}</th><th>{{ 'Source' | t }}</th><th>{{ 'Items' | t }}</th><th>{{ 'Created' | t }}</th></tr></thead>
            <tbody>
              @for (c of changes(); track c.id) {
                <tr>
                  <td><a [routerLink]="['/change-sets', c.id]">{{ c.title }}</a>@if (c.hasConflicts) { <span class="at-badge bad">{{ 'conflict' | t }}</span> }</td>
                  <td><at-status [status]="c.status" /></td>
                  <td class="mono" dir="ltr">{{ c.createdBy }}</td>
                  <td>{{ c.source | t }}</td>
                  <td>{{ i18n.number(c.items) }}</td>
                  <td>{{ i18n.date(c.createdAt) }}</td>
                </tr>
              } @empty { <tr><td colspan="6"><at-empty /></td></tr> }
            </tbody>
          </table>
        }

        @case ('runs') {
          @if (trend().length > 1) {
            <figure class="at-card trend">
              <figcaption class="at-muted">{{ 'Pass rate, last runs' | t }}</figcaption>
              <svg viewBox="0 0 300 80" preserveAspectRatio="none" role="img" [attr.aria-label]="'Pass rate, last runs' | t">
                <polyline [attr.points]="trendPoints()" fill="none" stroke="var(--at-color-primary)" stroke-width="2" vector-effect="non-scaling-stroke" />
                @for (pt of trendDots(); track pt.id) {
                  <circle [attr.cx]="pt.x" [attr.cy]="pt.y" r="2.5" [attr.fill]="pt.ok ? 'var(--at-color-ok)' : 'var(--at-color-bad)'"><title>{{ pt.label }}</title></circle>
                }
              </svg>
            </figure>
          }
          <form class="at-card at-row" (ngSubmit)="startFromForm()">
            <div class="at-field"><label for="env">{{ 'Environment' | t }}</label>
              <select id="env" class="at-select" name="env" [(ngModel)]="runEnv">
                @for (e of environments(); track e.key) { <option [value]="e.key">{{ e.key }}{{ e.isDefault ? ' ★' : '' }}</option> }
              </select></div>
            <div class="at-field"><label for="engine">{{ 'Engine' | t }}</label>
              <select id="engine" class="at-select" name="engine" [(ngModel)]="runEngine"><option value="web">{{ 'web' | t }}</option><option value="api">{{ 'api' | t }}</option><option value="mobile">{{ 'mobile' | t }}</option><option value="performance">{{ 'performance' | t }}</option></select></div>
            <div class="at-field"><label for="tags">{{ 'Tags (comma separated)' | t }}</label>
              <input id="tags" class="at-input" name="tags" [(ngModel)]="runTags" dir="ltr" placeholder="@smoke"></div>
            <div class="at-field"><label for="healing">{{ 'Self-healing' | t }}</label>
              <select id="healing" class="at-select" name="healing" [(ngModel)]="runHealing">
                <option value="">{{ 'Default' | t }} ({{ p.healingPolicy | t }})</option>
                <option value="pass">{{ 'pass' | t }}</option><option value="flag">{{ 'flag' | t }}</option><option value="off">{{ 'off' | t }}</option>
              </select></div>
            <div class="at-field"><label for="shards">{{ 'Shards' | t }}</label>
              <select id="shards" class="at-select" name="shards" [(ngModel)]="runShards" [title]="'Split the run across agents' | t">
                <option [ngValue]="1">{{ 'One run' | t }}</option>
                @for (n of [2, 3, 4, 5, 6, 7, 8]; track n) { <option [ngValue]="n">{{ n }}</option> }
              </select></div>
            <button type="submit" class="at-btn primary" [disabled]="busy() || !session.can('execution.run')">{{ 'Start a run' | t }}</button>
          </form>
          @if (session.can('execution.run')) {
            <details class="at-card tools">
              <summary>{{ 'Collect pages and export code' | t }}</summary>
              <form class="at-stack" (ngSubmit)="collectPages()">
                <div class="at-field"><label for="exurls">{{ 'Pages to collect (one path or address per line, on the environment above)' | t }}</label>
                  <textarea id="exurls" class="at-input" name="exurls" rows="3" dir="ltr" [(ngModel)]="exploreUrls" placeholder="/login&#10;/orders/new"></textarea></div>
                <div class="at-row">
                  <div class="at-field"><label for="exas">{{ 'Sign in first as' | t }}</label>
                    <select id="exas" class="at-select" name="exas" [(ngModel)]="exploreAs">
                      <option value="">{{ 'Nobody (signed out)' | t }}</option>
                      @for (u of users(); track u.key) { <option [value]="u.key">{{ u.key }}</option> }
                    </select></div>
                  <span class="at-grow"></span>
                  <button type="submit" class="at-btn primary" [disabled]="busy() || !exploreUrls.trim()">{{ 'Collect pages' | t }}</button>
                  <button type="button" class="at-btn" [disabled]="busy()" (click)="exportCode()">{{ 'Export Playwright code' | t }}</button>
                </div>
                <p class="at-muted">{{ 'An agent opens each page and proposes it as a draft; you send the ones you want for review from the run page.' | t }}</p>
              </form>
            </details>
          }
          <table class="at-table">
            <thead><tr><th>{{ 'Status' | t }}</th><th>{{ 'Environment' | t }}</th><th>{{ 'Engine' | t }}</th><th>{{ 'Results' | t }}</th><th>{{ 'Queued' | t }}</th><th>{{ 'Finished' | t }}</th><th></th></tr></thead>
            <tbody>
              @for (r of runs(); track r.id) {
                <tr>
                  <td><a [routerLink]="['/runs', r.id]"><at-status [status]="r.status" /></a></td>
                  <td class="mono">{{ r.environment }}</td>
                  <td>{{ r.engine | t }}@if (r.shards) { <span class="at-muted"> · {{ '{n} shards' | t: { n: r.shards } }}</span> }@if (r.selection?.['kind']; as k) { <span class="at-muted"> · {{ (k === 'explore' ? 'Collect pages' : 'Export Playwright code') | t }}</span> }</td>
                  <td>{{ r.counts ? (i18n.number(r.counts.passed ?? 0) + ' / ' + i18n.number(r.counts.total ?? 0)) : '—' }}</td>
                  <td>{{ i18n.date(r.queuedAt) }}</td>
                  <td>{{ i18n.date(r.finishedAt) }}</td>
                  <td>@if ($index < runs().length - 1) {
                    <a class="at-btn" [routerLink]="['/compare']" [queryParams]="{ before: runs()[$index + 1].id, after: r.id }">{{ 'Compare with previous' | t }}</a>
                  }</td>
                </tr>
              } @empty { <tr><td colspan="7"><at-empty /></td></tr> }
            </tbody>
          </table>
        }
      }
    } @else if (!error()) {
      <at-loading />
    }
  `,
  styles: [`
    .tools { margin-block: var(--at-space-3); } .tools summary { cursor: pointer; font-weight: 600; } .tools form { margin-block-start: var(--at-space-3); }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: var(--at-space-4); margin-block-end: var(--at-space-4); }
    .big { font-size: 26px; font-weight: 700; }
    form.at-card { margin-block-end: var(--at-space-4); align-items: end; flex-wrap: wrap; }
    .filters { margin-block-end: var(--at-space-4); }
    .wrap { flex-wrap: wrap; align-items: end; }
    .branding { margin-block-start: var(--at-space-4); max-inline-size: 520px; }
    .flow { margin: 0; padding-inline-start: var(--at-space-6); display: grid; gap: var(--at-space-2); }
    .picks { max-block-size: 260px; overflow: auto; border: 1px solid var(--at-color-border); border-radius: var(--at-radius-sm); padding: var(--at-space-3); }
    .trend { margin: 0 0 var(--at-space-4); }
    .trend svg { inline-size: 100%; block-size: 90px; overflow: visible; }
  `],
})
export class ProjectPage {
  readonly projectId = input.required<string>();
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  protected readonly i18n = inject(I18n);
  protected readonly session = inject(Session);
  protected readonly tabs: { id: Tab; label: string }[] = [
    { id: 'overview', label: 'Overview' }, { id: 'environments', label: 'Environments' }, { id: 'users', label: 'Test users' },
    { id: 'pages', label: 'Pages' }, { id: 'cases', label: 'Test cases' }, { id: 'flows', label: 'Workflows' }, { id: 'changes', label: 'Changes' }, { id: 'suites', label: 'Suites' }, { id: 'runs', label: 'Runs' }, { id: 'analytics', label: 'Analytics' }, { id: 'schedules', label: 'Schedules' }, { id: 'settings', label: 'Settings' },
  ];
  protected readonly tab = signal<Tab>('overview');
  protected readonly project = signal<Project | null>(null);
  protected readonly environments = signal<Environment[]>([]);
  protected readonly pages = signal<PageSummary[]>([]);
  protected readonly cases = signal<CaseSummary[]>([]);
  protected readonly runs = signal<Execution[]>([]);
  protected readonly users = signal<TestUser[]>([]);
  protected readonly changes = signal<ChangeSet[]>([]);
  protected readonly trend = signal<TrendPoint[]>([]);
  protected readonly schedules = signal<Schedule[]>([]);
  protected readonly suites = signal<Suite[]>([]);
  protected readonly flows = signal<WorkflowSummary[]>([]);
  protected readonly brandings = signal<Branding[]>([]);
  protected readonly brandingKey = signal('');
  protected readonly openFlow = signal<WorkflowDetail | null>(null);
  protected suite = ProjectPage.emptySuite();
  protected readonly cronPreview = signal<string[]>([]);
  protected readonly cronError = signal<string | null>(null);
  protected sched = ProjectPage.emptySchedule();
  private previewTimer?: ReturnType<typeof setTimeout>;
  protected changeStatus = 'submitted';
  protected envForm = ProjectPage.emptyEnv();
  protected userForm = ProjectPage.emptyUser();
  protected readonly error = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected runEnv = '';
  protected runEngine: 'web' | 'api' | 'mobile' | 'performance' = 'web';
  protected runTags = '';
  protected runHealing = '';
  /** 1 = one run; 2–8 = split across agents */
  protected runShards = 1;

  constructor() {
    effect(() => { void this.load(this.projectId()); });
  }

  private static emptyEnv() {
    return { key: '', baseUrl: '', httpUsername: '', httpPasswordSecretRef: '', isDefault: false, ignoreHttpsErrors: false, startDemoApp: false };
  }
  private static emptyUser() { return { key: '', username: '', passwordSecretRef: '', description: '' }; }

  /** oldest run on the left; the API returns newest first */
  private trendSeries() {
    const pts = [...this.trend()].reverse();
    const step = pts.length > 1 ? 300 / (pts.length - 1) : 0;
    return pts.map((p, i) => ({ id: p.executionId, x: i * step, y: 80 - ((p.passRate ?? 0) / 100) * 80, ok: p.failed === 0,
      label: this.i18n.date(p.at) + ' · ' + p.passed + '/' + p.total }));
  }
  protected trendDots() { return this.trendSeries(); }
  protected trendPoints() { return this.trendSeries().map((p) => p.x + ',' + p.y).join(' '); }

  protected totalRows() { return this.cases().reduce((n, c) => n + Math.max(c.rows, 1), 0); }

  protected async load(id: string) {
    try {
      const [p, envs, pages, cases, runs] = await Promise.all([
        firstValueFrom(this.api.project(id)), firstValueFrom(this.api.environments(id)), firstValueFrom(this.api.pages(id)),
        firstValueFrom(this.api.cases(id)), firstValueFrom(this.api.executions(id)),
      ]);
      this.project.set(p);
      this.environments.set(envs);
      this.pages.set(pages);
      this.cases.set(cases);
      this.runs.set(runs);
      this.runEnv = envs.find((e) => e.isDefault)?.key ?? envs[0]?.key ?? '';
      this.error.set(null);
    } catch (e) {
      this.error.set(problemText(e));
      return;
    }
    // secondary data: a failure here must not hide the project
    try {
      const [users, trend] = await Promise.all([firstValueFrom(this.api.testUsers(id)), firstValueFrom(this.api.trend(id))]);
      this.users.set(users);
      this.trend.set(trend);
    } catch { /* missing permission: the tabs stay empty */ }
    await this.loadChanges();
    try { this.schedules.set(await firstValueFrom(this.api.schedules(id))); } catch { this.schedules.set([]); }
    try { this.suites.set(await firstValueFrom(this.api.suites(id))); } catch { this.suites.set([]); }
    try { this.flows.set(await firstValueFrom(this.api.flows(id))); } catch { this.flows.set([]); }
    try {
      const [list, current] = await Promise.all([firstValueFrom(this.api.branding()), firstValueFrom(this.api.projectBranding(id))]);
      this.brandings.set(list);
      this.brandingKey.set(current.profile ?? '');
    } catch { this.brandings.set([]); }
  }

  private static emptySuite() { return { key: '', description: '', modules: '', tags: '', cases: new Set<string>(), editing: false }; }
  protected resetSuite() { this.suite = ProjectPage.emptySuite(); }

  protected editSuite(s: Suite) {
    this.suite = { key: s.key, description: s.description ?? '', modules: s.modules.join(', '), tags: s.tags.join(', '), cases: new Set(s.cases), editing: true };
  }

  protected toggleSuiteCase(key: string) {
    if (this.suite.cases.has(key)) this.suite.cases.delete(key); else this.suite.cases.add(key);
  }

  protected async saveSuite() {
    const list = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);
    const f = this.suite;
    try {
      await firstValueFrom(this.api.putSuite(this.projectId(), f.key.trim(), {
        description: f.description.trim() || null, modules: list(f.modules), tags: list(f.tags), cases: [...f.cases],
      }));
      this.resetSuite();
      this.suites.set(await firstValueFrom(this.api.suites(this.projectId())));
      this.error.set(null);
    } catch (e) { this.error.set(problemText(e)); }
  }

  protected async deleteSuite(s: Suite) {
    if (!confirm(this.i18n.t('Delete {name}?', { name: s.key }))) return;
    try {
      await firstValueFrom(this.api.deleteSuite(this.projectId(), s.key));
      this.suites.set(await firstValueFrom(this.api.suites(this.projectId())));
    } catch (e) { this.error.set(problemText(e)); }
  }

  protected async downloadZip() {
    try {
      const blob = await firstValueFrom(this.api.projectZip(this.projectId()));
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `atimtha-${this.project()?.key ?? 'project'}.zip`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) { this.error.set(problemText(e)); }
  }

  protected async setBranding(key: string) {
    try { await firstValueFrom(this.api.setProjectBranding(this.projectId(), key || null)); this.brandingKey.set(key); this.error.set(null); }
    catch (e) { this.error.set(problemText(e)); }
  }

  protected async toggleFlow(key: string) {
    if (this.openFlow()?.key === key) { this.openFlow.set(null); return; }
    try { this.openFlow.set(await firstValueFrom(this.api.flow(this.projectId(), key))); }
    catch (e) { this.error.set(problemText(e)); }
  }

  protected startFlow(key: string) { return this.start(undefined, 'web', undefined, undefined, [key]); }

  protected startSuite(key: string) { return this.start(undefined, this.runEngine, undefined, key); }

  private static emptySchedule() {
    return { id: null as string | null, name: '', cron: '0 2 * * *', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Riyadh',
      environment: '', engine: 'web' as 'web' | 'api' | 'mobile' | 'performance', tags: '', enabled: true, shards: 1 };
  }

  protected resetSchedule() { this.sched = ProjectPage.emptySchedule(); this.sched.environment = this.runEnv; this.cronPreview.set([]); }

  protected editSchedule(s: Schedule) {
    this.sched = { id: s.id, name: s.name, cron: s.cron, timeZone: s.timeZone, environment: s.environment, engine: s.engine,
      tags: (s.selection.tags ?? []).join(', '), enabled: s.enabled, shards: s.shards ?? 1 };
    this.previewCron();
  }

  /** the next start times, asked after typing stops */
  protected previewCron() {
    clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(async () => {
      try { this.cronPreview.set(await firstValueFrom(this.api.previewSchedule(this.sched.cron, this.sched.timeZone))); this.cronError.set(null); }
      catch (e) { this.cronPreview.set([]); this.cronError.set(problemText(e)); }
    }, 400);
  }

  protected async saveSchedule() {
    const f = this.sched;
    const tags = f.tags.split(',').map((t) => t.trim()).filter(Boolean);
    const body = { name: f.name.trim(), cron: f.cron.trim(), timeZone: f.timeZone.trim(), environment: f.environment || this.runEnv || undefined,
      engine: f.engine, selection: { tags: tags.length ? tags : null }, enabled: f.enabled, shards: f.shards };
    try {
      if (f.id) await firstValueFrom(this.api.updateSchedule(f.id, body));
      else await firstValueFrom(this.api.createSchedule(this.projectId(), body));
      this.resetSchedule();
      this.schedules.set(await firstValueFrom(this.api.schedules(this.projectId())));
      this.error.set(null);
    } catch (e) { this.error.set(problemText(e)); }
  }

  protected async toggleSchedule(s: Schedule) {
    try {
      await firstValueFrom(this.api.updateSchedule(s.id, { enabled: !s.enabled }));
      this.schedules.set(await firstValueFrom(this.api.schedules(this.projectId())));
    } catch (e) { this.error.set(problemText(e)); }
  }

  protected async deleteSchedule(s: Schedule) {
    if (!confirm(this.i18n.t('Delete {name}?', { name: s.name }))) return;
    try {
      await firstValueFrom(this.api.deleteSchedule(s.id));
      this.schedules.set(await firstValueFrom(this.api.schedules(this.projectId())));
    } catch (e) { this.error.set(problemText(e)); }
  }

  protected async loadChanges() {
    try { this.changes.set(await firstValueFrom(this.api.changeSets(this.projectId(), this.changeStatus || undefined))); }
    catch { this.changes.set([]); }
  }

  protected editEnv(e: Environment) {
    this.envForm = { key: e.key, baseUrl: e.baseUrl, httpUsername: e.httpUsername ?? '', httpPasswordSecretRef: '',
      isDefault: e.isDefault, ignoreHttpsErrors: e.ignoreHttpsErrors, startDemoApp: e.startDemoApp };
  }

  protected async saveEnv() {
    const f = this.envForm;
    try {
      await firstValueFrom(this.api.putEnvironment(this.projectId(), f.key.trim(), {
        baseUrl: f.baseUrl.trim(), isDefault: f.isDefault, ignoreHttpsErrors: f.ignoreHttpsErrors, startDemoApp: f.startDemoApp,
        httpUsername: f.httpUsername.trim() || null,
        ...(f.httpPasswordSecretRef.trim() ? { httpPasswordSecretRef: f.httpPasswordSecretRef.trim() } : {}),
      }));
      this.envForm = ProjectPage.emptyEnv();
      this.environments.set(await firstValueFrom(this.api.environments(this.projectId())));
      this.error.set(null);
    } catch (e) { this.error.set(problemText(e)); }
  }

  protected async deleteEnv(e: Environment) {
    if (!confirm(this.i18n.t('Delete {name}?', { name: e.key }))) return;
    try {
      await firstValueFrom(this.api.deleteEnvironment(this.projectId(), e.key));
      this.environments.set(await firstValueFrom(this.api.environments(this.projectId())));
    } catch (err) { this.error.set(problemText(err)); }
  }

  protected editUser(u: TestUser) {
    this.userForm = { key: u.key, username: u.username, passwordSecretRef: '', description: u.description ?? '' };
  }

  protected async saveUser() {
    const f = this.userForm;
    try {
      await firstValueFrom(this.api.putTestUser(this.projectId(), f.key.trim(), {
        username: f.username.trim(), description: f.description.trim() || null,
        ...(f.passwordSecretRef.trim() ? { passwordSecretRef: f.passwordSecretRef.trim() } : {}),
      }));
      this.userForm = ProjectPage.emptyUser();
      this.users.set(await firstValueFrom(this.api.testUsers(this.projectId())));
      this.error.set(null);
    } catch (e) { this.error.set(problemText(e)); }
  }

  protected async deleteUser(u: TestUser) {
    if (!confirm(this.i18n.t('Delete {name}?', { name: u.key }))) return;
    try {
      await firstValueFrom(this.api.deleteTestUser(this.projectId(), u.key));
      this.users.set(await firstValueFrom(this.api.testUsers(this.projectId())));
    } catch (err) { this.error.set(problemText(err)); }
  }

  protected exploreUrls = '';
  protected exploreAs = '';

  /** an explore job: an agent collects these pages as drafts (backlog §3/§6) */
  protected collectPages() {
    const urls = this.exploreUrls.split(/\r?\n/).map((u) => u.trim()).filter(Boolean);
    return this.queueJob({ kind: 'explore', explore: { urls, as: this.exploreAs || null } });
  }

  /** an export job: an agent turns the project into a standalone Playwright project */
  protected exportCode() { return this.queueJob({ kind: 'export' }); }

  private async queueJob(extra: { kind: 'explore' | 'export'; explore?: { urls: string[]; as: string | null } }) {
    this.busy.set(true);
    try {
      const run = await firstValueFrom(this.api.startExecution(this.projectId(), {
        environment: this.runEnv || undefined, engine: 'web', locale: this.i18n.lang(), ...extra,
      }));
      await this.router.navigate(['/runs', run.id]);
    } catch (e) {
      this.error.set(problemText(e));
    } finally {
      this.busy.set(false);
    }
  }

  protected startFromForm() {
    const tags = this.runTags.split(',').map((t) => t.trim()).filter(Boolean);
    return this.start(undefined, this.runEngine, tags, undefined, undefined, this.runShards);
  }

  protected async start(cases?: string[], engine: 'web' | 'api' | 'mobile' | 'performance' = 'web', tags?: string[], suite?: string, flows?: string[], shards = 1) {
    this.busy.set(true);
    try {
      const run = await firstValueFrom(this.api.startExecution(this.projectId(), {
        environment: this.runEnv || undefined,
        engine,
        selection: { ...(cases ? { cases } : {}), ...(tags?.length ? { tags } : {}), ...(suite ? { suite } : {}), ...(flows?.length ? { flows } : {}) },
        locale: this.i18n.lang(),
        ...(this.runHealing ? { healing: this.runHealing } : {}),
        ...(shards >= 2 ? { shards } : {}),
      }));
      await this.router.navigate(['/runs', run.id]);
    } catch (e) {
      this.error.set(problemText(e));
    } finally {
      this.busy.set(false);
    }
  }
}
