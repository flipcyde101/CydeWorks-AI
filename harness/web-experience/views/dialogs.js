// Task dialogs. Each one states what it will and will not do before the action is available,
// keeps the safe choice focused, and never repeats a request on its own.

import {h} from '../core/dom.js';
import {button, openDialog, notice, kv, disclosure} from '../ui/primitives.js';
import {classifyError} from '../adapters/contract.js';
import {receiptView} from '../adapters/slots.js';
import {editorBase, serializeEdit} from '../logic/parity.js';

const status = () => h('p', {role: 'status', 'aria-live': 'polite', class: 'muted'});

// ---- Portable handoff review (POST /api/handoffs/review) ----------------------------------------
// Plans an owner review of a handoff manifest. It creates no task, stores nothing, and transfers no
// approval, permission or session. Every label in the manifest is untrusted text and is shown with
// textContent only. A ready plan still needs a fresh scope that the person writes in a new draft.

const DISPOSITION = {
  'ready-for-owner-draft-scope-review': ['Ready for your scope review', 'ok', 'Every declared artifact matched its claimed hash. That proves the bytes match the manifest, not that the manifest is authentic.'],
  'hold-missing-or-unverified-artifacts': ['Held: artifacts missing or unverified', 'warn', 'Some declared artifacts were not supplied, or only a hash claim was supplied. Nothing about them is verified.'],
  'blocked-artifact-claim-conflict': ['Blocked: conflicting hash claims', 'danger', 'A supplied hash claim disagrees with the manifest. Resolve it before going further.'],
  'blocked-artifact-mismatch': ['Blocked: artifact bytes do not match', 'danger', 'Supplied bytes do not match what the manifest claims. Reject or reconcile them.'],
};
const VERIFICATION = {'bytes-verified': 'Bytes match the manifest claim', 'byte-mismatch': 'Bytes do not match', missing: 'Not supplied',
  'unverified-hash-claim-only': 'Hash claim only, no bytes', 'claim-conflict-only': 'Hash claim conflicts'};
const ACTION = {'supply-fresh-task-scope-in-destination': 'Write a fresh scope in a new draft yourself', 'owner-confirm-draft-scope': 'Confirm that draft scope before any approval',
  'verify-artifact-bytes': 'Supply and verify the artifact bytes', 'provide-missing-artifact-bytes': 'Provide the missing artifact files',
  'resolve-conflicting-artifact-hash-claims': 'Resolve the conflicting hash claims', 'reject-or-reconcile-mismatched-artifacts': 'Reject or reconcile the mismatched artifacts'};
const MAX_MANIFEST_BYTES = 40000, MAX_ARTIFACT_BYTES = 32768;

function handoffPlanView(result) {
  if (!result?.ok) {
    const issues = Array.isArray(result?.issues) ? result.issues.slice(0, 20) : [];
    return notice('danger', h('p', {dataset: {fid: 'handoff-invalid'}}, issues.length ? 'The manifest was refused. Nothing was imported.' : 'The handoff request was refused. Nothing was imported.'),
      issues.length ? h('ul', {class: 'stack'}, issues.map(issue => h('li', null, h('span', {class: 'mono'}, String(issue.code ?? 'issue')), ' ', String(issue.message ?? ''), issue.path ? h('span', {class: 'faint'}, ' at ' + String(issue.path)) : null))) : null);
  }
  const plan = result.plan, review = plan.artifactReview, owner = plan.ownerScopeReview;
  const [label, tone, explain] = DISPOSITION[owner.disposition] ?? ['Unrecognized result', 'warn', 'The plan did not report a known disposition. Treat it as held.'];
  return h('div', {class: 'stack', dataset: {fid: 'handoff-plan'}},
    notice(tone === 'ok' ? 'info' : tone, h('p', null, h('strong', {dataset: {fid: 'handoff-disposition'}}, label + '. '), explain)),
    kv([['Handoff purpose (untrusted text)', String(plan.purpose?.text ?? '')], ['Task purpose (untrusted text)', String(plan.destinationProposal?.purpose?.text ?? '')],
      ['Workflow', plan.destinationProposal?.workflowKind === 'change' ? 'Proposed change to one file' : 'Written answer from supplied text'],
      ['Scope hash', 'Claimed only. Not verified and not proof of authenticity.'],
      ['Artifacts', review.bytesVerifiedCount + ' of ' + review.totalDeclared + ' matched by bytes'],
      ['Creates a task', 'No. Nothing was stored, and no task was created.'],
      ['Earlier imports', 'Not tracked. This review cannot tell whether the manifest was seen before.']]),
    review.items.length ? h('div', {class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Declared artifacts'}, h('table', null,
      h('thead', null, h('tr', null, ['Artifact', 'Purpose (untrusted text)', 'Claimed size', 'Result'].map(name => h('th', {scope: 'col'}, name)))),
      h('tbody', null, review.items.map(item => h('tr', null, h('td', {class: 'mono'}, String(item.artifactId)), h('td', null, String(item.purpose?.text ?? '')),
        h('td', null, Number(item.claimedByteLength).toLocaleString('en-US') + ' bytes'), h('td', null, VERIFICATION[item.verificationState] ?? 'Unknown')))))) : null,
    h('h3', null, 'What you still have to do'),
    h('ol', {class: 'stack'}, owner.requiredActions.map(code => h('li', null, ACTION[code] ?? 'Review this handoff'))),
    h('p', {class: 'faint'}, 'Never transferred: approvals, permissions, sign-in, acceptance, model qualification, host attestation, terminal control and running sessions. ' +
      'Labels can still contain sensitive text; preview them before sharing the manifest outside this computer.'));
}

export function openHandoffReview({adapter, actions}, opener) {
  let manifest = null, manifestError = null, files = {}, result = null, review, picker, slots, note = status();
  const declared = () => Array.isArray(manifest?.artifacts) ? manifest.artifacts.filter(item => item && typeof item.artifactId === 'string').slice(0, 32) : [];
  function drawSlots() {
    slots.replaceChildren(...(manifest ? declared().map((item, index) => {
      const id = 'handoff-artifact-' + index;
      return h('div', {class: 'stack'}, h('label', {for: id}, 'Artifact file for ' + item.artifactId + ' (optional)'),
        h('input', {type: 'file', id, dataset: {fid: id}, onchange: async event => {
          const file = event.target.files?.[0];
          if (!file) { delete files[item.artifactId]; return; }
          if (file.size > MAX_ARTIFACT_BYTES) { event.target.value = ''; delete files[item.artifactId]; note.textContent = 'That artifact is larger than 32 KiB, the review limit. It was not added.'; return; }
          files[item.artifactId] = new Uint8Array(await file.arrayBuffer());
          note.textContent = 'Artifact file added for ' + item.artifactId + '. It is sent only when you choose Review handoff.';
        }}));
    }) : [manifestError ? notice('warn', h('p', null, manifestError)) : h('p', {class: 'faint'}, 'Choose a manifest to list its declared artifacts.')]));
  }
  openDialog({title: 'Review a task handoff', opener,
    body: () => {
      picker = h('input', {type: 'file', id: 'handoff-manifest', accept: '.json,application/json', dataset: {fid: 'handoff-manifest'}, onchange: async event => {
        manifest = null; manifestError = null; files = {}; result = null; review.replaceChildren();
        const file = event.target.files?.[0];
        if (file) {
          if (file.size > MAX_MANIFEST_BYTES) manifestError = 'That file is larger than the 40 KB manifest limit.';
          else { try { manifest = JSON.parse(await file.text()); } catch { manifestError = 'That file is not valid JSON.'; } }
        }
        drawSlots();
      }});
      slots = h('div', {class: 'stack'}); review = h('div', {class: 'stack', 'aria-live': 'polite'});
      drawSlots();
      return [h('p', {class: 'muted'}, 'Checks a handoff manifest from another workspace and plans what you would need to review. It creates no task, stores nothing, and transfers no approval, permission or session.'),
        h('label', {for: 'handoff-manifest'}, 'Handoff manifest (JSON)'), picker, slots, note, review];
    },
    actions: api => [button('Close', {onClick: api.close, fid: 'handoff-close'}),
      button('Review handoff', {kind: 'primary', fid: 'handoff-review', onClick: async () => {
        if (!manifest) { note.textContent = manifestError ?? 'Choose a manifest first.'; return; }
        const artifacts = Object.entries(files).map(([artifactId, bytes]) => ({artifactId, bytes}));
        if (artifacts.reduce((sum, item) => sum + item.bytes.length, 0) > MAX_ARTIFACT_BYTES) { note.textContent = 'The artifact files together exceed 32 KiB, the review limit. Nothing was sent.'; return; }
        api.setBusy(true); note.textContent = 'Reviewing. Nothing is imported.';
        try { result = await adapter.reviewHandoff({manifest, artifacts}); note.textContent = 'Review finished. Nothing was imported or stored.'; review.replaceChildren(handoffPlanView(result)); }
        // A 401 has already locked and concealed the workspace through the observed adapter, which
        // closed this dialog; a stale result is dropped. Neither is shown here.
        catch (error) { if (error?.stale || classifyError(error).kind === 'locked') return; note.textContent = classifyError(error).message; }
        finally { api.setBusy(false); }
      }})]});
}

export function openProposalEditor({state, actions}, opener) {
  const task = state.task, artifact = task.attempts.at(-1).artifact;
  // Line endings follow harness/web/proposal-editor.js: an edit keeps the proposal's own ending,
  // and a proposal that mixes endings is saved only after the person chooses LF.
  const ending = editorBase(artifact.content);
  const base = {id: task.id, version: task.version, hash: artifact.sha256, ...ending};
  const area = h('textarea', {id: 'proposal-content', rows: 14, maxlength: 12000, value: ending.content, 'data-autofocus': true, 'aria-describedby': 'proposal-hint'});
  const normalize = h('input', {type: 'checkbox', id: 'proposal-normalize', dataset: {fid: 'proposal-normalize'}});
  const note = status();
  note.textContent = 'Saving reruns the structural checks. Review accuracy before accepting.';
  let locked = false;
  const separator = {'\r\n': 'Windows (CRLF)', '\r': 'classic Mac (CR)', '\n': 'Unix (LF)'}[ending.separator];
  openDialog({title: 'Edit proposal', opener,
    body: [h('p', null, 'The original proposal is kept with this task. Saving replaces the review candidate. It does not change any file on your computer.'),
      h('label', {for: 'proposal-content'}, 'Edited proposal', area),
      h('span', {class: 'field-hint', id: 'proposal-hint'}, 'Up to 12,000 characters. ' + (ending.mixed ? 'This proposal mixes line endings.' : 'Line endings stay ' + separator + '.')),
      ending.mixed ? h('label', {class: 'check', for: 'proposal-normalize'}, normalize, h('span', null, 'Normalize mixed line endings to LF when saving this edit.')) : null, note],
    actions: api => {
      const save = button('Save for review', {kind: 'primary', fid: 'proposal-save', onClick: async () => {
        if (locked) return;
        const edit = serializeEdit(base, area.value, {normalize: normalize.checked});
        if (edit.problem) { note.textContent = edit.problem; return; }
        const current = state.task;
        if (current?.id !== base.id || current.version !== base.version || current.attempts.at(-1).artifact?.sha256 !== base.hash) {
          locked = true; save.dataset.locked = 'true'; save.disabled = true;
          note.textContent = 'The proposal changed while you were editing. Copy your text, then close and reopen the editor.';
          return;
        }
        api.setBusy(true); note.textContent = 'Saving the edited proposal.';
        try {
          const saved = await actions.revise(edit.content);
          api.setBusy(false); api.close();
          actions.taskSaved(saved, 'Edited proposal saved for review. Structural checks were rerun.');
        } catch (error) {
          api.setBusy(false);
          const kind = classifyError(error).kind;
          if (kind === 'rejected') note.textContent = 'The edit was not accepted. ' + error.message;
          else {
            locked = true; save.dataset.locked = 'true'; save.disabled = true;
            note.textContent = kind === 'conflict' ? 'The proposal changed. Copy your text, then close and reopen the editor.'
              : 'The save outcome could not be confirmed. Copy your text, then refresh the task before trying again.';
          }
        }
      }});
      return [button('Cancel', {onClick: api.close, fid: 'proposal-cancel'}), save];
    }});
}

const pendingKey = id => 'cydeworks-candidate-pending-copy:' + id;
const storage = () => { try { return globalThis.sessionStorage; } catch { return null; } };

export function openCopyDialog({state, adapter, actions}, opener) {
  const source = {id: state.task.id, version: state.task.version, title: state.task.title, copy: state.task.copy};
  const store = storage(), note = status();
  let request, uncertain = false, finished = false, storageError = !store;
  try {
    const saved = store?.getItem(pendingKey(source.id));
    if (saved) { const parsed = JSON.parse(saved); request = {version: parsed.version, requestId: parsed.requestId, confirm: true}; uncertain = true; }
    else request = {version: source.version, requestId: crypto.randomUUID(), confirm: true};
  } catch { storageError = true; }
  note.textContent = storageError ? 'This tab cannot keep the request identity, so copying is held to prevent duplicate drafts.'
    : uncertain ? 'An earlier copy could not be confirmed. Check its result, or retry the same request. A new request identity is not created.'
    : source.copy?.allowed ? 'The copy is saved as a new draft. Nothing runs until you approve it.' : source.copy?.reason ?? 'Open a saved task first.';
  openDialog({title: 'Copy as new draft', opener,
    body: [h('p', null, h('strong', null, 'Original task: '), source.title),
      h('p', null, 'Copied: the request, the source snapshot, the workflow, the file name and the expected text.'),
      h('p', null, 'Not copied: routes, approvals, attempts, results, checks, usage and terminal control. The generated proposal is not used as the new source.'),
      note, h('p', {class: 'faint'}, 'A request identifier is kept in this tab so a lost response can be recovered after a reload. It contains no request or source text.')],
    actions: api => {
      const copy = button('Save new draft', {kind: 'primary', fid: 'copy-submit'});
      const check = button('Check copy result', {fid: 'copy-check'}), retry = button('Retry same request', {fid: 'copy-retry'});
      const sync = () => {
        copy.disabled = uncertain || finished || storageError || !source.copy?.allowed;
        copy.dataset.locked = String(copy.disabled);
        check.hidden = retry.hidden = !uncertain || finished;
      };
      const done = taskId => { try { store.removeItem(pendingKey(source.id)); } catch { /* a resolved identity can stay */ } finished = true; api.setBusy(false); api.close(); actions.copyOpened(taskId); };
      async function send(isRetry) {
        if (finished || storageError) return;
        const latest = state.task;
        if (latest?.id !== source.id || (!isRetry && (latest.version !== source.version || !latest.copy?.allowed))) {
          finished = true; note.textContent = 'The original task changed. Close this dialog and start a fresh copy.'; sync(); return;
        }
        try { store.setItem(pendingKey(source.id), JSON.stringify({version: request.version, requestId: request.requestId})); }
        catch { storageError = true; note.textContent = 'The request identity could not be kept in this tab. Nothing was sent.'; sync(); return; }
        api.setBusy(true); note.textContent = 'Saving the draft copy.';
        try { done((await adapter.copyDraft(source.id, request)).task.id); }
        catch (error) {
          api.setBusy(false);
          if (error.status && error.status < 500 && (!isRetry || error.status === 410)) {
            try { store.removeItem(pendingKey(source.id)); } catch { /* ignore */ }
            uncertain = false; finished = true; note.textContent = 'The copy request was not accepted: ' + error.message;
          } else {
            uncertain = true;
            note.textContent = 'The copy outcome could not be confirmed. Check its result, or retry the same request. Nothing is retried automatically.';
          }
          sync();
          if (uncertain) check.focus();
        }
      }
      copy.addEventListener('click', () => send(false));
      retry.addEventListener('click', () => send(true));
      check.addEventListener('click', async () => {
        api.setBusy(true); note.textContent = 'Checking the earlier copy request. No new draft is being created.';
        try { done((await adapter.lookupCopy(request.requestId)).taskId); }
        catch (error) {
          api.setBusy(false);
          note.textContent = error.status === 404 ? 'No saved result is visible yet. Keep this request and check again. No new copy was sent.'
            : error.status === 410 ? 'The recorded copy was removed. This request will not recreate it.' : 'The check could not be completed. Try again when the workspace is reachable.';
          if (error.status === 410) { try { store.removeItem(pendingKey(source.id)); } catch { /* ignore */ } uncertain = false; finished = true; }
          sync();
        }
      });
      sync();
      return [button('Cancel', {onClick: api.close, fid: 'copy-cancel'}), check, retry, copy];
    }, initialFocus: '[data-fid="copy-cancel"]'});
}

const EXPORT_NOTES = {
  minimal: 'Omits the task name, file name, source, request, model name, identifiers, timestamps and history.',
  standard: 'Includes the task name, file name, model identifiers, timestamps and history. Excludes the request, the source and the proposal.',
};

export function openExportDialog({state, adapter, actions}, opener) {
  const id = state.task.id, note = status(), preview = h('pre', {tabindex: '0', 'aria-label': 'Export preview'}), about = h('p', {class: 'muted'});
  const mode = h('select', {id: 'export-mode'}, h('option', {value: 'minimal'}, 'Minimal metadata'), h('option', {value: 'standard'}, 'Standard metadata'));
  let content, revision = 0, save;
  async function refresh() {
    const stamp = ++revision;
    content = undefined; save.disabled = true; save.dataset.locked = 'true'; preview.textContent = ''; note.textContent = 'Preparing the preview.';
    about.textContent = EXPORT_NOTES[mode.value];
    try {
      const data = await adapter.exportPreview(id, mode.value);
      if (stamp !== revision) return;
      content = JSON.stringify(data, null, 2); preview.textContent = content; save.disabled = false; save.dataset.locked = 'false'; note.textContent = 'Preview ready. This is exactly what would be downloaded.';
    } catch (error) { if (stamp === revision) note.textContent = 'Preview unavailable. ' + classifyError(error).message; }
  }
  mode.addEventListener('change', refresh);
  openDialog({title: 'Preview metadata export', opener, onClose: () => { revision++; },
    body: [h('p', {class: 'muted'}, 'Review exactly what will be downloaded. Exporting removes nothing from the workspace or from a provider. The file leaves the workspace boundary once you save it.'),
      h('label', {for: 'export-mode'}, 'Detail', mode), about, note, preview],
    actions: api => { save = button('Download shown JSON', {kind: 'primary', fid: 'export-save', disabled: true, onClick: () => { if (content) { actions.download('cydeworks-task-metadata.json', content, 'application/json'); api.close(); } }});
      return [button('Close', {onClick: api.close, fid: 'export-close'}), save]; }, initialFocus: '#export-mode'});
  void refresh();
}

export function openRemovalDialog({state, adapter, actions}, opener) {
  const id = state.task.id, note = status(), body = h('div', {class: 'stack'});
  const confirm = h('input', {type: 'text', id: 'removal-confirm', autocomplete: 'off', spellcheck: 'false'});
  let approval, remove;
  const sync = () => { const ready = !!approval?.allowed && confirm.value === 'REMOVE'; remove.disabled = !ready; remove.dataset.locked = String(!ready); };
  confirm.addEventListener('input', () => sync());
  const section = (title, items) => h('div', {class: 'stack'}, h('h3', null, title), h('ul', {class: 'stack'}, items.map(item => h('li', null, '• ' + item))));
  openDialog({title: 'Review task removal', opener,
    body: [h('p', null, 'Read what is removed and what remains before deciding. This is not secure erasure and it does not reach provider copies.'), body, note,
      h('label', {for: 'removal-confirm'}, 'Type REMOVE to confirm', confirm)],
    actions: api => {
      remove = button('Remove task record', {kind: 'dangerFill', fid: 'removal-submit', disabled: true, onClick: async () => {
        if (!approval?.allowed || confirm.value !== 'REMOVE') return;
        api.setBusy(true); note.textContent = 'Removing the workspace record.';
        try {
          // The exact tuple from the preview the person read. A refused or expired preview is never
          // silently replaced: the person closes this dialog and reviews a new one.
          await adapter.remove(id, removalRequest(approval, confirm.value));
          api.setBusy(false); api.close(); actions.removed(id);
        } catch (error) {
          api.setBusy(false); approval = undefined; sync();
          const kind = classifyError(error).kind;
          note.textContent = kind === 'missing' ? 'The record is no longer in the workspace.'
            : kind === 'unknown' ? 'The outcome could not be confirmed. Refresh the task list before trying again. Nothing was repeated.'
            : 'This removal was not accepted: ' + error.message + ' Nothing was removed. Close this dialog and review a new preview.';
        }
      }});
      return [button('Cancel', {onClick: api.close, fid: 'removal-cancel'}), remove];
    }, initialFocus: '[data-fid="removal-cancel"]'});
  note.textContent = 'Preparing the removal preview.';
  adapter.removalPreview(id).then(data => {
    approval = data;
    body.replaceChildren(h('p', null, h('strong', null, 'Task: '), data.title), section('Will be removed', data.removes), section('Will remain', data.retains), section('Limits', data.limitations),
      data.allowed ? h('p', {class: 'faint'}, 'This preview expires at ' + new Date(data.expiresAt).toLocaleTimeString() + '. After that, close this dialog and review a new one.')
        : notice('warn', h('p', null, data.reason)));
    note.textContent = data.allowed ? 'Review the lists above, then type REMOVE to confirm.' : 'Removal is held for this task.';
    sync();
  }).catch(error => { note.textContent = 'Preview unavailable. ' + classifyError(error).message; });
}

// The removal request: exactly the preview's version, expiresAt and token, plus the typed word.
// harness/removal.mjs signs the expiry, so it must be the preview's own value.
export function removalRequest(preview, confirmation) {
  return {version: preview.version, expiresAt: preview.expiresAt, token: preview.token, confirmation};
}

// The download is the host's envelope, serialized unchanged. Nothing is added, removed or rebuilt.
export function receiptExportContent(envelope) {
  return JSON.stringify(envelope, null, 2);
}

// entry: {title, envelope} where envelope is the unchanged GET /api/tasks/:id/receipt response,
// either branch. The summary above the JSON is read from the envelope; the JSON is the envelope.
export function openReceiptDialog({actions}, entry, opener) {
  const envelope = entry.envelope, content = receiptExportContent(envelope);
  const view = receiptView(envelope);
  const summary = !view ? [notice('warn', h('p', null, 'This receipt could not be read. It is shown below unchanged.'))]
    : view.available ? [kv([['Run', view.runId], ['Attempts', String(view.attempts)],
      ['Accepted', view.accepted ? 'Yes. A recorded human decision on the latest attempt.' : 'No recorded acceptance of the latest attempt.'],
      ['Attempt list', view.attemptsComplete ? 'Complete according to the task event log.' : 'Not proven complete: ' + view.attemptList.join(', ')],
      ['Costs', view.outcomes.map(item => item.cost).join(', ')]])]
    : [notice('warn', h('p', null, 'No receipt is available for this task.')), h('ul', {class: 'stack'}, view.reasons.map(reason => h('li', null, reason.message)))];
  openDialog({title: 'Run receipt', opener,
    body: [h('p', null, h('strong', null, entry.title)), ...summary,
      notice('info', h('p', null, 'This file carries hashed identifiers, statuses, times, token counts and recorded costs. It carries no request, source or proposal. Identifiers can be matched across exports, so it is not anonymous.')),
      view?.limits?.length ? disclosure('Limits stated in this receipt (' + view.limits.length + ')', 'receipt-limits', h('ul', {class: 'stack'}, view.limits.map(limit => h('li', null, limit)))) : null,
      h('pre', {tabindex: '0', 'aria-label': 'Receipt JSON, exactly as downloaded'}, content)],
    actions: api => [button('Close', {onClick: api.close, fid: 'receipt-close'}),
      button('Download shown JSON', {kind: 'primary', fid: 'receipt-save', onClick: () => { actions.download('cydeworks-run-receipt.json', content, 'application/json'); api.close(); }})],
    initialFocus: '[data-fid="receipt-close"]'});
}

