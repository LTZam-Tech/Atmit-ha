// Injected into every page while recording (plain JS, runs in the browser).
// Captures clicks, typing, selects, checkboxes and Enter, plus the floating toolbar actions,
// and reports them to the recorder through window.__qaRecord(event).
(() => {
  if (window.top !== window || window.__qaRecInstalled) return;
  window.__qaRecInstalled = true;
  const ATTR = '__TESTID_ATTR__';
  let mode = null; // null | 'check' | 'save'
  let saveAs = '';
  let count = 0;

  const send = (ev) => {
    try {
      const p = window.__qaRecord && window.__qaRecord({ ...ev, url: location.href, ts: Date.now() });
      if (p && p.then) p.then((n) => { count = n; status(); });
    } catch (e) { /* recorder gone */ }
  };

  // ---------- element description (same fields as the harvester)
  const roleOf = (el) => {
    const explicit = el.getAttribute('role'); if (explicit) return explicit;
    const t = el.tagName.toLowerCase(), type = (el.getAttribute('type') || '').toLowerCase();
    if (t === 'button' || (t === 'input' && ['submit', 'button', 'reset'].includes(type))) return 'button';
    if (t === 'a') return 'link';
    if (t === 'select') return 'combobox';
    if (t === 'textarea' || (t === 'input' && ['', 'text', 'email', 'search', 'tel', 'url', 'number'].includes(type))) return 'textbox';
    if (t === 'input' && type === 'checkbox') return 'checkbox';
    if (t === 'input' && type === 'radio') return 'radio';
    if (/^h[1-6]$/.test(t)) return 'heading';
    return '';
  };
  const labelOf = (el) => {
    const id = el.getAttribute('id');
    const byFor = id ? document.querySelector('label[for="' + CSS.escape(id) + '"]') : null;
    const wrap = el.closest('label');
    return ((byFor && byFor.textContent) || (wrap && wrap.textContent) || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ');
  };
  const xpathOf = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.body; n = n.parentElement) {
      const sib = [...(n.parentElement ? n.parentElement.children : [])].filter((s) => s.tagName === n.tagName);
      parts.unshift(n.tagName.toLowerCase() + (sib.length > 1 ? '[' + (sib.indexOf(n) + 1) + ']' : ''));
    }
    return '//body/' + parts.join('/');
  };
  const cssOf = (el) => {
    const t = el.tagName.toLowerCase();
    const name = el.getAttribute('name'); if (name) return t + '[name="' + name + '"]';
    const type = el.getAttribute('type');
    const cls = [...el.classList].filter((c) => !/\d{3,}|^(active|hover|focus)/.test(c)).slice(0, 2);
    return t + (type ? '[type="' + type + '"]' : '') + cls.map((c) => '.' + CSS.escape(c)).join('');
  };
  const describe = (el) => {
    const text = (el.innerText || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    const label = labelOf(el);
    const id = el.getAttribute('id') || undefined;
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName.toLowerCase(), type: (el.getAttribute('type') || '').toLowerCase(), role: roleOf(el),
      name: label || text || el.getAttribute('title') || el.getAttribute('placeholder') || '',
      testid: el.getAttribute(ATTR) || undefined,
      id: id && !/\d{4,}|[a-f0-9]{8,}|^:r/.test(id) ? id : undefined,
      label: label || undefined, placeholder: el.getAttribute('placeholder') || undefined, text: text || undefined,
      css: cssOf(el), xpath: xpathOf(el),
      hint: el.getAttribute(ATTR) || el.getAttribute('name') || id || label || el.getAttribute('placeholder') || text || el.tagName.toLowerCase(),
      inForm: !!el.closest('form'), formIndex: -1,
      attrName: el.getAttribute('name') || undefined, autocomplete: el.getAttribute('autocomplete') || undefined,
      required: el.hasAttribute('required'), maxlength: el.maxLength > 0 ? el.maxLength : undefined, minlength: el.minLength > 0 ? el.minLength : undefined,
      min: el.getAttribute('min') || undefined, max: el.getAttribute('max') || undefined, pattern: el.getAttribute('pattern') || undefined,
      box: { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) },
    };
  };

  const CLICKABLE = 'button,a[href],input[type=submit],input[type=button],input[type=reset],[role=button],[role=link],[role=tab],[role=menuitem],[role=option],summary,label';
  const isToolbar = (e) => e.composedPath().some((n) => n === host);
  const pickTarget = (el) => {
    if (el.hasAttribute && el.hasAttribute(ATTR)) return el;
    if (el.parentElement && el.parentElement.hasAttribute(ATTR) && el.parentElement.children.length === 1) return el.parentElement;
    return el.closest('button,a,input,select,textarea,[role],h1,h2,h3,h4,h5,label,td,th,li,b,strong,em,i,small,code,span,p,div') || el;
  };

  // ---------- events
  document.addEventListener('click', (e) => {
    if (isToolbar(e)) return;
    if (mode) {
      e.preventDefault(); e.stopPropagation();
      const el = pickTarget(e.target);
      const text = (el.innerText || el.value || '').trim().replace(/\s+/g, ' ');
      send(mode === 'check' ? { type: 'verify', el: describe(el), text } : { type: 'save', el: describe(el), as: saveAs, text });
      setMode(null);
      return;
    }
    const el = e.target.closest(CLICKABLE);
    if (!el) return;
    if (el.matches('input[type=checkbox],input[type=radio]')) return; // recorded on change
    if (el.tagName === 'LABEL' && el.control) return;                   // focuses / toggles its control
    send({ type: 'click', el: describe(el) });
  }, true);

  document.addEventListener('change', (e) => {
    const el = e.target;
    if (!el || isToolbar(e) || !el.matches) return;
    if (el.matches('input[type=checkbox],input[type=radio]')) {
      const opt = ((el.labels && el.labels[0] && el.labels[0].textContent) || el.value || '').trim().replace(/\s+/g, ' ');
      const siblings = el.name ? document.querySelectorAll('input[type="' + el.type + '"][name="' + CSS.escape(el.name) + '"]').length : 1;
      if (el.type === 'radio' && el.name) send({ type: 'choose', el: describe(el), group: el.name, option: opt });
      else if (el.type === 'checkbox' && siblings > 1) send({ type: el.checked ? 'tickgroup' : 'untickgroup', el: describe(el), group: el.name, option: opt });
      else send({ type: el.checked ? 'tick' : 'untick', el: describe(el) });
    }
    else if (el.tagName === 'SELECT') send({ type: 'select', el: describe(el), value: (el.selectedOptions[0] && el.selectedOptions[0].text.trim()) || el.value });
    else if (el.matches('input,textarea')) send({ type: 'fill', el: describe(el), value: el.value, secret: el.type === 'password' });
  }, true);

  document.addEventListener('keydown', (e) => {
    const el = e.target;
    if (e.key !== 'Enter' || isToolbar(e) || !el.matches || !el.matches('input:not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button])')) return;
    send({ type: 'fill', el: describe(el), value: el.value, secret: el.type === 'password' });
    send({ type: 'press', el: describe(el), value: 'Enter' });
  }, true);

  // ---------- floating toolbar
  let host, statusEl, overlay;
  const setMode = (m) => {
    mode = m;
    document.documentElement.style.cursor = m ? 'crosshair' : '';
    if (overlay) overlay.style.display = m ? 'block' : 'none';
    status();
  };
  const status = () => {
    if (!statusEl) return;
    statusEl.textContent = mode === 'check' ? 'Click the element to check…' : mode === 'save' ? `Click the element to save as {{var.${saveAs}}}…` : `● Recording · ${count} step(s)`;
  };
  document.addEventListener('mousemove', (e) => {
    if (!mode || !overlay || isToolbar(e)) return;
    const r = pickTarget(e.target).getBoundingClientRect();
    Object.assign(overlay.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
  }, true);

  const mount = () => {
    if (!document.body || host) return;
    host = document.createElement('div');
    host.style.cssText = 'position:fixed;z-index:2147483647;bottom:16px;right:16px;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      .bar{font:13px system-ui,Segoe UI,Tahoma,sans-serif;background:#16161a;color:#fff;border-radius:12px;padding:8px;display:flex;gap:6px;align-items:center;box-shadow:0 8px 30px #0006}
      button{font:inherit;border:0;border-radius:8px;padding:7px 10px;cursor:pointer;background:#2e2e33;color:#fff}
      button:hover{background:#3d3d44} .stop{background:#d03b3b} .stop:hover{background:#e34948}
      .st{padding:0 8px;color:#6fdc6f;white-space:nowrap}
      .ask{display:none;gap:6px;align-items:center} .ask.on{display:flex}
      .ask input{font:inherit;border:0;border-radius:6px;padding:6px 8px;width:160px}
    </style>
    <div class="bar"><span class="st"></span>
      <button data-a="check" title="Add a check: click an element whose text/visibility must be verified">✓ Check</button>
      <button data-a="save" title="Save a value from the page (e.g. an order number) for later steps">💾 Save value</button>
      <button data-a="name" title="Give the current page a name">🏷 Name page</button>
      <button data-a="stop" class="stop">■ Stop</button>
      <span class="ask"><span class="q"></span><input /><button data-a="ok">OK</button><button data-a="cancel">✕</button></span></div>`;
    statusEl = root.querySelector('.st');
    // inline question instead of prompt() (browser dialogs are not available while recording)
    const askBox = root.querySelector('.ask'), askInput = askBox.querySelector('input');
    let onAnswer = null;
    const ask = (q, def, valid, cb) => { askBox.querySelector('.q').textContent = q; askInput.value = def; askBox.classList.add('on'); askInput.focus(); askInput.select(); onAnswer = (v) => { if (valid.test(v)) { askBox.classList.remove('on'); cb(v); } else askInput.style.outline = '2px solid #e34948'; }; };
    askInput.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') onAnswer && onAnswer(askInput.value.trim()); if (e.key === 'Escape') askBox.classList.remove('on'); });
    root.addEventListener('click', (e) => {
      const a = e.target.closest('button') && e.target.closest('button').dataset.a;
      if (a === 'check') setMode(mode === 'check' ? null : 'check');
      if (a === 'save') ask('Value name', 'value' + (count + 1), /^\w+$/, (n) => { saveAs = n; setMode('save'); });
      if (a === 'name') ask('Page name', '', /^[a-z][a-zA-Z0-9]*$/, (n) => send({ type: 'pageName', name: n }));
      if (a === 'ok') onAnswer && onAnswer(askInput.value.trim());
      if (a === 'cancel') askBox.classList.remove('on');
      if (a === 'stop') { send({ type: 'stop' }); statusEl.textContent = 'Saving…'; }
    });
    overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #e34948;background:#e3494822;border-radius:3px;display:none';
    document.documentElement.appendChild(overlay);
    document.documentElement.appendChild(host);
    status();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
