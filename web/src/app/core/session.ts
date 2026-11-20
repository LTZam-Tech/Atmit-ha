import { Injectable, computed, inject, signal } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { Api, problemText } from './api';
import { Auth } from './auth';
import type { Me } from './models';

/** The signed-in user's profile and organisations (/api/v1/me). */
@Injectable({ providedIn: 'root' })
export class Session {
  private readonly api = inject(Api);
  private readonly auth = inject(Auth);
  readonly me = signal<Me | null>(null);
  readonly error = signal<string | null>(null);
  readonly organization = computed(() => this.me()?.organizations.find((o) => o.key === this.auth.organization()) ?? null);
  /** what the person may do in the chosen organisation; org.admin includes everything (as in AccessService) */
  readonly permissions = computed(() => new Set(this.organization()?.permissions ?? []));
  /** org-admin sees administration screens (the API enforces it anyway) */
  readonly isAdmin = computed(() => this.permissions().has('org.admin') || (this.organization()?.roles.includes('org-admin') ?? false));
  /** edits test assets and project settings (project.edit); kept for older screens */
  readonly isLead = computed(() => this.can('project.edit'));

  /** buttons and screens follow permissions; every API call still checks them */
  can(permission: string): boolean {
    return this.isAdmin() || this.permissions().has(permission);
  }

  async load(): Promise<Me | null> {
    try {
      const me = await firstValueFrom(this.api.me());
      this.me.set(me);
      this.error.set(null);
      // keep the chosen organisation if it is still one of mine, else the only one, else none
      const chosen = this.auth.organization();
      if (!me.organizations.some((o) => o.key === chosen)) this.auth.chooseOrganization(me.organizations.length === 1 ? me.organizations[0].key : null);
      return me;
    } catch (e) {
      this.me.set(null);
      this.error.set(problemText(e));
      return null;
    }
  }
}

/** pages behind sign-in and a chosen organisation */
export const signedInGuard: CanActivateFn = async () => {
  const auth = inject(Auth);
  const session = inject(Session);
  const router = inject(Router);
  if (!auth.signedIn()) return router.parseUrl('/sign-in');
  if (!session.me()) await session.load();
  if (!session.me()) return router.parseUrl('/sign-in');
  if (!auth.organization()) return router.parseUrl('/organisations');
  return true;
};

/** platform administration needs no organisation: on a new installation there is none yet */
export const platformGuard: CanActivateFn = async () => {
  const auth = inject(Auth);
  const session = inject(Session);
  const router = inject(Router);
  if (!auth.signedIn()) return router.parseUrl('/sign-in');
  if (!session.me()) await session.load();
  if (!session.me()) return router.parseUrl('/sign-in');
  return session.me()?.platformAdmin ? true : router.parseUrl('/organisations');
};
