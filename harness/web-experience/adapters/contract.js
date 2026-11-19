// The WorkspaceAdapter contract. Views call only these methods. The candidate ships one
// implementation (demo/adapter.js). An HTTP adapter over the existing harness routes is NOT written
// yet; see OUTSTANDING.md.
//
// The HTTP implementation is adapters/http.js. It is tested against a copied, in-memory synthetic
// host (test/http-adapter.test.mjs), never against the real workspace or a model.
//
// Every method returns a promise. A rejection carries `status` (HTTP-like) or no status at all.
// Views treat 401 as locked, 404 as missing, 409 as "state changed, re-read", and a rejection
// without a status as an unknown outcome. Nothing is retried automatically.
//
// Each entry: [kind, route, note]. kind is 'existing' (the route is in harness/server.mjs today),
// 'composed' (the adapter builds the result from existing routes) or 'none' (no endpoint exists;
// the method must degrade as described). No endpoint is invented here.

export const ADAPTER_METHODS = Object.freeze({
  session: ['composed', 'GET /api/tasks', 'No session endpoint. A 200 read means unlocked; a 401 from any read means the session ended.'],
  unlock: ['existing', 'POST /api/session', 'Body {key} read from the chosen access file, sent once, never stored. A 409 means a Lock happened while unlocking; choose the file again. The demo takes no key.'],
  lock: ['existing', 'POST /api/session/lock', 'Body exactly {}. Locks every view and releases terminal control; approved work continues. After a lost response, lock locally anyway and never resubmit earlier commands.'],
  listTasks: ['composed', 'GET /api/tasks + GET /api/attention', 'Merged into one row per task.'],
  getTask: ['existing', 'GET /api/tasks/:id', ''],
  createTask: ['existing', 'POST /api/tasks', 'The host requires a title. The candidate sends a neutral default when none is given.'],
  updateScope: ['existing', 'POST /api/tasks/:id/scope', 'Draft only.'],
  listRoutes: ['existing', 'GET /api/models', 'Carries revision, per-route revision, observedAt and a 30 second expiresAt. Map every host material fact into the route view under its host name (id, engine, backend, endpoint, digest or fingerprint as identity, bytes, quantization, remote, cloudDisabled, readiness.eligible, readiness.reason) so approval can compare them when a revision is absent. Evidence is usable only while observedAt <= now < expiresAt. No suggestion field.'],
  refreshRoutes: ['existing', 'GET /api/models', 'Same read. A refresh that changes no material fact keeps an approval.'],
  run: ['existing', 'POST /api/tasks/:id/run',
    'Keyed body {requestId, version, sourceHash, approve, model, engine, backend, modelDigest or modelFingerprint, routeRevision}, built only from the captured approval. routeRevision is the selected route revision.'],
  lookupRunSubmission: ['existing', 'GET /api/tasks/:id/run-submissions/:requestId',
    'Read-only. Use after an uncertain run response. A 404 does not prove the request will never arrive. Never mint a new request ID because of it.'],
  cancel: ['existing', 'POST /api/tasks/:id/cancel', 'Direct routes only.'],
  terminal: ['existing', 'POST /api/tasks/:id/terminal', 'Body {command, confirm, attemptId, generation, lease} from the target observed when the action was chosen.'],
  revise: ['existing', 'POST /api/tasks/:id/revise', ''],
  review: ['existing', 'POST /api/tasks/:id/review', ''],
  copyDraft: ['existing', 'POST /api/tasks/:id/copy-draft', ''],
  lookupCopy: ['existing', 'GET /api/draft-copies/:requestId', ''],
  exportPreview: ['existing', 'GET /api/tasks/:id/export?mode=', ''],
  removalPreview: ['existing', 'GET /api/tasks/:id/removal-preview', 'Returns version, expiresAt and token.'],
  remove: ['existing', 'POST /api/tasks/:id/remove', 'Body {version, expiresAt, token, confirmation} from the same preview, unchanged.'],
  downloadArtifact: ['existing', 'GET /api/tasks/:id/artifact?version=&attemptId=&artifactHash=&format=',
    'Accepted proposal only, bound to the exact accepted tuple shown. Verify X-Artifact-SHA256 against the received bytes. 409 means stale: never refresh into a different proposal.'],
  presentCost: ['existing', 'POST /api/cost-presentation', 'Formats a caller-supplied delta. Not billing proof. Render as plain text.'],
  reviewHandoff: ['existing', 'POST /api/handoffs/review', 'Plans an owner review of a handoff manifest. Creates no task, stores nothing, transfers no authority. Labels are untrusted text.'],
  readiness: ['existing', 'GET /api/tasks/:id/readiness', 'Diagnostic only. executionAuthorized is false.'],
  receipt: ['existing', 'GET /api/tasks/:id/receipt', 'Returns the v2 envelope. Preview and download it unchanged.'],
  receipts: ['composed', 'GET /api/tasks/:id/receipt per task', 'No workspace-wide receipt list exists.'],
  audit: ['composed', 'GET /api/removal-audit + task events', 'Removals only from the host. A stored approval history does not exist.'],
  diagnostics: ['composed', 'GET /api/models (diagnostics field)', 'Environment checks beyond that field have no endpoint.'],
});

export function assertAdapter(adapter) {
  const missing = Object.keys(ADAPTER_METHODS).filter(name => typeof adapter?.[name] !== 'function');
  if (missing.length) throw Error('Adapter is missing: ' + missing.join(', '));
  return adapter;
}

// Classify a rejected adapter call. Used by every view so failures read the same everywhere.
export function classifyError(error) {
  if (error?.status === 401) return {kind: 'locked', message: 'The workspace session ended. Unlock to continue.'};
  if (error?.status === 404) return {kind: 'missing', message: error.message};
  if (error?.status === 409) return {kind: 'conflict', message: error.message};
  if (error?.status === 410) return {kind: 'gone', message: error.message};
  if (error?.status && error.status < 500) return {kind: 'rejected', message: error.message};
  return {kind: 'unknown', message: 'The outcome could not be confirmed. Checking saved state. Nothing is sent again automatically.'};
}

// Confirmed only when the workspace says this view's lock revoked the session.
// A 401 means it had already ended. Any other result stays unconfirmed.
export function classifyLockOutcome(result, error) {
  if (error) return classifyError(error).kind === 'locked' ? 'already' : 'unconfirmed';
  return result?.locked === true ? 'confirmed' : 'unconfirmed';
}
