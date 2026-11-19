/** Shared DOM + UI kit. No framework: plain elements and inline SVG icons. */

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'on' && typeof value === 'object') {
      for (const [evt, fn] of Object.entries(value)) el.addEventListener(evt, fn);
    } else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export const $ = (selector, root = document) => root.querySelector(selector);

export function mount(root, node) {
  root.replaceChildren(node);
}

/* ------------------------------------------------------------------ icons */
const ns = 'http://www.w3.org/2000/svg';
const PATHS = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  records: '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H14l6 6v8.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z"/><path d="M14 4v6h6"/><path d="M8 14h8M8 17h5"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  check: '<path d="m20 6-11 11-5-5"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  arrow: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-5M12 8h.01"/>',
  alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.5 12.5 8-8"/><path d="m16 7 2 2"/><path d="m18.5 4.5 2 2"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
};

/** Builds an SVG node. SVG attributes need setAttributeNS, not setAttribute. */
function svgEl(tag, attrs) {
  const el = document.createElementNS(ns, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttributeNS(null, k, String(v));
  return el;
}

/**
 * @param {string} name key in PATHS
 * @param {number} size rendered px
 * @param {string} cls css class
 * @param {boolean} crisp use inline styles when the node is inserted through an
 *   HTML parser (e.g. h() children), where SVG attributes cannot be set
 */
export function icon(name, size = 18, cls = 'ico', crisp = false) {
  const svg = svgEl('svg', {
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 1.9,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    class: cls,
    'aria-hidden': 'true',
  });
  // Parse the path markup in the SVG namespace so the shapes are valid SVG
  // nodes. Assigning to innerHTML on an SVG element puts children in the HTML
  // namespace, where they never render.
  const markup = `<svg xmlns="${ns}">${PATHS[name] ?? ''}</svg>`;
  const parsed = new DOMParser().parseFromString(markup, 'image/svg+xml').documentElement;
  for (const child of [...parsed.childNodes]) svg.append(document.importNode(child, true));

  if (crisp) {
    // The HTML parser cannot style SVG presentation attributes, so repeat the
    // ones that matter as inline styles (styles survive, attributes do not).
    Object.assign(svg.style, {
      width: size + 'px',
      height: size + 'px',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: '1.9',
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      flex: 'none',
    });
    for (const child of svg.children) {
      child.style.fill = 'none';
      child.style.stroke = 'currentColor';
    }
  }
  return svg;
}

/* -------------------------------------------------------------- formatting */
export function fmtDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function fmtTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export const roleName = (role) =>
  ({ admin: 'Administrator', supervisor: 'Supervisor', team_leader: 'Team Leader', sales_rep: 'Sales Rep' })[role] ?? role;

export function initials(name, email = '') {
  const source = (name || email || '?').trim();
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

/* ------------------------------------------------------------------ pieces */
export function avatar(name, email, cls = 'avatar') {
  return h('span', { class: cls, 'aria-hidden': 'true' }, initials(name, email));
}

export function pill(text, tone = 'neutral') {
  return h('span', { class: `pill ${tone}` }, text);
}

export function rolePill(role) {
  return pill(roleName(role), role === 'team_leader' ? 'leader' : 'role');
}

export function banner(kind, message, action) {
  const iconName = kind === 'error' ? 'alert' : kind === 'ok' ? 'check' : 'info';
  return h(
    'div',
    { class: `banner ${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    icon(iconName, 17),
    h('div', {}, message),
    action ?? null,
  );
}

/** Buttons carry a spinner in place of their icon while busy. */
export function setBusy(button, busy, label) {
  if (!button) return;
  button.disabled = busy;
  if (busy) {
    if (!button.dataset.idle) button.dataset.idle = button.textContent;
    button.replaceChildren(h('span', { class: 'spin' }), document.createTextNode(label ?? 'Working…'));
  } else if (button.dataset.idle) {
    button.replaceChildren(document.createTextNode(button.dataset.idle));
    delete button.dataset.idle;
  }
}

/**
 * iOS-style switch. `onChange(nextBoolean)`; the label text mirrors state so the
 * control is clear at a glance without relying on colour alone.
 */
export function switchToggle({ checked, onChange, onLabel = 'Active', offLabel = 'Disabled', disabled = false }) {
  const input = h('input', { type: 'checkbox', role: 'switch', disabled });
  input.checked = checked;
  const state = h('span', { class: 'state' }, checked ? onLabel : offLabel);
  const label = h('label', { class: 'switch' }, input, h('span', { class: 'track' }), state);
  input.addEventListener('change', () => {
    const next = input.checked;
    state.textContent = next ? onLabel : offLabel;
    onChange(next);
  });
  return { el: label, input };
}

export function card(label, value, { accent = '', foot = '' } = {}) {
  return h(
    'div',
    { class: `card ${accent}`.trim() },
    h('div', { class: 'card-label' }, label),
    h('div', { class: 'card-value' }, String(value)),
    foot ? h('div', { class: 'card-foot' }, foot) : null,
  );
}

export function skeletonPanel(rows = 4) {
  return h(
    'div',
    { class: 'panel' },
    h('div', { class: 'skeleton', style: { height: '16px', width: '38%', marginBottom: '16px' } }),
    ...Array.from({ length: rows }, (_, i) =>
      h('div', { class: 'skeleton sk-row', style: { width: `${92 - i * 7}%` } }),
    ),
  );
}

/**
 * Table renderer. `columns` is [{ label, value(row, index) }]. An optional
 * `empty` message replaces the body when there are no rows.
 */
export function table(columns, rows, emptyText = 'Nothing to show yet.') {
  if (!rows.length) return h('div', { class: 'empty' }, emptyText);
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      {},
      h('thead', {}, h('tr', {}, ...columns.map((c) => h('th', {}, c.label)))),
      h(
        'tbody',
        {},
        ...rows.map((row, i) => h('tr', {}, ...columns.map((c) => h('td', {}, c.value(row, i))))),
      ),
    ),
  );
}

/** Simple horizontal bar chart: [{ label, value }]. Zero values show as empty tracks. */
export function barChart(items, { red = false } = {}) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return h(
    'div',
    { class: 'bar-chart' },
    ...items.map((item) => {
      const pct = max === 0 ? 0 : Math.round((item.value / max) * 100);
      const track = h('span', { class: 'bar-track' }, h('span', { class: `bar-fill${red ? ' red' : ''}`, style: { width: `${pct}%` } }));
      // Label the value inside the bar so short bars are still readable.
      if (item.value > 0) track.firstChild.append(h('span', { class: 'bar-label' }, String(item.value)));
      return h(
        'div',
        { class: 'bar-row' },
        h('span', { class: 'who', title: item.label }, item.label),
        track,
      );
    }),
  );
}

export function metaGrid(pairs) {
  return h(
    'div',
    { class: 'meta-grid' },
    ...pairs.map(([k, v]) => h('div', {}, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v))),
  );
}

export function field(text, input, hint) {
  return h('label', { class: 'field' }, h('span', {}, text), input, hint ? h('span', { class: 'cell-sub', style: { fontWeight: '400' } }, hint) : null);
}
