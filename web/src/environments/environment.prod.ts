/**
 * Production build: sign-in through the client's identity provider (OIDC, authorization code + PKCE).
 * The provider is set per installation at runtime, not at build time: the container writes config.js from
 * ATIMTHA_OIDC_ISSUER and ATIMTHA_OIDC_CLIENT_ID (web/docker/05-atimtha-config.envsh), loaded before the app.
 */
const runtime = (globalThis as { __ATIMTHA_CONFIG__?: { oidcIssuer?: string; oidcClientId?: string; oidcScope?: string } }).__ATIMTHA_CONFIG__ ?? {};

export const environment = {
  production: true,
  apiBase: '/api/v1',
  auth: 'oidc' as 'dev' | 'oidc',
  oidc: {
    issuer: runtime.oidcIssuer ?? '',
    clientId: runtime.oidcClientId || 'atimtha-web',
    scope: runtime.oidcScope || 'openid profile email',
  },
};
