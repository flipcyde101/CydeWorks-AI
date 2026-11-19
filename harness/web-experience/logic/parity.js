// Behavior ported from the current frontend (harness/web) so the candidate can replace it.
// Pure functions, no DOM. Each names the harness code it matches; test/parity.test.mjs checks them.

// harness/web/app.js $('file').onchange: a small text file, at most 20,000 bytes and 5,000
// characters, with no NUL character. The file is read in the browser and never uploaded on its own.
export const SOURCE_FILE_LIMITS = Object.freeze({bytes: 20000, characters: 5000});
export async function readSourceFile(file) {
  if (!file) return null;
  if (typeof file.size !== 'number' || file.size > SOURCE_FILE_LIMITS.bytes) throw Error('This preview accepts a small text file, up to 5,000 characters.');
  const source = await file.text();
  if (source.length > SOURCE_FILE_LIMITS.characters || source.includes('\0')) throw Error('Choose a text file of at most 5,000 characters.');
  return {source, filename: typeof file.name === 'string' ? file.name : ''};
}

// harness/web/proposal-editor.js: an edit keeps the proposal's own line ending. A proposal that
// mixes endings cannot be saved until the person chooses to normalize it to LF.
export const normalizeLineEndings = value => value.replace(/\r\n?/g, '\n');
export function lineEndings(value) {
  const withoutCRLF = value.replace(/\r\n/g, '');
  const styles = [value.includes('\r\n') ? '\r\n' : null, withoutCRLF.includes('\r') ? '\r' : null, withoutCRLF.includes('\n') ? '\n' : null].filter(Boolean);
  return {separator: styles.length === 1 ? styles[0] : '\n', mixed: styles.length > 1};
}
export function editorBase(content) {
  const style = lineEndings(content);
  return {content: normalizeLineEndings(content), separator: style.separator, mixed: style.mixed};
}
// What would be sent, or why nothing can be: unchanged, empty, too long, or mixed without consent.
export function serializeEdit(base, text, {normalize = false} = {}) {
  const normalized = normalizeLineEndings(text);
  if (!normalized.trim()) return {problem: 'Enter the proposal text before saving.'};
  if (normalized === base.content) return {problem: 'Change the text before saving.'};
  if (base.mixed && !normalize) return {problem: 'This proposal mixes line endings. Choose to normalize them to LF before saving.'};
  const content = normalized.replace(/\n/g, base.separator);
  if (content.length > 12000) return {problem: 'The edited proposal is longer than 12,000 characters.'};
  return {content};
}

// harness/web/app.js renderUsage: an observed comparison of accepted attempts within one task.
// The latest accepted attempt is compared with the first accepted attempt on a different model.
// Only attempts with reported usage and a finite duration count. One run each; quality not measured.
export function acceptedAttemptComparison(attempts) {
  const complete = (attempts ?? []).filter(attempt => ['provider reported', 'OpenCode reported'].includes(attempt.usage?.evidence));
  const accepted = complete.filter(attempt => attempt.status === 'accepted' && typeof attempt.elapsedMs === 'number' && Number.isFinite(attempt.elapsedMs));
  const chosen = accepted.at(-1), baseline = accepted.find(attempt => attempt.model !== chosen?.model);
  if (!chosen || !baseline) return null;
  return {chosen: chosen.model, baseline: baseline.model, deltaMs: chosen.elapsedMs - baseline.elapsedMs};
}

// harness/web/app.js remember(): the last open task in this tab, by ID only, so a reload of the
// workspace root reopens it. No task text is stored.
export const RESUME_KEY = 'cydeworks-candidate-resume';
const ID = /^[a-f0-9-]{36}$/;
export function rememberedTask(storage) {
  try { const id = storage?.getItem(RESUME_KEY); return typeof id === 'string' && ID.test(id) ? id : null; } catch { return null; }
}
export function rememberTask(storage, id) {
  try { if (id && ID.test(id)) storage?.setItem(RESUME_KEY, id); else storage?.removeItem(RESUME_KEY); } catch { /* storage may be disabled */ }
}
