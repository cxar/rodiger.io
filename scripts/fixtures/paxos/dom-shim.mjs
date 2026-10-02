// A small DOM for running pages/paxos/app.js under node:vm in the offline checks (check-paxos-page.mjs).
// It implements what the page uses (elements, text, attributes, events with bubbling and default actions
// for <summary> and same-page links, selectors with compound parts, descendant/child/sibling
// combinators, :not() and a few structural pseudo-classes), a virtual clock, a controllable fetch, an
// optional Cache Storage stub and a recording Chart.js stub that checks every chart config against the
// dataviz rules. Anything it does not implement fails loudly with its name instead of passing silently.
import vm from 'node:vm';

const HTML_NS = 'http://www.w3.org/1999/xhtml';
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

export class ShimNode {
  constructor(doc) { this.ownerDocument = doc; this.parentNode = null; this.childNodes = []; this._listeners = {}; }
  get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get nextSibling() { const s = this.parentNode ? this.parentNode.childNodes : []; return s[s.indexOf(this) + 1] || null; }
  get previousSibling() { const s = this.parentNode ? this.parentNode.childNodes : []; const i = s.indexOf(this); return i > 0 ? s[i - 1] : null; }
  get nextElementSibling() { for (let n = this.nextSibling; n; n = n.nextSibling) if (n.nodeType === 1) return n; return null; }
  get previousElementSibling() { for (let n = this.previousSibling; n; n = n.previousSibling) if (n.nodeType === 1) return n; return null; }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n.nodeType === 9; }
  get textContent() { return this.childNodes.map((c) => (c.nodeType === 8 ? '' : c.textContent)).join(''); }
  set textContent(s) { this.replaceChildren(); if (s !== null && s !== undefined && s !== '') this.appendChild(this.ownerDocument.createTextNode(String(s))); }
  _take(n) {
    if (!(n instanceof ShimNode)) throw new TypeError(`DOM shim: not a Node (${typeof n})`);
    if (n.nodeType === 11) { const kids = n.childNodes; n.childNodes = []; return kids; }
    for (let x = this; x; x = x.parentNode) if (x === n) throw new Error('DOM shim: HierarchyRequestError');
    if (n.parentNode) n.parentNode.removeChild(n);
    return [n];
  }
  appendChild(n) { for (const c of this._take(n)) { c.parentNode = this; this.childNodes.push(c); } return n; }
  insertBefore(n, ref) {
    if (!ref) return this.appendChild(n);
    const kids = this._take(n);
    let i = this.childNodes.indexOf(ref);
    if (i < 0) throw new Error('DOM shim: insertBefore reference is not a child');
    for (const c of kids) { c.parentNode = this; this.childNodes.splice(i++, 0, c); }
    return n;
  }
  removeChild(n) { const i = this.childNodes.indexOf(n); if (i < 0) throw new Error('DOM shim: removeChild of a non-child'); this.childNodes.splice(i, 1); n.parentNode = null; return n; }
  replaceChild(n, old) { this.insertBefore(n, old); return this.removeChild(old); }
  _node(x) { return x instanceof ShimNode ? x : this.ownerDocument.createTextNode(String(x)); }
  append(...xs) { for (const x of xs) this.appendChild(this._node(x)); }
  prepend(...xs) { const ref = this.firstChild; for (const x of xs) this.insertBefore(this._node(x), ref); }
  replaceChildren(...xs) { for (const c of this.childNodes) c.parentNode = null; this.childNodes = []; this.append(...xs); }
  before(...xs) { for (const x of xs) this.parentNode.insertBefore(this._node(x), this); }
  after(...xs) { const ref = this.nextSibling; for (const x of xs) this.parentNode.insertBefore(this._node(x), ref); }
  replaceWith(...xs) { const p = this.parentNode; if (!p) return; const ref = this.nextSibling; p.removeChild(this); for (const x of xs) p.insertBefore(this._node(x), ref); }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  hasChildNodes() { return this.childNodes.length > 0; }
  cloneNode(deep) {
    const c = this.nodeType === 1 ? this.ownerDocument.createElementNS(this.namespaceURI, this.localName) : this.nodeType === 11 ? this.ownerDocument.createDocumentFragment() : new ShimText(this.ownerDocument, this.data, this.nodeType);
    if (this.nodeType === 1) for (const [k, v] of this._attrs) c._attrs.set(k, v);
    if (deep) for (const k of this.childNodes) c.appendChild(k.cloneNode(true));
    return c;
  }
  addEventListener(type, fn, opts) { if (typeof fn === 'function' || (fn && fn.handleEvent)) (this._listeners[type] ||= []).push({ fn, capture: !!(opts === true || (opts && opts.capture)), once: !!(opts && opts.once) }); }
  removeEventListener(type, fn) { if (this._listeners[type]) this._listeners[type] = this._listeners[type].filter((l) => l.fn !== fn); }
  dispatchEvent(ev) { return dispatchShimEvent(this, ev); }
  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() { return this.children.at(-1) || null; }
  get childElementCount() { return this.children.length; }
  querySelectorAll(sel) { const m = compileSelector(sel), out = []; const walk = (n) => { for (const c of n.childNodes) if (c.nodeType === 1) { if (m(c, this)) out.push(c); walk(c); } }; walk(this); return out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  getElementsByTagName(tag) { return this.querySelectorAll(tag); }
  getElementsByClassName(c) { return this.querySelectorAll('.' + String(c).trim().split(/\s+/).join('.')); }
}
export class ShimText extends ShimNode {
  constructor(doc, s, type = 3) { super(doc); this.nodeType = type; this.data = String(s); }
  get textContent() { return this.data; }
  set textContent(s) { this.data = String(s); }
  get nodeValue() { return this.data; }
  set nodeValue(s) { this.data = String(s); }
}
const REFLECT = ['id', 'title', 'type', 'href', 'src', 'name', 'role', 'lang', 'dir', 'rel', 'scope', 'placeholder', 'htmlFor:for', 'colSpan:colspan', 'rowSpan:rowspan'];
const BOOL = ['hidden', 'disabled', 'checked', 'selected', 'inert'];
const ARIA = ['ariaLabel', 'ariaHidden', 'ariaPressed', 'ariaSelected', 'ariaExpanded', 'ariaControls', 'ariaCurrent', 'ariaDisabled', 'ariaLive', 'ariaDescribedBy', 'ariaLabelledBy'];
export class ShimElement extends ShimNode {
  constructor(doc, tag, ns = HTML_NS) {
    super(doc);
    this.nodeType = 1;
    this.namespaceURI = ns;
    this.localName = ns === HTML_NS ? String(tag).toLowerCase() : String(tag);
    this._attrs = new Map();
    const style = {};
    Object.defineProperties(style, {
      setProperty: { value: (k, v) => { style[k] = String(v); } },
      removeProperty: { value: (k) => { delete style[k]; } },
      getPropertyValue: { value: (k) => style[k] || '' },
      cssText: { get: () => { throw new Error('DOM shim: style.cssText (the CSP blocks style attributes; use CSSOM properties)'); }, set: () => { throw new Error('DOM shim: style.cssText (the CSP blocks style attributes)'); } },
    });
    this.style = style;
  }
  get tagName() { return this.namespaceURI === HTML_NS ? this.localName.toUpperCase() : this.localName; }
  get nodeName() { return this.tagName; }
  _k(k) { return this.namespaceURI === HTML_NS ? String(k).toLowerCase() : String(k); }
  setAttribute(k, v) {
    if (this._k(k) === 'style') throw new Error('DOM shim: setAttribute("style") (style-src \'self\' blocks style attributes)');
    if (/^on/i.test(k)) throw new Error(`DOM shim: inline handler attribute ${k} (the CSP blocks it)`);
    this._attrs.set(this._k(k), String(v));
  }
  getAttribute(k) { const x = this._attrs.get(this._k(k)); return x === undefined ? null : x; }
  removeAttribute(k) { this._attrs.delete(this._k(k)); }
  hasAttribute(k) { return this._attrs.has(this._k(k)); }
  toggleAttribute(k, force) { const on = force === undefined ? !this.hasAttribute(k) : !!force; if (on) this._attrs.set(this._k(k), ''); else this.removeAttribute(k); return on; }
  getAttributeNames() { return [...this._attrs.keys()]; }
  get attributes() { return [...this._attrs].map(([name, value]) => ({ name, value })); }
  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this._attrs.set('class', String(v)); }
  get classList() {
    const get = () => this.className.split(/\s+/).filter(Boolean), put = (xs) => this._attrs.set('class', [...new Set(xs)].join(' '));
    return {
      add: (...c) => put([...get(), ...c]), remove: (...c) => put(get().filter((x) => !c.includes(x))), contains: (c) => get().includes(c),
      toggle: (c, force) => { const on = force === undefined ? !get().includes(c) : !!force; put(on ? [...get(), c] : get().filter((x) => x !== c)); return on; },
      replace: (a, b) => put(get().map((x) => (x === a ? b : x))), get length() { return get().length; }, item: (i) => get()[i] || null, [Symbol.iterator]: () => get()[Symbol.iterator](),
    };
  }
  get dataset() {
    const attr = (k) => 'data-' + String(k).replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
    return new Proxy({}, {
      get: (_, k) => (typeof k === 'string' ? (this.hasAttribute(attr(k)) ? this.getAttribute(attr(k)) : undefined) : undefined),
      set: (_, k, val) => { this._attrs.set(attr(k), String(val)); return true; },
      has: (_, k) => this.hasAttribute(attr(k)),
      deleteProperty: (_, k) => { this.removeAttribute(attr(k)); return true; },
      ownKeys: () => this.getAttributeNames().filter((n) => n.startsWith('data-')).map((n) => n.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())),
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    });
  }
  get tabIndex() { const x = this.getAttribute('tabindex'); return x === null ? (/^(a|button|input|select|textarea|summary)$/.test(this.localName) ? 0 : -1) : Number(x); }
  set tabIndex(v) { this._attrs.set('tabindex', String(v)); }
  get open() { return this.hasAttribute('open'); }
  set open(v) {
    const was = this.hasAttribute('open');
    this.toggleAttribute('open', !!v);
    if (was !== !!v && this.localName === 'details') this.ownerDocument._win.setTimeout(() => dispatchShimEvent(this, shimEvent('toggle', { bubbles: false })), 0);
  }
  get value() { return this._value !== undefined ? this._value : this.getAttribute('value') || ''; }
  set value(v) { this._value = String(v); }
  get innerText() { return this.textContent; }
  set innerText(s) { this.textContent = s; }
  get innerHTML() { throw new Error('DOM shim: innerHTML (text goes through textContent)'); }
  set innerHTML(_) { throw new Error('DOM shim: innerHTML (text goes through textContent)'); }
  insertAdjacentHTML() { throw new Error('DOM shim: insertAdjacentHTML'); }
  insertAdjacentElement(pos, el) {
    if (pos === 'beforebegin') this.before(el); else if (pos === 'afterbegin') this.prepend(el); else if (pos === 'beforeend') this.append(el); else if (pos === 'afterend') this.after(el); else throw new Error('DOM shim: insertAdjacentElement ' + pos);
    return el;
  }
  matches(sel) { return compileSelector(sel)(this, this.ownerDocument); }
  closest(sel) { const m = compileSelector(sel); for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (m(n, this.ownerDocument)) return n; return null; }
  focus() {
    const doc = this.ownerDocument, prev = doc.activeElement;
    if (prev === this) return;
    doc.activeElement = this;
    if (prev && prev.nodeType === 1) { dispatchShimEvent(prev, shimEvent('blur', { bubbles: false })); dispatchShimEvent(prev, shimEvent('focusout')); }
    dispatchShimEvent(this, shimEvent('focus', { bubbles: false }));
    dispatchShimEvent(this, shimEvent('focusin'));
  }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  click() { dispatchShimEvent(this, shimEvent('click')); }
  scrollIntoView() {}
  scrollTo() {}
  scrollBy() {}
  animate() { return { finished: Promise.resolve(), cancel() {}, onfinish: null }; }
  getBoundingClientRect() { return { x: 0, y: 0, top: 0, left: 0, width: 800, height: 300, right: 800, bottom: 300 }; }
  getClientRects() { return [this.getBoundingClientRect()]; }
  get offsetWidth() { return 800; } get offsetHeight() { return 300; } get clientWidth() { return 800; } get clientHeight() { return 300; }
  get scrollWidth() { return 800; } get scrollHeight() { return 300; } get offsetParent() { return this.parentElement; } get offsetTop() { return 0; } get offsetLeft() { return 0; }
  get scrollTop() { return 0; } set scrollTop(_) {} get scrollLeft() { return 0; } set scrollLeft(_) {}
  getContext() { return new Proxy({ measureText: (s) => ({ width: String(s).length * 6 }) }, { get: (o, k) => (k in o ? o[k] : () => {}) }); }
}
for (const spec of REFLECT) {
  const [prop, attr = prop] = spec.split(':');
  Object.defineProperty(ShimElement.prototype, prop, { get() { return this.getAttribute(attr) || ''; }, set(v) { this._attrs.set(this._k(attr), String(v)); } });
}
for (const k of BOOL) Object.defineProperty(ShimElement.prototype, k, { get() { return this.hasAttribute(k); }, set(v) { this.toggleAttribute(k, !!v); } });
for (const k of ARIA) {
  const attr = 'aria-' + k.slice(4).toLowerCase();
  Object.defineProperty(ShimElement.prototype, k, { get() { return this.getAttribute(attr); }, set(v) { if (v === null) this.removeAttribute(attr); else this._attrs.set(attr, String(v)); } });
}
export class ShimDocument extends ShimNode {
  constructor() { super(null); this.ownerDocument = this; this.nodeType = 9; this.readyState = 'complete'; this.visibilityState = 'visible'; this.hidden = false; this.activeElement = null; this.title = ''; }
  createElement(tag) { return new ShimElement(this, tag); }
  createElementNS(ns, tag) { return new ShimElement(this, tag, ns); }
  createTextNode(s) { return new ShimText(this, s); }
  createComment(s) { return new ShimText(this, s, 8); }
  createDocumentFragment() { const f = new ShimNode(this); f.nodeType = 11; return f; }
  get documentElement() { return this.children[0] || null; }
  get head() { return this.documentElement.querySelector('head'); }
  get body() { return this.documentElement.querySelector('body'); }
  getElementById(id) { const walk = (n) => { for (const c of n.childNodes) if (c.nodeType === 1) { if (c.getAttribute('id') === id) return c; const r = walk(c); if (r) return r; } return null; }; return walk(this); }
  querySelectorAll(sel) { const m = compileSelector(sel), out = []; const walk = (n) => { if (n.nodeType === 1 && m(n, this)) out.push(n); for (const c of n.childNodes) if (c.nodeType === 1) walk(c); }; if (this.documentElement) walk(this.documentElement); return out; }
}

// ---------- selectors ----------
const selectorCache = new Map();
function splitTop(s, sep) {
  const out = [];
  let cur = '', depth = 0, quote = null;
  for (const ch of s) {
    if (quote) { if (ch === quote) quote = null; cur += ch; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '[' || ch === '(') depth++;
    else if (ch === ']' || ch === ')') depth--;
    if (ch === sep && !depth) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}
function compileCompound(p, sel) {
  const unsupported = (what) => new Error(`DOM shim: unsupported selector "${sel}" (${what})`);
  const m = /^([a-zA-Z][\w-]*|\*)?(.*)$/.exec(p);
  const tag = m[1] && m[1] !== '*' ? m[1].toLowerCase() : null, conds = [];
  const re = /#([\w-]+)|\.([\w-]+)|\[\s*([\w-]+)\s*(?:([~^$*|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+)))?\s*\]|:(not|is)\(((?:[^()]|\([^()]*\))*)\)|:([\w-]+)/g;
  let pos = 0;
  for (const x of m[2].matchAll(re)) {
    if (x.index !== pos) throw unsupported(`near "${m[2].slice(pos)}"`);
    pos = x.index + x[0].length;
    if (x[1]) conds.push((e) => e.getAttribute('id') === x[1]);
    else if (x[2]) conds.push((e) => e.className.split(/\s+/).includes(x[2]));
    else if (x[3]) {
      const name = x[3], op = x[4], want = x[5] ?? x[6] ?? x[7];
      conds.push((e) => {
        const val = e.getAttribute(name);
        if (val === null) return false;
        if (!op) return true;
        return op === '=' ? val === want : op === '~=' ? val.split(/\s+/).includes(want) : op === '^=' ? val.startsWith(want) : op === '$=' ? val.endsWith(want) : op === '*=' ? val.includes(want) : val === want || val.startsWith(want + '-');
      });
    } else if (x[8]) { const inner = compileSelector(x[9]); conds.push(x[8] === 'not' ? (e, root) => !inner(e, root) : (e, root) => inner(e, root)); }
    else {
      const ps = x[10];
      const f = {
        'first-child': (e) => !e.previousElementSibling, 'last-child': (e) => !e.nextElementSibling, 'only-child': (e) => !e.previousElementSibling && !e.nextElementSibling,
        checked: (e) => e.hasAttribute('checked'), disabled: (e) => e.hasAttribute('disabled'), enabled: (e) => !e.hasAttribute('disabled'),
        focus: (e) => e.ownerDocument.activeElement === e, 'focus-visible': (e) => e.ownerDocument.activeElement === e, empty: (e) => !e.childNodes.length, scope: (e, root) => e === root,
      }[ps];
      if (!f) throw unsupported(`:${ps}`);
      conds.push(f);
    }
  }
  if (pos !== m[2].length || (!p && !tag)) throw unsupported('empty compound');
  return (e, root) => e && e.nodeType === 1 && (!tag || e.localName.toLowerCase() === tag) && conds.every((c) => c(e, root));
}
export function compileSelector(sel) {
  if (selectorCache.has(sel)) return selectorCache.get(sel);
  const alts = splitTop(String(sel), ',').map((alt) => {
    // compounds and combinators, right to left
    const toks = [];
    let cur = '', depth = 0, quote = null;
    const s = alt.trim().replace(/\s*([>+~])\s*/g, '$1');
    for (const ch of s) {
      if (quote) { if (ch === quote) quote = null; cur += ch; continue; }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '[' || ch === '(') depth++;
      else if (ch === ']' || ch === ')') depth--;
      if (!depth && (ch === ' ' || ch === '>' || ch === '+' || ch === '~')) { if (cur) toks.push(cur); toks.push(ch); cur = ''; } else cur += ch;
    }
    if (cur) toks.push(cur);
    if (!toks.length) throw new Error(`DOM shim: empty selector "${sel}"`);
    const parts = [];
    for (let i = 0; i < toks.length; i += 2) parts.push({ m: compileCompound(toks[i], sel), comb: toks[i + 1] || null });
    return (e, root) => {
      const match = (el, k) => {
        if (!parts[k].m(el, root)) return false;
        if (k === 0) return true;
        const comb = parts[k - 1].comb;
        if (comb === '>') return !!el.parentElement && match(el.parentElement, k - 1);
        if (comb === ' ') { for (let a = el.parentElement; a; a = a.parentElement) if (match(a, k - 1)) return true; return false; }
        if (comb === '+') return !!el.previousElementSibling && match(el.previousElementSibling, k - 1);
        if (comb === '~') { for (let b = el.previousElementSibling; b; b = b.previousElementSibling) if (match(b, k - 1)) return true; return false; }
        return false;
      };
      return match(e, parts.length - 1);
    };
  });
  const f = (e, root) => alts.some((t) => t(e, root));
  selectorCache.set(sel, f);
  return f;
}

// ---------- events ----------
export const shimEvent = (type, extra = {}) => ({ type, bubbles: true, cancelable: true, defaultPrevented: false, isTrusted: false, timeStamp: 0, key: undefined, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, button: 0, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this._stop = true; }, stopImmediatePropagation() { this._stop = true; this._stopNow = true; }, composedPath() { return this._path || []; }, ...extra });
function dispatchShimEvent(target, ev) {
  ev.target = target;
  const doc = target.ownerDocument || target;
  const path = [];
  for (let n = target; n; n = n.parentNode) path.push(n);
  if (doc && doc._win && path.at(-1) === doc) path.push(doc._win);
  ev._path = path;
  const run = (n, phase) => {
    ev.currentTarget = n;
    ev.eventPhase = phase;
    for (const l of [...((n._listeners || {})[ev.type] || [])]) {
      if (phase === 1 && !l.capture) continue;
      if (phase === 3 && l.capture) continue;
      if (l.once) n.removeEventListener(ev.type, l.fn);
      (typeof l.fn === 'function' ? l.fn : l.fn.handleEvent.bind(l.fn)).call(n, ev);
      if (ev._stopNow) return;
    }
  };
  for (const n of path.slice().reverse()) { if (n === target) break; run(n, 1); if (ev._stop) break; }
  if (!ev._stop) run(target, 2);
  if (ev.bubbles) for (const n of path.slice(1)) { if (ev._stop) break; run(n, 3); }
  // Default actions the page relies on: <summary> toggles its <details>; same-page links navigate.
  if (ev.type === 'click' && !ev.defaultPrevented && target.nodeType === 1) {
    const summary = target.closest('summary');
    const a = target.closest('a[href]');
    if (summary && summary.parentElement && summary.parentElement.localName === 'details') summary.parentElement.open = !summary.parentElement.open;
    else if (a && doc._win) doc._win._navigate(a.getAttribute('href'));
  }
  return !ev.defaultPrevented;
}

// ---------- HTML parsing ----------
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', mdash: '—', ndash: '–', hellip: '…', times: '×', larr: '←', rarr: '→', rsaquo: '›', lsaquo: '‹', minus: '−' };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e] ?? all));
export function parseHtml(src) {
  const doc = new ShimDocument();
  let cur = doc;
  const re = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>|[^<]+|</g;
  let m;
  while ((m = re.exec(src))) {
    const tok = m[0];
    if (tok.startsWith('<!')) continue;
    if (m[1]) { for (let n = cur; n && n !== doc; n = n.parentNode) if (n.localName === m[1].toLowerCase()) { cur = n.parentNode; break; } continue; }
    if (m[2]) {
      const el = doc.createElement(m[2]);
      for (const a of (m[3] || '').matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) el._attrs.set(a[1].toLowerCase(), decode(a[2] ?? a[3] ?? a[4] ?? ''));
      cur.appendChild(el);
      const tag = el.localName;
      if (tag === 'script' || tag === 'style' || tag === 'noscript') {
        const close = src.toLowerCase().indexOf(`</${tag}`, re.lastIndex);
        el.appendChild(doc.createTextNode(src.slice(re.lastIndex, close)));
        re.lastIndex = src.indexOf('>', close) + 1;
      } else if (!VOID.has(tag)) cur = el;
      continue;
    }
    if (cur !== doc) cur.appendChild(doc.createTextNode(decode(tok)));
  }
  return doc;
}

// ---------- Chart.js stub ----------
export function makeChart(problems) {
  const autoviv = () => new Proxy({}, { get: (o, k) => (typeof k === 'symbol' || k === 'then' || k === 'toJSON' ? o[k] : k in o ? o[k] : (o[k] = autoviv())) });
  class Chart {
    constructor(canvas, cfg) {
      this.canvas = canvas && canvas.canvas ? canvas.canvas : canvas; this.config = cfg; this.data = cfg && cfg.data; this.options = (cfg && cfg.options) || {};
      this.tooltip = { getActiveElements: () => [], setActiveElements() {} }; this.chartArea = { top: 0, bottom: 300, left: 0, right: 800, width: 800, height: 300 };
      this.scales = new Proxy({}, { get: () => ({ getPixelForValue: () => 0, getValueForPixel: () => 0, min: 0, max: 1, top: 0, bottom: 300, left: 0, right: 800 }) });
      checkChart(this, problems, Chart.defaults);
      Chart.instances.push(this);
    }
    destroy() { this.destroyed = true; }
    update() {} resize() {} stop() {} reset() {} render() {} draw() {} clear() {} setActiveElements() {}
    getDatasetMeta() { return { data: [], hidden: false }; }
    getElementsAtEventForMode() { return []; }
    isDatasetVisible() { return true; }
    toBase64Image() { return ''; }
    static register() {} static unregister() {} static getChart() { return undefined; }
  }
  Chart.defaults = autoviv();
  Chart.instances = [];
  return Chart;
}
function checkChart(chart, problems, defaults) {
  const cfg = chart.config || {}, where = String((chart.canvas && chart.canvas.getAttribute && chart.canvas.getAttribute('aria-label')) || '?').slice(0, 80);
  const bad = (msg) => problems.push(`chart "${where}": ${msg}`);
  if (/^(pie|doughnut|polarArea)$/.test(cfg.type)) bad(`${cfg.type} chart`);
  if (chart.canvas && chart.canvas.getAttribute && chart.canvas.getAttribute('role') !== 'img') bad('canvas without role="img"');
  if (chart.canvas && chart.canvas.getAttribute && !chart.canvas.getAttribute('aria-label')) bad('canvas without aria-label');
  const scales = (cfg.options && cfg.options.scales) || {};
  const yAxes = Object.entries(scales).filter(([k, s]) => (s && s.axis ? s.axis === 'y' : /^y/.test(k)));
  if (yAxes.length > 1) bad(`${yAxes.length} value axes (${yAxes.map(([k]) => k)})`);
  if (Object.values(scales).some((s) => s && s.position === 'right')) bad('right-hand axis');
  const data = cfg.data || {}, labels = Array.isArray(data.labels) ? data.labels : null, sets = data.datasets || [];
  if (!sets.length) bad('no datasets');
  // A legend for 2+ series: Chart.js's own (on unless switched off here or in Chart.defaults) or an HTML
  // legend ([data-legend] or .legend) in the chart's figure.
  const own = cfg.options && cfg.options.plugins && cfg.options.plugins.legend && cfg.options.plugins.legend.display;
  const dflt = defaults && defaults.plugins && defaults.plugins.legend && defaults.plugins.legend.display;
  const chartLegend = own !== undefined ? own !== false : dflt !== false;
  const box = chart.canvas && chart.canvas.closest ? chart.canvas.closest('figure') || chart.canvas.closest('[data-graphic]') : null;
  const named = sets.filter((d) => d && d.label);
  if (named.length >= 2 && !chartLegend && !(box && box.querySelector('[data-legend], .legend'))) bad(`${named.length} series without a legend`);
  for (const ds of sets) {
    if (ds.yAxisID && yAxes.length && ds.yAxisID !== yAxes[0][0]) bad(`dataset "${ds.label}" on a second axis`);
    if (!Array.isArray(ds.data)) { bad(`dataset "${ds.label}" data is not an array`); continue; }
    const badPt = ds.data.find((x) => !(x === null || isNum(x) || (Array.isArray(x) && x.length === 2 && x.every((y) => y === null || isNum(y))) || (x && !Array.isArray(x) && typeof x === 'object' && (x.y === null || isNum(x.y)))));
    if (badPt !== undefined) bad(`dataset "${ds.label}" has a non-numeric point ${JSON.stringify(badPt)}`);
    if (labels && ds.data.every((x) => x === null || typeof x === 'number') && ds.data.length !== labels.length) bad(`dataset "${ds.label}" has ${ds.data.length} points for ${labels.length} labels`);
  }
  for (const [k, s] of Object.entries(scales)) if (s && ((s.grid && Array.isArray(s.grid.borderDash) && s.grid.borderDash.length) || (s.grid && Array.isArray(s.grid.tickBorderDash) && s.grid.tickBorderDash.length) || (s.border && Array.isArray(s.border.dash) && s.border.dash.length))) bad(`dashed gridlines on ${k}`);
  const run = (name, f, thisArg, ...args) => { if (typeof f !== 'function') return; try { f.apply(thisArg, args); } catch (e) { bad(`${name} threw ${e && e.message}`); } };
  const ds0 = sets[0] || { data: [] };
  const n = Math.max(labels ? labels.length : 0, ds0.data.length);
  const idxs = n ? [...new Set([0, Math.floor(n / 2), n - 1])] : [];
  const yOf = (x) => (Array.isArray(x) ? x[1] : x && typeof x === 'object' ? x.y : x);
  const nums = ds0.data.map(yOf).filter(isNum);
  const scaleCtx = { chart, getLabelForValue: (val) => (labels && Number.isInteger(val) && val >= 0 && val < labels.length ? labels[val] : String(val)) };
  for (const [k, s] of Object.entries(scales)) {
    const ticks = (s && s.ticks) || {};
    const vals = s && s.type === 'category' ? idxs : labels && !nums.length ? idxs : [...new Set([0, ...(nums.length ? [Math.min(...nums), Math.max(...nums)] : []), ...idxs])];
    const tickObjs = vals.map((value) => ({ value }));
    for (const [i, val] of vals.entries()) run(`scales.${k}.ticks.callback`, ticks.callback, scaleCtx, val, i, tickObjs);
  }
  const tcb = (((cfg.options || {}).plugins || {}).tooltip || {}).callbacks || {};
  const item = (i) => {
    const raw = ds0.data[i], y = yOf(raw);
    const parsed = { x: raw && !Array.isArray(raw) && typeof raw === 'object' && 'x' in raw ? raw.x : i, y };
    return { chart, dataset: ds0, datasetIndex: 0, dataIndex: i, label: labels ? String(labels[i]) : '', raw, parsed, formattedValue: String(y) };
  };
  const listCbs = new Set(['beforeTitle', 'title', 'afterTitle', 'beforeBody', 'afterBody', 'beforeFooter', 'footer', 'afterFooter']);
  for (const [name, f] of Object.entries(tcb)) for (const i of idxs) run(`tooltip.callbacks.${name}`, f, { chart }, listCbs.has(name) ? [item(i)] : item(i));
}

// ---------- a page instance ----------
// opts: html, app, css (custom properties for getComputedStyle), search, hash, width, nowMs, fetch (async
// (url, init) => Response-like; default serves payloadText), payloadText, caches (stub or undefined),
// chart (false: no Chart global), online, storage (Map), matchMedia (query -> bool).
export async function createPage(opts) {
  const { html, app, css = {}, search = '', hash = '', width = 1280, height = 800, nowMs = Date.now(), payloadText, online = true } = opts;
  const doc = parseHtml(html);
  doc.activeElement = doc.body;
  const errs = [], warns = [], problems = [], timers = new Map(), fetches = [], navigations = [], clipboard = [];
  let tid = 0, clock = 0;
  const location = {
    pathname: '/paxos', search, hash, origin: 'https://www.rodiger.io', protocol: 'https:', host: 'www.rodiger.io', hostname: 'www.rodiger.io', port: '',
    get href() { return this.origin + this.pathname + this.search + this.hash; }, set href(u) { win._navigate(u); },
    assign(u) { win._navigate(u); }, replace(u) { win._navigate(u); }, reload() { navigations.push({ reload: true }); },
  };
  const store = opts.storage || new Map();
  const listeners = {};
  const win = {
    document: doc, location, Node: ShimNode, Element: ShimElement, Text: ShimText, HTMLElement: ShimElement, HTMLCanvasElement: ShimElement, SVGElement: ShimElement,
    console: { log() {}, info() {}, debug() {}, warn: (...a) => warns.push(a.map(String).join(' ')), error: (...a) => errs.push(a.map((x) => (x && x.stack ? String(x.stack).split('\n').slice(0, 3).join(' | ') : String(x))).join(' ')) },
    history: { state: null, replaceState(s, _t, url) { this.state = s; const u = new URL(url, location.href); location.pathname = u.pathname; location.search = u.search; location.hash = u.hash; }, pushState(...a) { this.replaceState(...a); }, back() {} },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, val) => store.set(k, String(val)), removeItem: (k) => store.delete(k), clear: () => store.clear(), key: (i) => [...store.keys()][i] ?? null, get length() { return store.size; } },
    navigator: { onLine: online, userAgent: 'paxos-dom-shim', language: 'en-US', languages: ['en-US'], clipboard: { writeText: async (s) => { clipboard.push(String(s)); } } },
    innerWidth: width, innerHeight: height, outerWidth: width, devicePixelRatio: 1, scrollX: 0, scrollY: 0, pageYOffset: 0,
    screen: { width, height },
    getComputedStyle: () => ({ getPropertyValue: (k) => css[k] || '', fontFamily: 'system-ui, sans-serif', fontSize: '16px', display: 'block' }),
    matchMedia: (q) => ({ media: q, matches: opts.matchMedia ? !!opts.matchMedia(q) : /max-width:\s*(\d+)/.test(q) ? width <= +/max-width:\s*(\d+)/.exec(q)[1] : /min-width:\s*(\d+)/.test(q) ? width >= +/min-width:\s*(\d+)/.exec(q)[1] : false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
    setTimeout: (f, ms = 0, ...a) => { if (typeof f !== 'function') throw new Error('DOM shim: setTimeout with a string'); timers.set(++tid, { f, at: clock + Math.max(0, +ms || 0), a, every: 0 }); return tid; },
    clearTimeout: (id) => timers.delete(id),
    setInterval: (f, ms = 0, ...a) => { timers.set(++tid, { f, at: clock + Math.max(1, +ms || 0), a, every: Math.max(1, +ms || 0) }); return tid; },
    clearInterval: (id) => timers.delete(id),
    requestAnimationFrame: (f) => { timers.set(++tid, { f, at: clock, a: [clock] }); return tid; }, cancelAnimationFrame: (id) => timers.delete(id),
    requestIdleCallback: (f) => { timers.set(++tid, { f, at: clock, a: [{ didTimeout: false, timeRemaining: () => 50 }] }); return tid; }, cancelIdleCallback: (id) => timers.delete(id),
    queueMicrotask, structuredClone, URL, URLSearchParams, AbortController, AbortSignal, TextEncoder, TextDecoder, Response, Headers, Request, Blob,
    performance: { now: () => clock, mark() {}, measure() {}, getEntriesByName: () => [] },
    IntersectionObserver: class { constructor(cb) { this.cb = cb; this.targets = new Set(); } observe(t) { this.targets.add(t); } unobserve(t) { this.targets.delete(t); } disconnect() { this.targets.clear(); } takeRecords() { return []; } },
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
    CSS: { escape: (s) => String(s).replace(/[^\w-]/g, (c) => '\\' + c), supports: () => true },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); }, removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); },
    dispatchEvent(ev) { for (const fn of [...(listeners[ev.type] || [])]) fn.call(win, ev); return true; },
    scrollTo() {}, scrollBy() {}, open() { throw new Error('DOM shim: window.open'); }, alert() { throw new Error('DOM shim: alert'); },
    _listeners: listeners,
    _navigate(u) { const url = new URL(u, location.href); if (url.origin !== location.origin || url.pathname !== location.pathname || url.search !== location.search) navigations.push({ href: url.href }); else { location.hash = url.hash; win.dispatchEvent({ type: 'hashchange' }); } },
  };
  win.window = win; win.self = win; win.top = win; win.parent = win; win.globalThis = win;
  doc._win = win;
  doc.defaultView = win;
  if (opts.caches) win.caches = opts.caches;
  if (opts.chart !== false) win.Chart = makeChart(problems);
  win.fetch = opts.fetch || (async (url, init) => {
    fetches.push({ url: String(url), init });
    return new Response(payloadText, { status: 200, headers: { 'content-type': 'application/json' } });
  });
  const ctx = vm.createContext(win);
  vm.runInContext(`(() => { const D = Date, base = ${Math.round(nowMs)}; const now = () => base + globalThis.__clock(); globalThis.Date = class extends D { constructor(...a) { super(...(a.length ? a : [now()])); } static now() { return now(); } }; })();`, Object.assign(ctx, { __clock: () => clock }));
  // Timers: run everything due up to `ms` from now, in time order (intervals re-armed).
  const advance = (ms = 0) => {
    const end = clock + ms;
    for (let guard = 0; guard < 5000; guard++) {
      const due = [...timers].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      const [id, x] = due;
      clock = Math.max(clock, x.at);
      if (x.every) x.at += x.every; else timers.delete(id);
      x.f(...x.a);
    }
    clock = end;
  };
  const flush = () => advance(1000);
  vm.runInContext(app, ctx, { filename: 'app.js' });
  const P = win.PaxosDashboard;
  const tick = () => new Promise((r) => setImmediate(r));
  const settle = async () => { for (let i = 0; i < 4; i++) { await tick(); flush(); } if (P && typeof P.flushCharts === 'function') P.flushCharts(); await tick(); flush(); };
  const page = {
    doc, win, P, errs, warns, problems, fetches, navigations, clipboard, timers, advance, flush, settle,
    get clock() { return clock; },
    async click(el) { if (!el) throw new Error('click: no element'); el.focus(); dispatchShimEvent(el, shimEvent('click')); await settle(); },
    async key(el, key, extra = {}) { dispatchShimEvent(el, shimEvent('keydown', { key, ...extra })); await settle(); },
    async load() { if (P && typeof P.load === 'function') await P.load(); await settle(); },
  };
  return page;
}

// Visible text of the default view (FINAL-SPEC §6.4): closed <details> bodies (all but the summary),
// [hidden], aria-hidden, .sr-only, inactive tab panels, <table>, script/style/template/noscript are skipped.
// Returns the text runs (one per text node) so word counts never glue two elements' words together.
export function visibleRuns(root) {
  const runs = [];
  const walk = (n, inClosedDetails) => {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) { if (!inClosedDetails && c.data.trim()) runs.push({ text: c.data, node: c }); continue; }
      if (c.nodeType !== 1) continue;
      if (hiddenEl(c)) continue;
      if (inClosedDetails && c.localName !== 'summary') continue;
      walk(c, c.localName === 'details' && !c.hasAttribute('open'));
    }
  };
  walk(root, false);
  return runs;
}
export function hiddenEl(c) {
  return c.hasAttribute('hidden') || c.getAttribute('aria-hidden') === 'true' || c.classList.contains('sr-only') || /^(script|style|template|noscript|table)$/.test(c.localName) || (c.getAttribute('role') === 'tabpanel' && c.hasAttribute('hidden'));
}
// Rendered on screen (graphics count even when aria-hidden: sparklines are decorative for screen readers
// but drawn): no [hidden] ancestor, not inside a closed <details> (its summary excepted).
export function isShown(el) {
  for (let n = el; n && n.nodeType === 1; n = n.parentNode) {
    if (n.hasAttribute('hidden')) return false;
    const p = n.parentNode;
    if (p && p.nodeType === 1 && p.localName === 'details' && !p.hasAttribute('open') && n.localName !== 'summary') return false;
  }
  return true;
}
export function isVisible(el) {
  for (let n = el; n && n.nodeType === 1; n = n.parentNode) {
    if (n.hasAttribute('hidden') || n.getAttribute('aria-hidden') === 'true' || n.classList.contains('sr-only')) return false;
    const p = n.parentNode;
    if (p && p.nodeType === 1 && p.localName === 'details' && !p.hasAttribute('open') && n.localName !== 'summary') return false;
  }
  return true;
}
