export type LocalizedText = string | { en: string; ar?: string };

export interface StrategyDef {
  testid?: string;
  role?: string;
  name?: LocalizedText;
  exact?: boolean;
  label?: LocalizedText;
  placeholder?: LocalizedText;
  text?: LocalizedText;
  alt?: LocalizedText;
  title?: LocalizedText;
  id?: string;
  css?: string;
  xpath?: string;
}

export interface ElementDef extends StrategyDef {
  description?: string;
  within?: string;
  frame?: string;
  nth?: number;
  hasText?: LocalizedText;
  fallback?: StrategyDef[];
  /** classification written by the harvester (editable) */
  control?: string;
  semantic?: string;
  rules?: { required?: boolean; maxlength?: number; minlength?: number; min?: number | string; max?: number | string; pattern?: string; readonly?: boolean };
  /** date format the field expects, e.g. MM/dd/yyyy */
  format?: string;
  /** choices read from the page (dropdown options, radio / checkbox group labels) */
  options?: string[];
  /** link target (path on this site or full address) and whether it opens a new tab */
  href?: string;
  newTab?: boolean;
  /** texts seen in this message / dialog while exploring */
  messages?: string[];
}

export interface PageSettings {
  timeout?: number;
  defaultStrategy?: 'testid' | 'id' | 'css' | 'xpath';
  fallback?: boolean;
}

export interface PageDef {
  page: string;
  url?: string;
  /** url (default) = open by URL · navigate = reach through the navigation map */
  open?: 'url' | 'navigate';
  description?: string;
  readyWhen?: string;
  /** user key whose saved session is used when tests start on this page, or 'none' */
  auth?: string;
  /** tags linking tests to this page (default @<page>) */
  tags?: string[];
  settings?: PageSettings;
  elements: Record<string, string | ElementDef>;
}

/** Elements after shorthand expansion */
export interface NormalizedPageDef extends Omit<PageDef, 'elements'> {
  elements: Record<string, ElementDef>;
  file: string;
}

export const STRATEGY_KEYS = [
  'testid', 'role', 'label', 'placeholder', 'text', 'alt', 'title', 'id', 'css', 'xpath',
] as const;
export type StrategyKey = (typeof STRATEGY_KEYS)[number];

export const ELEMENT_KEYS = new Set<string>([
  ...STRATEGY_KEYS, 'name', 'exact', 'description', 'within', 'frame', 'nth', 'hasText', 'fallback', 'control', 'semantic', 'rules', 'options', 'format', 'href', 'newTab', 'messages',
]);
