import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {existsSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {Agent, request} from 'node:http';
import {basename, join} from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {createInferenceBroker} from '../../harness/inference-broker.mjs';
import {createLlamaCpp} from '../../harness/llamacpp.mjs';
import {createStepReceipt} from '../../harness/opencode-usage.mjs';

export {claimRun, reconcileClaim, runOwned, bindCheckedPatch} from './runner-lifecycle.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const REPO = join(ROOT, 'fixture-repo');
const FILES = ['limits.py', 'measurement.py'];
const MODEL = 'qwen3-4b-local';
const ENGINE_VERSION = '1.18.34';
const MODEL_PORT = '8080';
const PYTHON = ['/usr/bin/python3', '-I', '-B', './sandbox.py'];
const INSTRUCTION = 'Update the two Python files. limits.clamp(value) must return 0 for integers below 0 and 100 for integers above 100, otherwise return value. measurement.normalize(raw) must keep the int(raw) conversion, return 0 on a TypeError or ValueError, and pass a valid converted integer to clamp. Keep the function names, signatures, import and no external dependencies.';
const CASES = [
  ['clamp', -8, 0], ['clamp', 0, 0], ['clamp', 56, 56], ['clamp', 100, 100], ['clamp', 164, 100],
  ['normalize', '-12', 0], ['normalize', ' 42 ', 42], ['normalize', '150', 100], ['normalize', 75, 75],
  ['normalize', 'bad', 0], ['normalize', null, 0], ['normalize', '', 0],
];
const TARGETS = [
  'approvedBaseReadOnly', 'approvedInputReadable', 'candidateChildrenDenied', 'candidateMemoryBounded',
  'childOutsideReadDenied', 'noEffectiveCapabilities',
  'noNewPrivileges', 'outsideMarkerPreserved', 'outsideReadDenied', 'outsideSymlinkDenied',
  'outsideWriteDenied', 'ownedProcessTreeStopped', 'parentEnvironmentAbsent', 'parentLoopbackDenied',
  'privateLoopbackWorks', 'windowsMountsAbsent', 'workerCanWrite', 'workspaceSizeBounded',
];
const wsl = ['--distribution', 'Ubuntu-24.04', '--user', 'nobody', '--exec', ...PYTHON];
const timeoutMS = 112000;
const sha = content => createHash('sha256').update(content).digest('hex');

export function validateProposal(output, original) {
  if (typeof output !== 'string' || Buffer.byteLength(output) > 18000) throw Error('Invalid proposal text.');
  const trimmed = output.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  const parsed = JSON.parse(fenced?.[1] ?? trimmed);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object' ||
      Object.keys(parsed).sort().join('\0') !== FILES.join('\0')) {
    throw Error('The proposal must contain exactly the two approved files.');
  }
  return Object.fromEntries(FILES.map(name => {
    const content = parsed[name];
    if (typeof content !== 'string' || !content.trim() || !content.isWellFormed() ||
        content.includes('\0') || Buffer.byteLength(content) > 8192) throw Error('Invalid source replacement.');
    const normalized = content.endsWith('\n') ? content : content + '\n';
    if (normalized === original[name]) throw Error('Both approved files must change.');
    return [name, normalized];
  }));
}

export function verifyBoundary(value) {
  if (!value || !TARGETS.every(key => Object.hasOwn(value, key) && value[key] === true)) {
    throw Error('The isolated worker failed a required boundary check.');
  }
  return Object.fromEntries(TARGETS.map(key => [key, true]));
}

function runGuest(mode, extra = [], input) {
  return execFileSync('wsl.exe', [...wsl, mode, ...extra], {cwd: ROOT, input, encoding: 'utf8',
    timeout: 26000, maxBuffer: 256000, windowsHide: true}).trim();
}

function git(args, {worktree = REPO, input} = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ['path', 'pathext', 'systemroot', 'windir', 'comspec'].includes(key.toLowerCase())));
  return execFileSync('git.exe', ['--no-optional-locks', ...args], {cwd: worktree, input, encoding: 'utf8',
    env: {...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL', GIT_TERMINAL_PROMPT: '0'},
    windowsHide: true, timeout: 6000, maxBuffer: 131072});
}

function checkFiles(directory) {
  const inputs = CASES.map(([name, input]) => ({name, input}));
  const results = JSON.parse(runGuest('check', [directory], JSON.stringify(inputs) + '\n'));
  if (!Array.isArray(results) || results.length !== CASES.length) throw Error('Protected check output was incomplete.');
  const failures = CASES.flatMap(([, , expected], index) => {
    const row = results[index];
    return row && Object.keys(row).length === 1 && row.value === expected ? [] : [index + 1];
  });
  return {cases: CASES.length, passed: CASES.length - failures.length, failures};
}

async function callBroker(broker, payload, signal) {
  if (!payload || Array.isArray(payload) || payload.model !== MODEL || !Array.isArray(payload.messages)) {
    throw Error('The guest requested an unapproved inference operation.');
  }
  const body = JSON.stringify({...payload, max_tokens: 768});
  if (Buffer.byteLength(body) > 262144) throw Error('The inference request exceeded its limit.');
  const port = Number(new URL(broker.endpoint).port);
  const agent = new Agent({keepAlive: false, proxyEnv: {}});
  try {
    return await new Promise((resolve, reject) => {
      const upstream = request({hostname: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
        signal, agent, headers: {'content-type': 'application/json', 'x-cydeworks-local': broker.token}}, response => {
        let size = 0;
        const chunks = [];
        response.on('data', chunk => {
          size += chunk.length;
          if (size <= 524288) chunks.push(chunk);
          else response.destroy(Error('The inference response exceeded its limit.'));
        });
        response.once('end', () => resolve({status: response.statusCode, body: Buffer.concat(chunks, size).toString('utf8'),
          contentType: payload.stream ? 'text/event-stream' : 'application/json'}));
        response.once('error', reject);
      });
      upstream.once('error', reject);
      upstream.end(body);
    });
  } finally {
    agent.destroy();
  }
}

async function generate(broker, original, fileDigests, signal, report) {
  const process = spawn('wsl.exe', [...wsl, 'generate'], {cwd: ROOT, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
  const closed = once(process, 'close');
  let stderr = '';
  process.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-1200); });
  process.stdin.on('error', () => {});
  const send = value => process.stdin.write(JSON.stringify(value) + '\n');
  send({request: INSTRUCTION, fileDigests});
  let requestCount = 0, files, receivedFiles;
  const receipt = createStepReceipt();
  const abort = () => { process.stdin.end(); process.kill(); };
  signal.addEventListener('abort', abort, {once: true});
  try {
    for await (const line of createInterface({input: process.stdout, crlfDelay: Infinity})) {
      if (Buffer.byteLength(line) > 250000) throw Error('Unexpectedly large guest frame.');
      const message = JSON.parse(line);
      if (message.type === 'inference' && !files && ++requestCount <= 2) {
        report('Local Qwen received an approved inference request');
        send(await callBroker(broker, message.payload, signal));
      } else if (message.type === 'proposal' && !files) {
        const failure = message.events?.find(event => event.type === 'error' || event.type === 'tool_use');
        if (message.exitCode !== 0 || !Array.isArray(message.events) || failure) {
          const name = failure?.error?.name;
          const safeName = typeof name === 'string' && /^[A-Za-z]{1,80}$/.test(name) ? ' (' + name + ')' : '';
          throw Error('OpenCode failed to return a tool-free proposal' + safeName + '.');
        }
        let output = '';
        for (const event of message.events) {
          if (event.type === 'text' && typeof event.part?.text === 'string') output += event.part.text;
          if (event.type === 'step_finish' && receipt.observe(event).unsafe) throw Error('Conflicting OpenCode usage evidence.');
        }
        files = validateProposal(output, original);
        send({type: 'apply', files});
      } else if (message.type === 'files' && files && !receivedFiles) {
        assert.deepEqual(message.files, files, 'The worker must return the exact reviewed replacements.');
        receivedFiles = message.files;
        process.stdin.end();
      } else {
        throw Error('The guest sent an unexpected frame.');
      }
    }
    const [code] = await closed;
    if (code !== 0 || !receivedFiles || requestCount < 1) {
      throw Error('The managed OpenCode worker failed (' + String(code) + '). ' + stderr.trim());
    }
    return {files: receivedFiles, usage: receipt.snapshot(), requests: requestCount};
  } catch (error) {
    abort();
    await closed.catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

async function run() {
  throw Error('Pilot execution disabled: Windows-to-WSL ownership and protected verifier qualification required.');

  const clock = performance.now();
  let completed = 0;
  const report = text => console.log(`[${completed}/5 complete, ${Math.round((performance.now() - clock) / 1000)}s elapsed] ${text}`);
  report('Checking the disposable runner boundary');
  const boundary = verifyBoundary(JSON.parse(runGuest('qualify')));
  assert.equal(runGuest('version'), ENGINE_VERSION);
  completed++;
  if (!existsSync(join(REPO, '.git'))) {
    git(['init', '--quiet', '--initial-branch=pilot', '--template=']);
    git(['add', '--', ...FILES]);
    git(['-c', 'user.name=CydeWorks synthetic test', '-c', 'user.email=fixture@example.invalid',
      'commit', '--quiet', '-m', 'Create disposable baseline']);
  }
  assert.equal(git(['status', '--porcelain']), '');
  assert.deepEqual(git(['ls-files']).trim().split(/\r?\n/), FILES);
  const revision = git(['rev-parse', 'HEAD']).trim();
  const original = Object.fromEntries(FILES.map(name => [name, readFileSync(join(REPO, name), 'utf8')]));
  const before = checkFiles('fixture-repo');
  assert.ok(before.failures.length > 0, 'The unchanged repository must fail the intended checks.');
  completed++;
  const server = createLlamaCpp({port: MODEL_PORT});
  const [model] = await server.models();
  assert.equal(model?.id, MODEL);
  const id = randomUUID();
  const scope = {id, revision, fileDigests: Object.fromEntries(FILES.map(name => [name, sha(original[name])])),
    request: INSTRUCTION, destination: server.endpoint, model: model.id, modelFingerprint: model.fingerprint,
    engine: ENGINE_VERSION, maximumRuntimeMs: timeoutMS, protectionCases: sha(JSON.stringify(CASES))};
  const dir = mkdtempSync(join(ROOT, 'candidate-'));
  const claimPath = join(ROOT, `claim-${id}.json`);
  writeFileSync(claimPath, JSON.stringify({...scope, scopeHash: sha(JSON.stringify(scope)), disposition: 'claimed'}, null, 2), {flag: 'wx'});
  const signal = AbortSignal.timeout(timeoutMS);
  const broker = await createInferenceBroker(server.endpoint, {model: MODEL, signal});
  report('Running OpenCode inside the namespace. ETA depends on local inference.');
  const heartbeat = setInterval(() => report('Waiting for the isolated OpenCode attempt'), 5000);
  let proposal;
  let inferenceMS;
  const inferenceClock = performance.now();
  try {
    proposal = await generate(broker, original, scope.fileDigests, signal, report);
    inferenceMS = Math.round(performance.now() - inferenceClock);
  } finally {
    clearInterval(heartbeat);
    await broker.close();
  }
  const [afterModel] = await server.models();
  assert.equal(afterModel?.fingerprint, model.fingerprint, 'The approved model metadata changed.');
  completed++;
  for (const name of FILES) writeFileSync(join(dir, name), proposal.files[name], {flag: 'wx'});
  report('Running the protected checks in a fresh namespace');
  const after = checkFiles(basename(dir));
  assert.deepEqual(after.failures, [], 'The isolated candidate must pass all protected checks.');
  completed++;
  const diffArgs = ['--git-dir', join(REPO, '.git'), '--work-tree', dir, 'diff', '--no-ext-diff', '--no-textconv'];
  assert.deepEqual(git([...diffArgs, '--name-only', '--']).trim().split(/\r?\n/), FILES);
  const patch = git([...diffArgs, '--', ...FILES]);
  assert.ok(patch.includes('diff --git a/limits.py b/limits.py') && patch.includes('diff --git a/measurement.py b/measurement.py'));
  git(['apply', '--check', '--index', '-'], {input: patch});
  assert.equal(git(['status', '--porcelain']), '', 'The base checkout changed.');
  assert.equal(git(['rev-parse', 'HEAD']).trim(), revision);
  for (const name of FILES) assert.equal(readFileSync(join(REPO, name), 'utf8'), original[name]);
  const patchName = `proposal-${id}.patch`;
  writeFileSync(join(ROOT, patchName), patch, {flag: 'wx'});
  const result = {status: 'verified-proposal', id, sourceRevision: revision, files: FILES,
    candidate: basename(dir), patch: patchName, patchSha256: sha(patch), codeChecks: {before, after},
    baseUnchanged: true, patchAppliesToBase: true, boundary, openCodeVersion: ENGINE_VERSION,
    model: MODEL, quantization: model.quantization, routeIdentity: model.identityKind,
    localInferenceRequests: proposal.requests, recordedElapsedMs: inferenceMS, usage: proposal.usage,
    chargeEvidence: 'unavailable'};
  const evidenceName = `pilot-result-${id}.json`;
  writeFileSync(join(ROOT, evidenceName), JSON.stringify(result, null, 2), {flag: 'wx'});
  completed++;
  report('Verified the two-file patch, all twelve checks, and the unchanged base');
  console.log(JSON.stringify({evidenceName, patchName, before: before.passed, after: after.passed,
    tests: after.cases, model: MODEL, quantization: model.quantization, recordedElapsedMs: inferenceMS}));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await run().catch(error => { console.error(error.message); process.exitCode = 1; });
}

