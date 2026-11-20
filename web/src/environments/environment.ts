/** Local development (ng serve + proxy.conf.json → platform on :8080, development login). */
export const environment = {
  production: false,
  apiBase: '/api/v1',
  /** 'dev' = X-Dev-User header (platform in Development only) · 'oidc' = the client's identity provider */
  auth: 'dev' as 'dev' | 'oidc',
  oidc: {
    issuer: '',
    clientId: 'atimtha-web',
    scope: 'openid profile email',
  },
};
