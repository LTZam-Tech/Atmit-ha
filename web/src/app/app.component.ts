import { Component, computed, inject } from '@angular/core';
import { Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { I18n, TranslatePipe, type Lang } from './core/i18n';
import { Auth } from './core/auth';
import { Session } from './core/session';

/** Application shell: sidebar navigation, organisation, language switch (backlog §2, §3). */
@Component({
  selector: 'at-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, TranslatePipe],
  template: `
    @if (showShell()) {
      <a class="skip" href="#main" (click)="$event.preventDefault(); skipToMain()">{{ 'Skip to content' | t }}</a>
      <div class="shell">
        <nav class="side" [attr.aria-label]="'Atimtha' | t">
          <a class="brand" routerLink="/workspaces">
            <img class="logo" src="brand/iltizam-logo.webp" alt="التزام · IltizamTech">
            <span><b>{{ 'Atimtha' | t }}</b><small>{{ 'Automation Studio' | t }}</small></span>
          </a>
          <a class="nav" routerLink="/dashboard" routerLinkActive="on">{{ 'Dashboard' | t }}</a>
          <a class="nav" routerLink="/workspaces" routerLinkActive="on">{{ 'Projects' | t }}</a>
          @if (session.can('member.manage')) { <a class="nav" routerLink="/members" routerLinkActive="on">{{ 'Members' | t }}</a> }
          @if (session.can('audit.view')) { <a class="nav" routerLink="/audit" routerLinkActive="on">{{ 'Audit log' | t }}</a> }
          @if (session.can('workspace.manage')) { <a class="nav" routerLink="/branding" routerLinkActive="on">{{ 'Report branding' | t }}</a> }
          @if (session.can('integration.manage')) {
            <a class="nav" routerLink="/integrations" routerLinkActive="on">{{ 'Integrations' | t }}</a>
            <a class="nav" routerLink="/notifications" routerLinkActive="on">{{ 'Notifications' | t }}</a>
            <a class="nav" routerLink="/ci-tokens" routerLinkActive="on">{{ 'CI tokens' | t }}</a>
          }
          @if (session.isAdmin()) {
            <a class="nav" routerLink="/organisation-settings" routerLinkActive="on">{{ 'Organisation settings' | t }}</a>
            <a class="nav" routerLink="/agents" routerLinkActive="on">{{ 'Agents' | t }}</a>
          }
          @if (session.me()?.platformAdmin) { <a class="nav" routerLink="/platform" routerLinkActive="on">{{ 'Organisations' | t }}</a> }
          <span class="at-grow"></span>
          <div class="foot">
            <div class="lang" role="group" [attr.aria-label]="'Language' | t">
              <button type="button" [class.on]="i18n.lang() === 'en'" (click)="setLang('en')">English</button>
              <button type="button" [class.on]="i18n.lang() === 'ar'" (click)="setLang('ar')">العربية</button>
            </div>
          </div>
        </nav>
        <div class="main">
          <header class="top">
            <span class="at-grow"></span>
            @if (session.organization(); as org) {
              <a class="org" routerLink="/organisations">{{ org.name }}</a>
            }
            <span class="at-muted">{{ session.me()?.displayName }}</span>
            <button type="button" class="at-btn" (click)="signOut()">{{ 'Sign out' | t }}</button>
          </header>
          <main class="content" id="main" tabindex="-1"><router-outlet /></main>
        </div>
      </div>
    } @else {
      <router-outlet />
    }
  `,
  styles: [`
    .shell { display: grid; grid-template-columns: var(--at-sidebar) 1fr; min-block-size: 100vh; }
    .side { display: flex; flex-direction: column; gap: var(--at-space-1); padding: var(--at-space-4); background: var(--at-color-surface); border-inline-end: 1px solid var(--at-color-border); }
    .brand { display: flex; gap: var(--at-space-3); align-items: center; text-decoration: none; color: inherit; margin-block-end: var(--at-space-4); }
    .brand small { display: block; font-size: 11px; color: var(--at-color-muted); letter-spacing: 0.06em; text-transform: uppercase; }
    .logo { block-size: 44px; inline-size: auto; border-radius: var(--at-radius-sm); background: #ffffff; padding: 2px; }
    .nav { padding: 8px 12px; border-radius: var(--at-radius-sm); text-decoration: none; color: var(--at-color-text); }
    .nav.on { background: color-mix(in srgb, var(--at-color-primary) 12%, transparent); font-weight: 600; }
    .lang { display: flex; gap: 2px; padding: 2px; border-radius: 999px; border: 1px solid var(--at-color-border); }
    .lang button { flex: 1; border: 0; background: none; padding: 5px; border-radius: 999px; font: inherit; color: var(--at-color-muted); cursor: pointer; }
    .lang button.on { background: var(--at-color-text); color: var(--at-color-surface); }
    .top { display: flex; gap: var(--at-space-3); align-items: center; padding: var(--at-space-3) var(--at-space-6); border-block-end: 1px solid var(--at-color-border); background: var(--at-color-surface); }
    .org { font-weight: 600; text-decoration: none; }
    .skip { position: absolute; inset-inline-start: var(--at-space-3); inset-block-start: -60px; z-index: 100; padding: 8px 14px;
      background: var(--at-color-surface); border: 1px solid var(--at-color-border); border-radius: var(--at-radius-sm); }
    .skip:focus { inset-block-start: var(--at-space-3); }
    .content { padding: var(--at-space-6); max-inline-size: 1280px; }
    @media (max-width: 860px) { .shell { grid-template-columns: 1fr; } .side { flex-direction: row; flex-wrap: wrap; align-items: center; } .brand { margin: 0; } }
  `],
})
export class AppComponent {
  protected readonly i18n = inject(I18n);
  protected readonly session = inject(Session);
  private readonly auth = inject(Auth);
  private readonly router = inject(Router);
  protected readonly showShell = computed(() => this.auth.signedIn() && !!this.auth.organization() && !!this.session.me());

  setLang(l: Lang) { this.i18n.set(l); }

  protected skipToMain() { document.getElementById('main')?.focus(); }

  signOut() {
    this.auth.signOut();
    this.session.me.set(null);
    void this.router.navigate(['/sign-in']);
  }
}
