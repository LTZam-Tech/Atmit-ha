import { Component, OnInit, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Auth } from '../core/auth';
import { Session } from '../core/session';
import { TranslatePipe } from '../core/i18n';
import { LoadingState } from '../core/states';

@Component({
  selector: 'at-organisations',
  standalone: true,
  imports: [TranslatePipe, LoadingState, RouterLink],
  template: `
    <div class="wrap">
      <div class="at-card box at-stack">
        <h1>{{ 'Choose an organisation' | t }}</h1>
        @if (session.me(); as me) {
          @if (me.organizations.length === 0 && !me.platformAdmin) {
            <p class="at-alert info">{{ 'Your account has no organisation yet. Ask an administrator to invite you.' | t }}</p>
          }
          @for (org of me.organizations; track org.key) {
            <button type="button" class="at-btn org" (click)="choose(org.key)">
              <b>{{ org.name }}</b><span class="at-muted mono">{{ org.roles.join(', ') }}</span>
            </button>
          }
          @if (me.platformAdmin) {
            <a class="at-btn" routerLink="/platform">{{ 'Manage organisations' | t }}</a>
          }
        } @else {
          <at-loading />
        }
      </div>
    </div>
  `,
  styles: [`
    .wrap { min-block-size: 100vh; display: grid; place-items: center; padding: var(--at-space-6); }
    .box { inline-size: min(460px, 100%); }
    .org { inline-size: 100%; justify-content: space-between; }
  `],
})
export class OrganisationsPage implements OnInit {
  protected readonly session = inject(Session);
  private readonly auth = inject(Auth);
  private readonly router = inject(Router);

  async ngOnInit() {
    if (!this.auth.signedIn()) { await this.router.navigate(['/sign-in']); return; }
    if (!this.session.me()) await this.session.load();
  }

  async choose(key: string) {
    this.auth.chooseOrganization(key);
    await this.router.navigate(['/workspaces']);
  }
}
