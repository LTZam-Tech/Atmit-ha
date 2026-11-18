/**
 * Request guard for the local Control Panel (backlog §13, PRD NFR-04).
 *
 * The panel binds to 127.0.0.1, but a browser on the same machine can still be made to call it:
 *   • DNS rebinding — an attacker's domain re-resolves to 127.0.0.1, so its page talks to the panel
 *     "same-origin" under the attacker's host name → blocked by the Host allowlist.
 *   • Cross-site requests — any web page can send a form POST or a fetch to http://localhost:4400
 *     → blocked by the Origin / Sec-Fetch-Site checks and by requiring a JSON body type,
 *     which a cross-site page cannot send without a CORS preflight the panel never approves.
 *
 * Not covered (by design, see docs/adr/0002-panel-request-guard.md): other processes running as the
 * same OS user. They can read the project files directly, so a token would not protect anything.
 */

export interface GuardInput {
  method: string;
  path: string;
  host?: string;
  origin?: string;
  secFetchSite?: string;
  secFetchMode?: string;
  contentType?: string;
  port: number;
}

export interface GuardRejection {
  status: 403 | 415 | 421;
  error: string;
}

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/** Host header values the panel answers to, e.g. localhost:4400 */
export const allowedHosts = (port: number) => LOCAL_HOSTS.map((h) => `${h}:${port}`);

/** Origins allowed to call the API: the panel itself */
export const allowedOrigins = (port: number) => allowedHosts(port).map((h) => `http://${h}`);

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** null = allow; otherwise the status and message to answer with */
export function checkRequest(r: GuardInput): GuardRejection | null {
  const host = (r.host ?? '').toLowerCase();
  if (!allowedHosts(r.port).includes(host)) {
    return { status: 421, error: `Unknown host "${r.host ?? ''}". Open the panel at http://localhost:${r.port}` };
  }

  const origin = r.origin?.toLowerCase();
  if (origin && origin !== 'null' && !allowedOrigins(r.port).includes(origin)) {
    return { status: 403, error: 'Cross-site request blocked' };
  }
  if (origin === 'null') return { status: 403, error: 'Cross-site request blocked' };

  const site = r.secFetchSite?.toLowerCase();
  // following a link to the panel from another site opens the page, but never runs an API call
  const pageNavigation = r.method.toUpperCase() === 'GET' && r.secFetchMode?.toLowerCase() === 'navigate' && !r.path.startsWith('/api/');
  if ((site === 'cross-site' || site === 'same-site') && !pageNavigation) {
    return { status: 403, error: 'Cross-site request blocked' };
  }

  if (UNSAFE.has(r.method.toUpperCase())) {
    // a browser always sends Origin on these methods; a page on another site cannot fake it
    if (!origin && site && site !== 'same-origin' && site !== 'none') {
      return { status: 403, error: 'Cross-site request blocked' };
    }
    const type = (r.contentType ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') {
      return { status: 415, error: 'The panel API accepts JSON requests only' };
    }
  }
  return null;
}

/** Response headers every panel answer carries */
export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN', // Run & reports frames the panel's own report pages
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
};
