import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { Api, problemText } from '../core/api';
import { I18n, TranslatePipe } from '../core/i18n';
import type { FeatureFlag, OrgSetting } from '../core/models';
import { ErrorState } from '../core/states';

/** The organisation administrator's configuration: retention, run limits and which capabilities are switched on. */
@Component({
  selector: 'at-organization-settings',
  standalone: true,
  imports: [FormsModule, TranslatePipe, ErrorState],
  template: `
    <h1>{{ 'Organisation settings' | t }}</h1>
    <at-error [message]="error()" />
    @if (note()) { <p class="at-card" role="status">{{ note() }}</p> }

    <section class="at-card at-stack">
      <h2>{{ 'Settings' | t }}</h2>
      <table class="at-table">
        <thead><tr><th>{{ 'Setting' | t }}</th><th>{{ 'Value' | t }}</th><th>{{ 'Default' | t }}</th><th></th></tr></thead>
        <tbody>
          @for (s of settings(); track s.key) {
            <tr>
              <td><b class="mono">{{ s.key }}</b><div class="at-muted">{{ s.description | t }}</div></td>
              @if (s.kind === 'text') {
                <td><input class="at-input" [maxlength]="s.maxLength ?? 1000" [(ngModel)]="values[s.key]" [attr.aria-label]="s.key" dir="ltr"></td>
                <td>{{ s.default === '' ? ('(empty)' | t) : s.default }}</td>
              } @else if (s.min === 0 && s.max === 1) {
                <td><label class="at-row"><input type="checkbox" [ngModel]="values[s.key] === 1" (ngModelChange)="values[s.key] = $event ? 1 : 0" [attr.aria-label]="s.key"> {{ 'On' | t }}</label></td>
                <td>{{ (s.default === 1 ? 'On' : 'Off') | t }}</td>
              } @else {
                <td><input class="at-input small" type="number" [min]="s.min" [max]="s.max" [(ngModel)]="values[s.key]" [attr.aria-label]="s.key"></td>
                <td>{{ i18n.number(+s.default) }} <span class="at-muted">({{ i18n.number(s.min) }}–{{ i18n.number(s.max) }})</span></td>
              }
              <td>
                <button type="button" class="at-btn primary" (click)="saveSetting(s)">{{ 'Save' | t }}</button>
                @if (s.overridden) { <button type="button" class="at-btn" (click)="resetSetting(s)">{{ 'Use default' | t }}</button> }
              </td>
            </tr>
          }
        </tbody>
      </table>
    </section>

    <section class="at-card at-stack">
      <h2>{{ 'Capabilities' | t }}</h2>
      <table class="at-table">
        <thead><tr><th>{{ 'Capability' | t }}</th><th>{{ 'Status' | t }}</th><th>{{ 'Platform default' | t }}</th><th></th></tr></thead>
        <tbody>
          @for (f of flags(); track f.key) {
            <tr>
              <td><b class="mono">{{ f.key }}</b><div class="at-muted">{{ f.description | t }}</div></td>
              <td>{{ (f.enabled ? 'Switched on' : 'Switched off') | t }}</td>
              <td>{{ (f.platformDefault ? 'Switched on' : 'Switched off') | t }}</td>
              <td>
                <button type="button" class="at-btn" (click)="setFlag(f, !f.enabled)">{{ (f.enabled ? 'Switch off' : 'Switch on') | t }}</button>
                @if (f.override !== null) { <button type="button" class="at-btn" (click)="setFlag(f, null)">{{ 'Use default' | t }}</button> }
              </td>
            </tr>
          }
        </tbody>
      </table>
    </section>
  `,
  styles: [`section.at-card { margin-block-end: var(--at-space-4); } .small { inline-size: 110px; }`],
})
export class OrganizationSettingsPage implements OnInit {
  private readonly api = inject(Api);
  protected readonly i18n = inject(I18n);
  protected readonly settings = signal<OrgSetting[]>([]);
  protected readonly flags = signal<FeatureFlag[]>([]);
  protected readonly error = signal<string | null>(null);
  protected readonly note = signal<string | null>(null);
  protected values: Record<string, number | string> = {};

  async ngOnInit() { await this.load(); }

  private async load() {
    try {
      const [settings, flags] = await Promise.all([firstValueFrom(this.api.orgSettings()), firstValueFrom(this.api.featureFlags())]);
      this.settings.set(settings);
      this.flags.set(flags);
      this.values = Object.fromEntries(settings.map((s) => [s.key, s.value]));
      this.error.set(null);
    } catch (e) { this.error.set(problemText(e)); }
  }

  private async done() { this.note.set(this.i18n.t('Saved.')); setTimeout(() => this.note.set(null), 3000); await this.load(); }

  async saveSetting(s: OrgSetting) {
    const v = this.values[s.key];
    try { await firstValueFrom(this.api.putOrgSetting(s.key, s.kind === 'text' ? String(v ?? '').trim() : Number(v))); await this.done(); }
    catch (e) { this.error.set(problemText(e)); }
  }

  async resetSetting(s: OrgSetting) {
    try { await firstValueFrom(this.api.putOrgSetting(s.key, null)); await this.done(); }
    catch (e) { this.error.set(problemText(e)); }
  }

  async setFlag(f: FeatureFlag, enabled: boolean | null) {
    try { await firstValueFrom(this.api.putFeatureFlag(f.key, enabled)); await this.done(); }
    catch (e) { this.error.set(problemText(e)); }
  }
}
