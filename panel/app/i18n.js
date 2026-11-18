// atimtha — interface language (English / العربية).
// Two layers:
//  1. t('English text', {vars}) — used by the shell and new screens.
//  2. A DOM translator for the rest of the panel: every visible text node and the
//     placeholder / title / aria-label attributes are looked up in the dictionary
//     (exact text, then text without leading icons / trailing arrows, then patterns).
//     Typed values (inputs, textareas), code, element keys and the console are never touched.
import { AR, AR_PATTERNS } from './i18n-ar.js';

const KEY = 'atimtha-lang';
export const LANGS = { en: { name: 'English', dir: 'ltr' }, ar: { name: 'العربية', dir: 'rtl' } };

export function getLang() {
  try { const l = localStorage.getItem(KEY); if (l && LANGS[l]) return l; } catch { /* storage unavailable */ }
  return (navigator.language || '').startsWith('ar') ? 'ar' : 'en';
}
let lang = getLang();
const listeners = new Set();
export const onLang = (f) => { listeners.add(f); return () => listeners.delete(f); };

export function setLang(l) {
  if (!LANGS[l] || l === lang) return;
  lang = l;
  try { localStorage.setItem(KEY, l); } catch { /* storage unavailable */ }
  applyDocument();
  // reload is the simplest way to give every text node back its English source before re-translating
  if (l === 'en') { location.reload(); return; }
  translateTree(document.body);
  listeners.forEach((f) => f(l));
}
export const currentLang = () => lang;
export const isRTL = () => LANGS[lang].dir === 'rtl';

function applyDocument() {
  document.documentElement.lang = lang;
  document.documentElement.dir = LANGS[lang].dir;
}

const fill = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? '')) : s);

/** translate one English UI string (with {var} placeholders) */
export function t(en, vars) {
  if (lang === 'en') return fill(en, vars);
  return fill(lookup(en) ?? en, vars);
}

// ------------------------------------------------------------------ lookup
const LEAD = /^([^\p{L}\p{N}{(]*)/u;           // icons / arrows / bullets before the words
const TRAIL = /([\s→↗…:.!✔]*)$/u;               // arrows, dots, colons after the words
function lookup(text) {
  if (AR[text] !== undefined) return AR[text];
  const lead = text.match(LEAD)[1];
  const rest = text.slice(lead.length);
  const trail = rest.match(TRAIL)[1];
  const core = rest.slice(0, rest.length - trail.length);
  if (core && AR[core] !== undefined) return lead + AR[core] + flipTrail(trail);
  for (const [re, out] of AR_PATTERNS) {
    const m = core.match(re) || text.match(re);
    if (m) return (m.input === core ? lead : '') + (typeof out === 'function' ? out(...m) : core.replace(re, out)) + (m.input === core ? flipTrail(trail) : '');
  }
  return undefined;
}
const flipTrail = (s) => s.replace(/→/g, '←');

// ------------------------------------------------------------------ DOM translator
const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE', 'OPTION_VALUE']);
const ATTRS = ['placeholder', 'title', 'aria-label'];
const done = new WeakMap(); // node -> translated text we wrote (so our own writes are ignored)

function skipEl(el) {
  for (let e = el; e && e !== document.body; e = e.parentElement) {
    if (SKIP.has(e.tagName) || e.classList?.contains('mono') || e.classList?.contains('code') || e.classList?.contains('console') || e.hasAttribute?.('data-noi18n')) return true;
  }
  return false;
}

function translateText(node) {
  const raw = node.data;
  if (done.get(node) === raw) return;
  const trimmed = raw.trim();
  if (!trimmed || !/\p{L}/u.test(trimmed) || /[؀-ۿ]/.test(trimmed)) return;
  if (skipEl(node.parentElement)) return;
  const tr = lookup(trimmed);
  if (tr === undefined) { (window.__missing ??= new Set()).add(trimmed); return; }
  const out = raw.replace(trimmed, tr);
  done.set(node, out);
  node.data = out;
}

function translateAttrs(el) {
  if (skipEl(el)) return;
  for (const a of ATTRS) {
    const v = el.getAttribute(a);
    if (!v || /[؀-ۿ]/.test(v)) continue;
    const tr = lookup(v.trim());
    if (tr !== undefined) el.setAttribute(a, tr);
  }
}

export function translateTree(root) {
  if (lang === 'en' || !root) return;
  if (root.nodeType === 3) return translateText(root);
  if (root.nodeType !== 1) return;
  translateAttrs(root);
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = w.nextNode(); n; n = w.nextNode()) (n.nodeType === 3 ? translateText(n) : translateAttrs(n));
}

export function startTranslator() {
  applyDocument();
  const obs = new MutationObserver((muts) => {
    if (lang === 'en') return;
    for (const m of muts) {
      if (m.type === 'characterData') translateText(m.target);
      else if (m.type === 'attributes') translateAttrs(m.target);
      else m.addedNodes.forEach(translateTree);
    }
  });
  obs.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  translateTree(document.body);
}
