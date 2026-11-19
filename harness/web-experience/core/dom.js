// Minimal DOM helpers. All text goes through textContent; nothing here parses HTML.

const SVG = 'http://www.w3.org/2000/svg';

export function h(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (key === 'disabled' || key === 'hidden' || key === 'checked' || key === 'open' || key === 'required' || key === 'readOnly')
      node[key] = !!value;
    else if (key === 'value') node.value = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

// 16px stroke icons. One visual family: 1.5 stroke, round caps, no fills.
const PATHS = {
  work: 'M2.5 4.5h11v8h-11z M5.5 4.5v-2h5v2',
  connections: 'M5 8h6 M3.5 8a1.5 1.5 0 1 0 0-.01 M12.5 8a1.5 1.5 0 1 0 0-.01 M8 3.5v2 M8 10.5v2',
  usage: 'M2.5 13.5h11 M4.5 11V8 M8 11V4.5 M11.5 11V6.5',
  data: 'M8 2.5l4.5 1.8v3.4c0 2.8-1.9 4.9-4.5 5.8-2.6-.9-4.5-3-4.5-5.8V4.3z',
  agents: 'M4 4.5a1.5 1.5 0 1 0 0-.01 M12 4.5a1.5 1.5 0 1 0 0-.01 M8 11.5a1.5 1.5 0 1 0 0-.01 M4 6v2.5h8V6 M8 8.5V10',
  developer: 'M5.5 5L2.5 8l3 3 M10.5 5l3 3-3 3 M9 3.5l-2 9',
  plus: 'M8 3v10 M3 8h10',
  search: 'M7 11.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9z M10.3 10.3l3.2 3.2',
  lock: 'M4 7.5h8v6H4z M5.5 7.5V5.5a2.5 2.5 0 0 1 5 0v2',
  back: 'M9.5 3.5L5 8l4.5 4.5',
  alert: 'M8 2.5l6 10.5H2z M8 6.5v3 M8 11.3v.2',
  check: 'M3 8.5l3.2 3L13 4.5',
  cross: 'M4 4l8 8 M12 4l-8 8',
  info: 'M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12z M8 7.2v4 M8 4.8v.2',
  eye: 'M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z M8 9.8a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6z',
  flag: 'M4 14V2.5 M4 3h8l-2 3 2 3H4',
  sliders: 'M3 4.5h10 M3 8h10 M3 11.5h10 M6 3v3 M10.5 6.5v3 M5 10v3',
};

export function icon(name, label) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  if (label) { svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', label); }
  else svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', PATHS[name] ?? PATHS.info);
  svg.append(path);
  return svg;
}

// Rebuild a region only when its key changes. Keeps keyboard focus, text selection range in inputs,
// scroll position and open disclosures across polling updates. Elements opt in with data-fid.
export function swap(container, key, build) {
  if (container.dataset.swapKey === key) return false;
  const active = document.activeElement;
  const focusId = active && container.contains(active) ? active.dataset.fid : null;
  const open = new Map([...container.querySelectorAll('details[data-fid]')].map(node => [node.dataset.fid, node.open]));
  const scroll = new Map([...container.querySelectorAll('[data-keep-scroll]')].map(node => [node.dataset.keepScroll, node.scrollTop]));
  const built = build();
  container.replaceChildren(...(Array.isArray(built) ? built : [built]).flat(Infinity).filter(Boolean));
  container.dataset.swapKey = key;
  for (const node of container.querySelectorAll('details[data-fid]')) if (open.has(node.dataset.fid)) node.open = open.get(node.dataset.fid);
  for (const node of container.querySelectorAll('[data-keep-scroll]')) if (scroll.has(node.dataset.keepScroll)) node.scrollTop = scroll.get(node.dataset.keepScroll);
  if (focusId) container.querySelector('[data-fid="' + CSS.escape(focusId) + '"]')?.focus({preventScroll: true});
  return true;
}

export const stableKey = value => JSON.stringify(value);
