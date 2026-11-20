import { Component, EventEmitter, OnInit, Output, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { Api, problemText } from '../core/api';
import { I18n, TranslatePipe } from '../core/i18n';
import type { Permission, Role } from '../core/models';
import { ErrorState } from '../core/states';

/** Custom roles (organisation administrators): built-in roles are shown read-only, custom ones can be edited. */
@Component({
  selector: 'at-custom-roles',
  standalone: true,
  imports: [FormsModule, TranslatePipe, ErrorState],
  template: `
    <section class="at-card at-stack">
      <div class="at-row"><h2 class="at-grow">{{ 'Roles' | t }}</h2>
        <button type="button" class="at-btn" (click)="startNew()">+ {{ 'New role' | t }}</button></div>
      <at-error [message]="error()" />
      <table class="at-table">
        <thead><tr><th>{{ 'Role' | t }}</th><th>{{ 'Permissions' | t }}</th><th></th></tr></thead>
        <tbody>
          @for (r of roles(); track r.key) {
            <tr>
              <td><b>{{ r.name }}</b> <span class="at-muted mono">{{ r.key }}</span>@if (r.builtIn) { <span class="at-badge">{{ 'built-in' | t }}</span> }</td>
              <td class="mono" dir="ltr">{{ r.permissions.join(', ') }}</td>
              <td>@if (!r.builtIn) {
                <button type="button" class="at-btn" (click)="edit(r)">{{ 'Edit' | t }}</button>
                <button type="button" class="at-btn danger" (click)="remove(r)">{{ 'Delete' | t }}</button> }</td>
            </tr>
          }
        </tbody>
      </table>

      @if (form) {
        <div class="at-card at-stack editor">
          <div class="at-row wrap">
            <div class="at-field"><label for="rk">{{ 'Key' | t }}</label><input id="rk" class="at-input mono" [(ngModel)]="form.key" [readonly]="form.editing" dir="ltr" placeholder="release-manager"></div>
            <div class="at-field at-grow"><label for="rn">{{ 'Name' | t }}</label><input id="rn" class="at-input" [(ngModel)]="form.name"></div>
          </div>
          <fieldset class="perms">
            <legend>{{ 'Permissions' | t }}</legend>
            @for (p of permissions(); track p.key) {
              @if (p.key !== 'org.admin') {
                <label class="at-row"><input type="checkbox" [checked]="form.permissions.has(p.key)" (change)="toggle(p.key)">
                  <span class="mono">{{ p.key }}</span> <span class="at-muted">{{ p.description | t }}</span></label>
              }
            }
          </fieldset>
          <div class="at-row">
            <button type="button" class="at-btn primary" [disabled]="!form.key.trim() || !form.name.trim() || !form.permissions.size" (click)="save()">{{ 'Save' | t }}</button>
            <button type="button" class="at-btn" (click)="form = null">{{ 'Cancel' | t }}</button>
          </div>
        </div>
      }
    </section>
  `,
  styles: [`section.at-card { margin-block-start: var(--at-space-6); } .wrap { flex-wrap: wrap; align-items: end; } .perms { border: 0; padding: 0; display: grid; gap: var(--at-space-1); }`],
})
export class CustomRolesComponent implements OnInit {
  @Output() readonly changed = new EventEmitter<void>();
  private readonly api = inject(Api);
  private readonly i18n = inject(I18n);
  protected readonly roles = signal<Role[]>([]);
  protected readonly permissions = signal<Permission[]>([]);
  protected readonly error = signal<string | null>(null);
  protected form: { key: string; name: string; permissions: Set<string>; editing: boolean } | null = null;

  async ngOnInit() {
    try { this.permissions.set(await firstValueFrom(this.api.permissions())); } catch (e) { this.error.set(problemText(e)); }
    await this.load();
  }

  private async load() {
    try { this.roles.set(await firstValueFrom(this.api.roles())); } catch (e) { this.error.set(problemText(e)); }
  }

  protected startNew() { this.form = { key: '', name: '', permissions: new Set(['project.view']), editing: false }; }
  protected edit(r: Role) { this.form = { key: r.key, name: r.name, permissions: new Set(r.permissions), editing: true }; }
  protected toggle(p: string) { if (this.form!.permissions.has(p)) this.form!.permissions.delete(p); else this.form!.permissions.add(p); }

  async save() {
    const f = this.form!;
    const body = { key: f.key.trim(), name: f.name.trim(), permissions: [...f.permissions] };
    try {
      if (f.editing) await firstValueFrom(this.api.updateRole(f.key, body));
      else await firstValueFrom(this.api.createRole(body));
      this.form = null;
      this.error.set(null);
      await this.load();
      this.changed.emit();
    } catch (e) { this.error.set(problemText(e)); }
  }

  async remove(r: Role) {
    if (!confirm(this.i18n.t('Delete {name}?', { name: r.name }))) return;
    try { await firstValueFrom(this.api.deleteRole(r.key)); await this.load(); this.changed.emit(); }
    catch (e) { this.error.set(problemText(e)); }
  }
}
