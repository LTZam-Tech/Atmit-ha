import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Auth } from '../core/auth';
import { Session } from '../core/session';
import { I18n, TranslatePipe } from '../core/i18n';

@Component({
  selector: 'at-sign-in',
  standalone: true,
  imports: [FormsModule, TranslatePipe],
  template: `
    <div class="wrap">
      <div class="at-card box at-stack">
        <div class="head">
          <img class="logo" src="brand/iltizam-logo.webp" alt="التزام · IltizamTech">
          <h1>{{ 'Atimtha' | t }} · {{ 'Automation Studio' | t }}</h1>
          <p class="at-muted">{{ 'You imagine. We automate.' | t }}</p>
        </div>
        @if (auth.mode === 'oidc') {
          <button type="button" class="at-btn primary" (click)="auth.signInOidc()">{{ 'Sign in with your organisation account' | t }}</button>
        } @else {
          <form class="at-stack" (ngSubmit)="devSignIn()">
            <p class="at-alert info">{{ 'Only for local development: the platform must run in the Development environment.' | t }}</p>
            <div class="at-field">
              <label for="email">{{ 'Email' | t }}</label>
              <input id="email" class="at-input" type="email" name="email" [(ngModel)]="email" required autocomplete="username" dir="ltr">
            </div>
            @if (error()) { <p class="at-error" role="alert">{{ error() }}</p> }
            <button type="submit" class="at-btn primary" [disabled]="busy() || !email.includes('@')">{{ 'Development sign-in' | t }}</button>
          </form>
        }
        <div class="lang">
          <button type="button" class="at-btn" (click)="i18n.set(i18n.lang() === 'ar' ? 'en' : 'ar')">{{ i18n.lang() === 'ar' ? 'English' : 'العربية' }}</button>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .wrap { min-block-size: 100vh; display: grid; place-items: center; padding: var(--at-space-6); }
    .box { inline-size: min(440px, 100%); }
    .head { text-align: center; }
    .logo { block-size: 96px; inline-size: auto; margin-block-end: var(--at-space-4); background: #ffffff; border-radius: var(--at-radius-sm); }
    .lang { text-align: end; }
  `],
})
export class SignInPage {
  protected readonly auth = inject(Auth);
  protected readonly i18n = inject(I18n);
  private readonly session = inject(Session);
  private readonly router = inject(Router);
  protected email = 'admin@atimtha.local';
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  async devSignIn() {
    this.busy.set(true);
    this.auth.signInDev(this.email);
    const me = await this.session.load();
    this.busy.set(false);
    if (!me) {
      this.error.set(this.session.error());
      this.auth.signOut();
      return;
    }
    await this.router.navigate([this.auth.organization() ? '/workspaces' : '/organisations']);
  }
}
