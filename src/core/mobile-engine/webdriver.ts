/**
 * Minimal W3C WebDriver client for an Appium server (the protocol Appium speaks), on plain fetch: no extra
 * dependency in the framework or the agent image. Only what the mobile engine needs.
 */
const ELEMENT = 'element-6066-11e4-a52f-4f735466cecf';

export interface Rect { x: number; y: number; width: number; height: number }

export class WebDriverError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export class WebDriver {
  private constructor(private readonly base: string, readonly sessionId: string) {}

  /** a new session: Appium installs/starts the app the capabilities name */
  static async create(serverUrl: string, capabilities: Record<string, unknown>): Promise<WebDriver> {
    const base = serverUrl.replace(/\/+$/, '');
    const value = await call(base, 'POST', '/session', { capabilities: { alwaysMatch: capabilities, firstMatch: [{}] } }) as { sessionId?: string };
    if (!value?.sessionId) throw new WebDriverError('session not created', 'The Appium server did not return a session id');
    return new WebDriver(base, value.sessionId);
  }

  private s(path: string) { return `/session/${this.sessionId}${path}`; }

  async find(using: string, value: string): Promise<string | undefined> {
    try {
      const el = await call(this.base, 'POST', this.s('/element'), { using, value }) as Record<string, string>;
      return el?.[ELEMENT] ?? el?.ELEMENT;
    } catch (e) {
      if (e instanceof WebDriverError && e.code === 'no such element') return undefined;
      throw e;
    }
  }

  async click(id: string) { await call(this.base, 'POST', this.s(`/element/${id}/click`), {}); }
  async type(id: string, text: string) { await call(this.base, 'POST', this.s(`/element/${id}/value`), { text, value: [...text] }); }
  async clear(id: string) { await call(this.base, 'POST', this.s(`/element/${id}/clear`), {}); }
  async text(id: string): Promise<string> { return String(await call(this.base, 'GET', this.s(`/element/${id}/text`)) ?? ''); }
  async displayed(id: string): Promise<boolean> { return (await call(this.base, 'GET', this.s(`/element/${id}/displayed`))) === true; }
  async rect(id?: string): Promise<Rect> { return await call(this.base, 'GET', id ? this.s(`/element/${id}/rect`) : this.s('/window/rect')) as Rect; }
  async back() { await call(this.base, 'POST', this.s('/back'), {}); }
  async screenshot(): Promise<Buffer> { return Buffer.from(String(await call(this.base, 'GET', this.s('/screenshot'))), 'base64'); }
  async hideKeyboard() { await call(this.base, 'POST', this.s('/appium/device/hide_keyboard'), {}).catch(() => undefined); }
  async activateApp(appId: string) { await call(this.base, 'POST', this.s('/appium/device/activate_app'), { appId, bundleId: appId }); }
  async terminateApp(appId: string) { await call(this.base, 'POST', this.s('/appium/device/terminate_app'), { appId, bundleId: appId }); }

  /** a straight finger swipe from one point to another (W3C actions) */
  async swipe(from: { x: number; y: number }, to: { x: number; y: number }) {
    await call(this.base, 'POST', this.s('/actions'), {
      actions: [{
        type: 'pointer', id: 'finger', parameters: { pointerType: 'touch' },
        actions: [
          { type: 'pointerMove', duration: 0, x: Math.round(from.x), y: Math.round(from.y) },
          { type: 'pointerDown', button: 0 },
          { type: 'pause', duration: 150 },
          { type: 'pointerMove', duration: 400, x: Math.round(to.x), y: Math.round(to.y) },
          { type: 'pointerUp', button: 0 },
        ],
      }],
    });
    await call(this.base, 'DELETE', this.s('/actions')).catch(() => undefined);
  }

  async quit() { await call(this.base, 'DELETE', this.s('')).catch(() => undefined); }
}

async function call(base: string, method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: { value?: unknown } = {};
  try { json = text ? JSON.parse(text) : {}; } catch { /* non-JSON error page */ }
  const value = json.value as { error?: string; message?: string } | undefined;
  if (!res.ok || (value && typeof value === 'object' && 'error' in value && value.error)) {
    throw new WebDriverError(value?.error ?? `HTTP ${res.status}`, `Appium: ${value?.message ?? text.slice(0, 300) ?? res.statusText}`);
  }
  return json.value;
}
