/**
 * Mobile test engine — step model (backlog §8, ADR-0009 "1.1"). A case with `engine: mobile` drives a native app
 * on a device or emulator through an Appium server; data rows, outcomes, {{templates}}, suites and reports are shared.
 *
 *   case: Sign in on the app
 *   engine: mobile
 *   steps:
 *     - type: { element: { accessibility: username }, value: "{{user.standard.username}}" }
 *     - type: { element: { accessibility: password }, value: "{{user.standard.password}}" }
 *     - tap: { accessibility: login }
 *   outcomes:
 *     success:
 *       - visible: { id: com.example:id/home_title }
 *     error:
 *       - text: { element: { accessibility: error }, equals: "{{msg.invalidCredentials}}" }
 *
 * An element is an inline locator { accessibility | id | xpath | uiautomator | predicate | classChain | text } or a
 * "page.element" of the object repository (testid → accessibility id, id, xpath and text are used as they are).
 * The app and device come from app.yml `mobile.capabilities`; the Appium server from `mobile.appiumUrl` or APPIUM_URL.
 */
import type { Step } from '../cases/model';

export const MOBILE_ACTIONS = {
  launch: { kind: 'Navigate', label: 'Open the app' },
  close: { kind: 'Navigate', label: 'Close the app' },
  back: { kind: 'Navigate', label: 'Back' },
  tap: { kind: 'Click', label: 'Tap' },
  type: { kind: 'Data entry', label: 'Type into' },
  clear: { kind: 'Data entry', label: 'Clear' },
  hideKeyboard: { kind: 'Data entry', label: 'Hide the keyboard' },
  swipe: { kind: 'Click', label: 'Swipe' },
  visible: { kind: 'Verify', label: 'Is visible' },
  hidden: { kind: 'Verify', label: 'Is NOT visible' },
  text: { kind: 'Verify', label: 'Text' },
  wait: { kind: 'Verify', label: 'Wait until visible' },
  save: { kind: 'Data entry', label: 'Save value as variable' },
  screenshot: { kind: 'Verify', label: 'Take a screenshot' },
} as const;

export type MobileAction = keyof typeof MOBILE_ACTIONS;
export const LOCATOR_KEYS = ['accessibility', 'id', 'xpath', 'uiautomator', 'predicate', 'classChain', 'text'] as const;
export type MobileLocator = string | Partial<Record<(typeof LOCATOR_KEYS)[number], string>>;
export const DIRECTIONS = ['up', 'down', 'left', 'right'] as const;

const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

/** a locator is "page.element" or an object with exactly one locator key */
export function isLocator(v: unknown): v is MobileLocator {
  if (typeof v === 'string') return /^[a-zA-Z]\w*\.[a-zA-Z]\w*$/.test(v);
  const o = obj(v);
  if (!o) return false;
  const keys = Object.keys(o).filter((k) => (LOCATOR_KEYS as readonly string[]).includes(k));
  return keys.length === 1 && typeof o[keys[0]] === 'string' && (o[keys[0]] as string).length > 0;
}

/** YAML mobile step → Step { action, mobile: body } (throws a readable error) */
export function normalizeMobileStep(raw: Record<string, unknown>, where: string): Step {
  if (!raw || typeof raw !== 'object') throw new Error(`${where}: a step must be an object like "tap: { accessibility: login }"`);
  const name = typeof raw.name === 'string' ? raw.name : undefined;
  const keys = Object.keys(raw).filter((k) => k !== 'name');
  if (keys.length !== 1) throw new Error(`${where}: a step needs exactly one action, found [${keys.join(', ')}]`);
  const action = keys[0] as MobileAction;
  if (!(action in MOBILE_ACTIONS)) throw new Error(`${where}: unknown mobile action "${action}". Use one of: ${Object.keys(MOBILE_ACTIONS).join(', ')}`);
  const body = raw[action];
  const b = obj(body);
  const need = (ok: boolean, msg: string) => { if (!ok) throw new Error(`${where}: ${msg}`); };
  const locatorMsg = 'an element: "page.element" or { accessibility | id | xpath | uiautomator | predicate | classChain | text: … }';
  const done = (mobile: Record<string, unknown>) => ({ action: action as never, name, mobile });

  switch (action) {
    case 'launch':
    case 'close':
      need(body == null || typeof body === 'string' || !!b, `"${action}" takes nothing, an app id, or { app }`);
      return done({ app: typeof body === 'string' ? body : b?.app });
    case 'back':
    case 'hideKeyboard':
      return done({});
    case 'tap':
    case 'clear':
    case 'visible':
    case 'hidden':
    case 'wait': {
      const el = b && 'element' in b ? b.element : body;
      need(isLocator(el), `"${action}" needs ${locatorMsg}`);
      return done({ element: el, timeout: b?.timeout });
    }
    case 'type':
      need(!!b && isLocator(b.element) && b.value !== undefined, `"type" needs { element, value } where element is ${locatorMsg}`);
      return done({ element: b!.element, value: String(b!.value) });
    case 'text': {
      need(!!b && isLocator(b.element), `"text" needs { element, equals | contains }`);
      const m = ['equals', 'contains'].filter((k) => k in b!);
      need(m.length === 1, '"text" needs exactly one of equals, contains');
      return done({ element: b!.element, [m[0]]: String(b![m[0]]) });
    }
    case 'swipe': {
      const direction = typeof body === 'string' ? body : b?.direction;
      need((DIRECTIONS as readonly unknown[]).includes(direction), `"swipe" needs a direction: ${DIRECTIONS.join(', ')}`);
      if (b?.element !== undefined) need(isLocator(b.element), `"swipe" element must be ${locatorMsg}`);
      return done({ direction, element: b?.element });
    }
    case 'save':
      need(!!b && isLocator(b.element) && /^\w+$/.test(String(b.as ?? '')), '"save" needs { element, as: <name> }');
      return done({ element: b!.element, as: String(b!.as) });
    case 'screenshot':
      return done({ name: typeof body === 'string' ? body : b?.name });
  }
}
