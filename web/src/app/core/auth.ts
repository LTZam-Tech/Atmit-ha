import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { Router } from '@angular/router';
import { OAuthService } from 'angular-oauth2-oidc';
import { catchError, throwError } from 'rxjs';
import { environment } from '../../environments/environment';

const DEV_USER = 'atimtha-dev-user';
const ORG = 'atimtha-org';

/**
 * Who is signed in and in which organisation the UI acts (backlog §13).
 *   dev  → the platform's development login (X-Dev-User), local only
 *   oidc → the client's identity provider, authorization code flow with PKCE (angular-oauth2-oidc)
 */
@Injectable({ providedIn: 'root' })
export class Auth {
  private readonly oauth = inject(OAuthService, { optional: true });
  readonly mode = environment.auth;
  readonly devUser = signal<string | null>(read(DEV_USER));
  readonly organization = signal<string | null>(read(ORG));
  private readonly oidcReady = signal(false);

  readonly signedIn = computed(() => (this.mode === 'dev' ? !!this.devUser() : this.oidcReady() && !!this.oauth?.hasValidAccessToken()));

  /** called once at start-up (APP_INITIALIZER) */
  async init(): Promise<void> {
    if (this.mode !== 'oidc' || !this.oauth) return;
    if (!environment.oidc.issuer) { console.error('Atimtha: environment.oidc.issuer is not configured.'); return; }
    this.oauth.configure({
      issuer: environment.oidc.issuer,
      clientId: environment.oidc.clientId,
      redirectUri: window.location.origin + '/',
      responseType: 'code',
      scope: environment.oidc.scope,
      showDebugInformation: !environment.production,
    });
    await this.oauth.loadDiscoveryDocumentAndTryLogin();
    this.oauth.setupAutomaticSilentRefresh();
    this.oidcReady.set(true);
  }

  signInDev(email: string) {
    write(DEV_USER, email.trim());
    this.devUser.set(email.trim());
  }

  signInOidc() { this.oauth?.initCodeFlow(); }

  signOut() {
    write(DEV_USER, null);
    write(ORG, null);
    this.devUser.set(null);
    this.organization.set(null);
    if (this.mode === 'oidc') this.oauth?.logOut();
  }

  chooseOrganization(key: string | null) {
    write(ORG, key);
    this.organization.set(key);
  }

  /** headers for the platform API */
  headers(): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.mode === 'dev' && this.devUser()) h['X-Dev-User'] = this.devUser()!;
    if (this.mode === 'oidc' && this.oauth?.hasValidAccessToken()) h['Authorization'] = `Bearer ${this.oauth.getAccessToken()}`;
    const org = this.organization();
    if (org) h['X-Atimtha-Organization'] = org;
    return h;
  }
}

/** adds sign-in and organisation headers to platform calls; a 401 sends the user back to sign in */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(Auth);
  const router = inject(Router);
  if (!req.url.startsWith(environment.apiBase)) return next(req);
  return next(req.clone({ setHeaders: auth.headers() })).pipe(
    catchError((e: unknown) => {
      if (e instanceof HttpErrorResponse && e.status === 401) {
        auth.signOut();
        void router.navigate(['/sign-in']);
      }
      return throwError(() => e);
    }),
  );
};

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string | null) {
  try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}
