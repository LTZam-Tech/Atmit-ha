// Small reusable UI pieces.
import { html, useState } from '/vendor/preact-htm.js';
import { store, useStore } from './core.js';
import { isRTL } from './i18n.js';

export function Field({ label, hint, children, style }) {
  return html`<label class="field" style=${style}><span class="lbl">${label}</span>${children}${hint && html`<span class="hint">${hint}</span>`}</label>`;
}

export function Modal({ title, onClose, wide, children }) {
  return html`<div class="modal open" onClick=${(e) => e.target.classList.contains('modal') && onClose?.()}>
    <div class="box ${wide ? 'wide' : ''}">
      <div class="row between"><h2 class="mtitle">${title}</h2><button class="btn sm" onClick=${onClose}>✕</button></div>
      ${children}
    </div></div>`;
}

export function Toast() {
  const s = useStore();
  return html`<div class="toast ${s.toastMsg ? 'show' : ''}">${s.toastMsg}</div>`;
}

export function Empty({ children }) {
  return html`<div class="empty">${children}</div>`;
}

export function Badge({ kind = '', children, title }) {
  return html`<span class="badge ${kind}" title=${title}>${children}</span>`;
}

export function Console({ mini }) {
  const s = useStore();
  const cls = (line) => (/✓|✔|passed/.test(line) && !/failed/.test(line) ? 'ok' : /✘|✖|failed|Error|error/.test(line) ? 'bad' : /^\s*at |^\s{4,}/.test(line) ? 'dim' : '');
  return html`<pre class="console ${mini ? 'mini' : ''}" ref=${(el) => { if (el && el.scrollTop + el.clientHeight >= el.scrollHeight - 60) el.scrollTop = el.scrollHeight; }}>${s.log.map((l) => html`<span class=${cls(l)}>${l}\n</span>`)}</pre>`;
}

export function Busy({ on, children }) {
  return on ? html`<span class="spin"></span>` : children;
}

/** Tag/comma list input */
export function useForm(initial) {
  const [v, setV] = useState(initial);
  const bind = (k, type = 'text') => type === 'checkbox'
    ? { checked: !!v[k], onChange: (e) => setV({ ...v, [k]: e.target.checked }) }
    : { value: v[k] ?? '', onInput: (e) => setV({ ...v, [k]: e.target.value }) };
  return [v, setV, bind];
}

export const isRunning = () => !!store.running;

export function NextStep({ text, to, label }) {
  return html`<div class="next"><span>${text}</span>${to && html`<a class="btn primary sm" href=${to}>${label} ${isRTL() ? '←' : '→'}</a>`}</div>`;
}
