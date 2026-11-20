import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { Api, problemText } from '../core/api';
import { I18n, TranslatePipe } from '../core/i18n';
import type { Member, Role, Workspace } from '../core/models';
import { CustomRolesComponent } from './custom-roles.component';
import { Session } from '../core/session';
import { EmptyState, ErrorState } from '../core/states';

/** People of the organisation: invite by email, change role, remove (backlog §2 user and role screens). */
@Component({
  selector: 'at-members',
  standalone: true,
  imports: [FormsModule, TranslatePipe, CustomRolesComponent, ErrorState, EmptyState],
  template: `
    <h1>{{ 'Members' | t }}</h1>
    <at-error [message]="error()" />
    <form class="at-card at-row" (ngSubmit)="invite()">
      <div class="at-field"><label for="e">{{ 'Email' | t }}</label><input id="e" class="at-input" type="email" name="email" [(ngModel)]="email" dir="ltr"></div>
      <div class="at-field"><label for="n">{{ 'Name' | t }}</label><input id="n" class="at-input" name="name" [(ngModel)]="name"></div>
      <div class="at-field"><label for="r">{{ 'Role' | t }}</label>
        <select id="r" class="at-select" name="role" [(ngModel)]="role">
          @for (r of roles(); track r.key) { <option [value]="r.key">{{ r.key | t }}</option> }
        </select></div>
      <div class="at-field"><label for="w">{{ 'Workspace' | t }}</label>
        <select id="w" class="at-select" name="ws" [(ngModel)]="workspace">
          <option value="">{{ 'Whole organisation' | t }}</option>
          @for (w of workspaces(); track w.id) { <option [value]="w.key">{{ w.name }}</option> }
        </select></div>
      <button type="submit" class="at-btn primary" [disabled]="!email.includes('@') || !role">{{ 'Invite' | t }}</button>
    </form>
    <table class="at-table">
      <thead><tr><th>{{ 'Name' | t }}</th><th>{{ 'Email' | t }}</th><th>{{ 'Role' | t }}</th><th>{{ 'Workspace' | t }}</th><th>{{ 'Status' | t }}</th><th></th></tr></thead>
      <tbody>
        @for (m of members(); track m.id) {
          <tr>
            <td>{{ m.displayName }}</td>
            <td class="mono" dir="ltr">{{ m.email }}</td>
            <td>
              <select class="at-select" [ngModel]="m.role" (ngModelChange)="change(m, $event)" [attr.aria-label]="'Role' | t">
                @for (r of roles(); track r.key) { <option [value]="r.key">{{ r.key | t }}</option> }
              </select>
            </td>
            <td>{{ m.workspace ?? ('Whole organisation' | t) }}</td>
            <td>{{ m.userStatus | t }}</td>
            <td><button type="button" class="at-btn danger" (click)="remove(m)">{{ 'Remove' | t }}</button></td>
          </tr>
        } @empty { <tr><td colspan="6"><at-empty /></td></tr> }
      </tbody>
    </table>
    @if (session.isAdmin()) { <at-custom-roles (changed)="reloadRoles()" /> }
  `,
  styles: [`form.at-card { margin-block-end: var(--at-space-4); align-items: end; }`],
})
export class MembersPage implements OnInit {
  private readonly api = inject(Api);
  private readonly i18n = inject(I18n);
  protected readonly session = inject(Session);
  protected readonly members = signal<Member[]>([]);
  protected readonly roles = signal<Role[]>([]);
  protected readonly workspaces = signal<Workspace[]>([]);
  protected readonly error = signal<string | null>(null);
  protected email = '';
  protected name = '';
  protected role = 'tester';
  protected workspace = '';

  async ngOnInit() {
    try {
      const [roles, ws] = await Promise.all([firstValueFrom(this.api.roles()), firstValueFrom(this.api.workspaces())]);
      this.roles.set(roles);
      this.workspaces.set(ws);
    } catch (e) { this.error.set(problemText(e)); }
    await this.load();
  }

  async reloadRoles() {
    try { this.roles.set(await firstValueFrom(this.api.roles())); } catch (e) { this.error.set(problemText(e)); }
  }

  private async load() {
    try { this.members.set(await firstValueFrom(this.api.members())); this.error.set(null); }
    catch (e) { this.error.set(problemText(e)); }
  }

  async invite() {
    try {
      await firstValueFrom(this.api.invite({ email: this.email.trim(), displayName: this.name.trim() || undefined, role: this.role, workspace: this.workspace || null }));
      this.email = this.name = '';
      await this.load();
    } catch (e) { this.error.set(problemText(e)); }
  }

  async change(m: Member, role: string) {
    try { await firstValueFrom(this.api.changeRole(m.id, role)); await this.load(); }
    catch (e) { this.error.set(problemText(e)); await this.load(); }
  }

  async remove(m: Member) {
    if (!confirm(this.i18n.t('Remove {name}?', { name: m.displayName }))) return;
    try { await firstValueFrom(this.api.removeMember(m.id)); await this.load(); }
    catch (e) { this.error.set(problemText(e)); }
  }
}
