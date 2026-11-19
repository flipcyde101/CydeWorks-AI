// Reusable UI primitives. Each returns a DOM node built with textContent only.
// The component catalog in views/developer.js renders every one of these.

import {h, icon} from '../core/dom.js';
import {mode} from '../core/mode.js';

export function button(label, {kind = 'default', onClick, disabled = false, fid, type = 'button', pressed, wide = false, title, iconName} = {}) {
  const cls = {default: 'btn', primary: 'btn btn-primary', danger: 'btn btn-danger', dangerFill: 'btn btn-danger-fill', quiet: 'btn btn-quiet'}[kind] ?? 'btn';
  return h('button', {type, class: cls + (wide ? ' btn-wide' : ''), disabled, onclick: onClick, title,
    dataset: fid ? {fid} : undefined, 'aria-pressed': pressed === undefined ? undefined : String(pressed)}, iconName ? icon(iconName) : null, label);
}

// tone: neutral | ok | warn | danger | decision | active | planned. The word carries the meaning.
export function chip(label, tone = 'neutral', symbol) {
  return h('span', {class: 'chip' + (tone === 'neutral' ? '' : ' chip-' + tone)}, symbol ? h('span', {'aria-hidden': 'true'}, symbol) : null, label);
}

export const planned = (label = 'Planned') => chip(label, 'planned');
// Marks demo data. Shown only on the synthetic adapter: over HTTP the same panels show host records.
export const simulated = () => mode.synthetic ? chip('Simulated', 'warn') : null;
// Marks a client-side approximation that stays simulated on every adapter.
export const approximation = () => chip('Simulated', 'warn');

// tone: info | warn | danger | planned
export function notice(tone, ...children) {
  const iconName = tone === 'info' || tone === 'planned' ? 'info' : 'alert';
  return h('div', {class: 'notice notice-' + tone, role: tone === 'danger' ? 'alert' : undefined}, icon(iconName), h('div', {class: 'grow stack'}, children));
}

export function kv(pairs) {
  return h('dl', {class: 'kv'}, pairs.filter(Boolean).map(([label, value]) => [h('dt', null, label), h('dd', null, value ?? 'Unavailable')]));
}

export function panel(title, ...children) {
  const head = Array.isArray(title) ? h('div', {class: 'panel-head'}, title) : title ? h('h2', null, title) : null;
  return h('section', {class: 'panel'}, head, children);
}

export function emptyState(title, text, action) {
  return h('div', {class: 'empty'}, h('h2', null, title), h('p', null, text), action ?? null);
}

export function disclosure(summary, fid, ...children) {
  return h('details', {dataset: {fid}}, h('summary', {dataset: {fid: fid + '-s'}}, summary), children);
}

export function slot(owner, status, ...children) {
  return h('div', {class: 'slot'}, h('p', {class: 'slot-tag'}, 'Integration slot · ' + owner + ' · ' + status), children);
}

let liveNode, alertNode;
export function announce(message, urgent = false) {
  liveNode ??= document.getElementById('live');
  alertNode ??= document.getElementById('alert');
  const node = urgent ? alertNode : liveNode;
  if (!node || node.textContent === message) return;
  node.textContent = '';
  node.textContent = message;
}

// Modal dialog with managed focus. Focus moves into the dialog on open and returns to the opener
// on close. Escape and the backdrop cancel unless the dialog is busy. Destructive dialogs never
// put initial focus on the destructive button.
export function openDialog({title, body, actions, opener = document.activeElement, onClose, initialFocus, label}) {
  const titleId = 'dialog-title-' + Math.random().toString(36).slice(2, 8);
  const dialog = h('dialog', {'aria-labelledby': titleId, 'aria-label': label});
  let busy = false;
  const api = {
    dialog, close: () => { if (!busy) dialog.close(); },
    setBusy(value) { busy = value; for (const node of dialog.querySelectorAll('button, input, select, textarea')) if (!node.dataset.keepEnabled) node.disabled = value || node.dataset.locked === 'true'; },
  };
  const content = typeof body === 'function' ? body(api) : body;
  const foot = (typeof actions === 'function' ? actions(api) : actions) ?? [button('Close', {onClick: api.close})];
  dialog.append(h('div', {class: 'dialog-body'}, h('h2', {id: titleId, tabindex: '-1'}, title), content), h('div', {class: 'dialog-actions'}, foot));
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('click', event => { if (event.target === dialog && !busy) dialog.close(); });
  dialog.addEventListener('close', () => {
    dialog.remove();
    onClose?.();
    if (opener?.isConnected) opener.focus({preventScroll: true});
    else document.getElementById('main')?.focus({preventScroll: true});
  });
  document.body.append(dialog);
  dialog.showModal();
  ((initialFocus && dialog.querySelector(initialFocus)) || dialog.querySelector('[data-autofocus]') || dialog.querySelector('h2')).focus();
  return api;
}

// Confirmation for consequential actions. The safe choice is focused first.
// `holds` binds the dialog to what the person saw when opening it: it is checked on every
// revalidateDialogs() call and again immediately before onConfirm runs. If it stops holding, the
// dialog closes without sending anything and `onInvalid` explains why.
const watched = new Set();
export function confirmDialog({title, lines, confirmLabel, destructive = false, onConfirm, opener, holds, onInvalid}) {
  let entry;
  const api = openDialog({title, opener, body: lines.map(line => typeof line === 'string' ? h('p', null, line) : line),
    onClose: () => watched.delete(entry),
    actions: api => [
      button('Cancel', {onClick: api.close, fid: 'confirm-cancel'}),
      button(confirmLabel, {kind: destructive ? 'dangerFill' : 'primary', fid: 'confirm-ok', onClick: async () => {
        if (holds && !holds()) { api.close(); onInvalid?.(); return; }
        api.setBusy(true);
        try { await onConfirm(); } finally { api.setBusy(false); api.close(); }
      }}),
    ], initialFocus: '[data-fid="confirm-cancel"]'});
  if (holds) { entry = {api, holds, onInvalid, busy: () => api.dialog.querySelector('[data-fid="confirm-ok"]')?.disabled === true}; watched.add(entry); }
  return api;
}

// Close every open dialog without running its action. Used when the workspace locks, so no task
// content stays visible over the unlock screen.
export function closeAllDialogs() {
  watched.clear();
  for (const dialog of [...document.querySelectorAll('dialog[open]')]) dialog.close();
}

// Close any open confirmation whose bound target no longer holds. Called on every render.
export function revalidateDialogs() {
  for (const entry of [...watched]) {
    if (!entry.api.dialog.open) { watched.delete(entry); continue; }
    if (entry.busy() || entry.holds()) continue;
    watched.delete(entry);
    entry.api.close();
    entry.onInvalid?.();
  }
}
