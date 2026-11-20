import { Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DomSanitizer, type SafeUrl } from '@angular/platform-browser';
import { firstValueFrom } from 'rxjs';
import { Api, problemText } from '../core/api';
import { I18n, TranslatePipe } from '../core/i18n';
import type { Branding } from '../core/models';
import { EmptyState, ErrorState } from '../core/states';

interface BrandingForm { key: string; name: string; company: string; client: string; primaryColor: string; reportTitle: string; footer: string; confidentiality: string; editing: boolean }

/** Report branding per client or delivery: logo, colour, titles. Projects pick one; the Smart Report carries it. */
@Component({
  selector: 'at-branding',
  standalone: true,
  imports: [FormsModule, TranslatePipe, EmptyState, ErrorState],
  template: `
    <h1>{{ 'Report branding' | t }}</h1>
    <at-error [message]="error()" />
    <form class="at-card at-stack" (ngSubmit)="save()">
      <h2>{{ (form.editing ? 'Edit profile' : 'New profile') | t }}</h2>
      <div class="at-row wrap">
        <div class="at-field"><label for="k">{{ 'Key' | t }}</label><input id="k" class="at-input mono" name="k" [(ngModel)]="form.key" [readonly]="form.editing" dir="ltr" placeholder="client-moh"></div>
        <div class="at-field at-grow"><label for="n">{{ 'Name' | t }}</label><input id="n" class="at-input" name="n" [(ngModel)]="form.name"></div>
        <div class="at-field"><label for="c">{{ 'Colour' | t }}</label>
          <div class="at-row"><input id="c" type="color" name="c" [(ngModel)]="form.primaryColor"><span class="mono" dir="ltr">{{ form.primaryColor }}</span></div></div>
      </div>
      <div class="at-row wrap">
        <div class="at-field at-grow"><label for="co">{{ 'Company' | t }}</label><input id="co" class="at-input" name="co" [(ngModel)]="form.company"></div>
        <div class="at-field at-grow"><label for="cl">{{ 'Client' | t }}</label><input id="cl" class="at-input" name="cl" [(ngModel)]="form.client"></div>
      </div>
      <div class="at-row wrap">
        <div class="at-field at-grow"><label for="rt">{{ 'Report title' | t }}</label><input id="rt" class="at-input" name="rt" [(ngModel)]="form.reportTitle"></div>
        <div class="at-field at-grow"><label for="f">{{ 'Footer' | t }}</label><input id="f" class="at-input" name="f" [(ngModel)]="form.footer"></div>
        <div class="at-field"><label for="cf">{{ 'Confidentiality' | t }}</label><input id="cf" class="at-input" name="cf" [(ngModel)]="form.confidentiality" [placeholder]="'Confidential' | t"></div>
      </div>
      <div class="at-row">
        <button type="submit" class="at-btn primary" [disabled]="!form.key.trim() || !form.name.trim()">{{ 'Save' | t }}</button>
        @if (form.editing) { <button type="button" class="at-btn" (click)="reset()">{{ 'Cancel' | t }}</button> }
      </div>
    </form>

    <div class="cards">
      @for (b of profiles(); track b.key) {
        <article class="at-card at-stack profile" [style.border-top-color]="b.primaryColor || null">
          <div class="at-row">
            @if (logos()[b.key]; as src) { <img [src]="src" [alt]="b.name" class="logo"> } @else { <div class="logo empty">{{ 'No logo' | t }}</div> }
            <div class="at-grow"><b>{{ b.name }}</b><div class="at-muted mono">{{ b.key }}</div></div>
          </div>
          <div>{{ b.reportTitle ?? '—' }}</div>
          <div class="at-muted">{{ b.company ?? '' }}{{ b.client ? ' × ' + b.client : '' }}</div>
          <div class="at-muted">{{ 'Used by {n} projects' | t: { n: b.projects } }}</div>
          <div class="at-row wrap">
            <label class="at-btn">{{ 'Upload logo' | t }}<input type="file" accept="image/png,image/jpeg,image/webp" hidden (change)="upload(b, $event)"></label>
            @if (b.hasLogo) { <button type="button" class="at-btn" (click)="removeLogo(b)">{{ 'Remove logo' | t }}</button> }
            <button type="button" class="at-btn" (click)="edit(b)">{{ 'Edit' | t }}</button>
            <button type="button" class="at-btn danger" [disabled]="b.projects > 0" (click)="remove(b)">{{ 'Delete' | t }}</button>
          </div>
        </article>
      } @empty { <at-empty /> }
    </div>
  `,
  styles: [`
    form.at-card { margin-block-end: var(--at-space-4); } .wrap { flex-wrap: wrap; align-items: end; }
    .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: var(--at-space-4); }
    .profile { border-top: 4px solid var(--at-color-border); }
    .logo { inline-size: 64px; block-size: 64px; object-fit: contain; border-radius: var(--at-radius-sm); background: #fff; }
    .logo.empty { display: grid; place-items: center; font-size: 11px; color: var(--at-color-muted); border: 1px dashed var(--at-color-border); background: none; }
  `],
})
export class BrandingPage implements OnInit {
  private readonly api = inject(Api);
  private readonly i18n = inject(I18n);
  private readonly sanitizer = inject(DomSanitizer);
  protected readonly profiles = signal<Branding[]>([]);
  protected readonly logos = signal<Record<string, SafeUrl>>({});
  protected readonly error = signal<string | null>(null);
  protected form: BrandingForm = BrandingPage.empty();
  private objectUrls: string[] = [];

  constructor() { inject(DestroyRef).onDestroy(() => this.objectUrls.forEach((u) => URL.revokeObjectURL(u))); }

  private static empty(): BrandingForm {
    return { key: '', name: '', company: '', client: '', primaryColor: '#0e2a2a', reportTitle: '', footer: '', confidentiality: '', editing: false };
  }

  async ngOnInit() { await this.load(); }

  private async load() {
    try {
      const list = await firstValueFrom(this.api.branding());
      this.profiles.set(list);
      this.error.set(null);
      // logos need the caller's credentials: fetched as blobs
      const logos: Record<string, SafeUrl> = {};
      for (const b of list.filter((x) => x.hasLogo)) {
        try {
          const url = URL.createObjectURL(await firstValueFrom(this.api.brandingLogo(b.key)));
          this.objectUrls.push(url);
          logos[b.key] = this.sanitizer.bypassSecurityTrustUrl(url);
        } catch { /* shown without its logo */ }
      }
      this.logos.set(logos);
    } catch (e) { this.error.set(problemText(e)); }
  }

  protected reset() { this.form = BrandingPage.empty(); }

  protected edit(b: Branding) {
    this.form = { key: b.key, name: b.name, company: b.company ?? '', client: b.client ?? '', primaryColor: b.primaryColor ?? '#0e2a2a',
      reportTitle: b.reportTitle ?? '', footer: b.footer ?? '', confidentiality: b.confidentiality ?? '', editing: true };
  }

  async save() {
    const f = this.form;
    try {
      await firstValueFrom(this.api.putBranding(f.key.trim(), { name: f.name, company: f.company, client: f.client, primaryColor: f.primaryColor,
        reportTitle: f.reportTitle, footer: f.footer, confidentiality: f.confidentiality }));
      this.reset();
      await this.load();
    } catch (e) { this.error.set(problemText(e)); }
  }

  async upload(b: Branding, event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    try { await firstValueFrom(this.api.putBrandingLogo(b.key, file)); await this.load(); }
    catch (e) { this.error.set(problemText(e)); }
  }

  async removeLogo(b: Branding) {
    try { await firstValueFrom(this.api.deleteBrandingLogo(b.key)); await this.load(); }
    catch (e) { this.error.set(problemText(e)); }
  }

  async remove(b: Branding) {
    if (!confirm(this.i18n.t('Delete {name}?', { name: b.name }))) return;
    try { await firstValueFrom(this.api.deleteBranding(b.key)); await this.load(); }
    catch (e) { this.error.set(problemText(e)); }
  }
}
