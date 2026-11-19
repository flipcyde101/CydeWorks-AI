import http from 'node:http';
import {createHash, randomUUID, randomBytes, timingSafeEqual} from 'node:crypto';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {freemem} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {resolve, dirname} from 'node:path';
import {fixture, ollama, ollamaEndpoint} from './providers.mjs';
import {unifiedPatch} from './patch.mjs';
import {opencode} from './opencode.mjs';
import {retryHold,recordInterruption,recordOutcomeUncertainty,recordObservedUsage} from './recovery.mjs';
import {acquireWorkspaceLock} from './workspace-lock.mjs';
import {exportTask} from './export.mjs';
import {exportReceipt} from './receipt-export.mjs';
import {attentionFor} from './attention.mjs';
import {assessRoute,matchesModelIdentity} from './route.mjs';
import {createOwnerLease} from './owner-lease.mjs';
import {previewRemoval,verifyRemoval} from './removal.mjs';
import {buildReadiness} from './readiness.mjs';
import {llamaCpp} from './llamacpp.mjs';
import {createTerminalControl} from './terminal-control.mjs';
import {draftCopyHold,copiedDraftScope} from './draft-copy.mjs';
import {inspectTaskConnections} from './connection-host.mjs';
import {evaluateSubmittedBatch} from './router-evaluation-api.mjs';
import {prepareRunSubmission,findRunSubmission,replayRunSubmission,submissionResult,publicAttempts,approvedRouteRevision} from './run-submission.mjs';
import {buildRouteInventory,routeRevision} from './route-inventory.mjs';
import {artifactDownloadRequest,acceptedArtifactDownload} from './artifact-download.mjs';
import {presentSubmittedCost,reviewSubmittedHandoff} from './contributor-api.mjs';
import {loadBrowserAssets} from './browser-assets.mjs';
import {summarizeReceiptExports} from './receipt-analytics.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const serverRevision=createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex');
const port = Number(process.env.BFE_PORT || 15371);
if (!Number.isInteger(port)||port<0||port>65535) throw Error('The workspace port is invalid.');
const {mode:uiMode,assets}=await loadBrowserAssets(root,process.env.BFE_UI);
let host = '127.0.0.1:' + port;
let origin = 'http://' + host;
const database = process.env.BFE_TEST_MEMORY === '1' ? ':memory:' : resolve(root,'.state','workspace.sqlite');
if (database !== ':memory:') await mkdir(dirname(database), {recursive:true});
const workspaceLock=acquireWorkspaceLock(database);
process.once('exit',()=>workspaceLock.close());
const keyPath=resolve(root,'.state','access.key');
let key=process.env.BFE_TEST_KEY;
if (database !== ':memory:') {
  try { await writeFile(keyPath,randomBytes(32).toString('hex'),{flag:'wx',mode:0o600}); }
  catch (error) { if (error.code!=='EEXIST') throw error; }
  key=(await readFile(keyPath,'utf8')).trim();
}
if (!/^[a-f0-9]{64}$/.test(key ?? '')) throw Error('The workspace access key is invalid.');
let session=randomBytes(32).toString('hex');
// Changes when the session ends. A view id is admitted by the unlock that
// presented the access file, or once by POST /api/desktop-view with the
// launcher cookie. It is not a cookie and not a URL.
let viewGeneration=randomBytes(16).toString('hex');
const admittedViews=new Set();
function rotateViewGeneration() {
  viewGeneration=randomBytes(16).toString('hex');
  admittedViews.clear();
}
// One launcher claim can receive this view. A document navigation does not take
// it. Lock or idle rotates the generation first, so a later claim is not
// admitted and does not mint another view.
let desktopViewTicket=null;
if(process.env.BFE_DESKTOP_BOOTSTRAP==='1') {
  desktopViewTicket={viewId:randomBytes(16).toString('hex'),viewGeneration,delivered:false};
}
function claimDesktopView(res) {
  const ticket=desktopViewTicket;
  if(!ticket||ticket.delivered) return null;
  const valid=/^[a-f0-9]{32}$/.test(ticket.viewId)&&/^[a-f0-9]{32}$/.test(ticket.viewGeneration);
  if(ticket.viewGeneration!==viewGeneration||!valid) {
    ticket.delivered=true;
    return null;
  }
  ticket.delivered=true;
  admittedViews.add(ticket.viewId);
  res.setHeader('X-View-Generation',viewGeneration);
  return {viewId:ticket.viewId,viewGeneration:ticket.viewGeneration};
}
// Workspace inactivity deadline. This is not the 15-second terminal control lease.
// Either clock moving backward ends the session. It does not extend the deadline.
const sessionIdleMs=15*60*1000;
const sessionMonotonic = () => performance.now();
const sessionWall = () => Date.now();
let sessionSeenMono, sessionSeenWall, sessionActivityMono, sessionActivityWall;
function sessionClock() {
  const mono=sessionMonotonic(), wall=sessionWall();
  const finite=Number.isFinite(mono)&&Number.isFinite(wall);
  const forward=finite&&(sessionSeenMono===undefined||mono>=sessionSeenMono)&&(sessionSeenWall===undefined||wall>=sessionSeenWall);
  if(finite){sessionSeenMono=mono;sessionSeenWall=wall;}
  else {sessionSeenMono=undefined;sessionSeenWall=undefined;}
  return forward?{mono,wall}:null;
}
const removalSecret=randomBytes(32);
function equal(candidate, expected) {
  return typeof candidate==='string' && /^[a-f0-9]{64}$/.test(candidate) &&
    timingSafeEqual(Buffer.from(candidate),Buffer.from(expected));
}
function presentedSessionValues(header) {
  const values=[];
  for(const part of String(header??'').split(';')) {
    const item=part.trim();
    if(item.startsWith('bfe_session=')) values.push(item.slice('bfe_session='.length));
  }
  return values;
}
function sessionCookieHeaders() {
  // Path=/api and Path=/api/ are different cookies. Max-Age=0 for Path=/api cannot
  // remove a newer Path=/api/ cookie that unlock has already issued.
  const prefix='bfe_session='+session+'; HttpOnly; SameSite=Strict; Path=';
  return [prefix+'/api', prefix+'/api/'];
}
const db = new DatabaseSync(database);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
  CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, updated TEXT NOT NULL, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS task_removal_audit (id INTEGER PRIMARY KEY, reference TEXT NOT NULL, removed_at TEXT NOT NULL, scope TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS task_draft_copies (request_id TEXT PRIMARY KEY,source_id TEXT NOT NULL,source_version INTEGER NOT NULL,draft_id TEXT NOT NULL)`);
const saveRow = db.prepare('INSERT INTO tasks VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET updated=excluded.updated,data=excluded.data');
const find = db.prepare('SELECT data FROM tasks WHERE id=?');
const list = db.prepare('SELECT data FROM tasks ORDER BY updated DESC');
const workspaceTaskCount = db.prepare('SELECT count(*) AS count FROM tasks');
const receiptSnapshot = db.prepare('SELECT data FROM tasks ORDER BY updated DESC,id LIMIT 100');
const all = () => list.all().map(row => JSON.parse(row.data));
const now = () => new Date().toISOString();
const hash = value => createHash('sha256').update(value).digest('hex');
const providers = {fixture, ollama, opencode};
let active;
function sessionIdle() {
  const clock=sessionClock();
  if(!clock||!Number.isFinite(sessionActivityMono)||!Number.isFinite(sessionActivityWall))return true;
  return clock.mono-sessionActivityMono>=sessionIdleMs||clock.wall-sessionActivityWall>=sessionIdleMs;
}
function noteSessionActivity() {
  const clock=sessionClock();
  if(!clock){
    sessionActivityMono=undefined;
    sessionActivityWall=undefined;
    endWorkspaceSession();
    fail(401,'Unlock this workspace with its local access.key file.');
  }
  sessionActivityMono=clock.mono;
  sessionActivityWall=clock.wall;
}
function endWorkspaceSession() {
  session=randomBytes(32).toString('hex');
  rotateViewGeneration();
  sessionSeenMono=undefined;
  sessionSeenWall=undefined;
  const clock=sessionClock();
  sessionActivityMono=clock?clock.mono:undefined;
  sessionActivityWall=clock?clock.wall:undefined;
  active?.control.revoke();
}
{
  const clock=sessionClock();
  sessionActivityMono=clock?clock.mono:undefined;
  sessionActivityWall=clock?clock.wall:undefined;
}

function save(task, event) {
  task.version++;
  const at = now();
  task.events.push({seq:task.version, at, event});
  saveRow.run(task.id,at,JSON.stringify(task));
}
function fail(status, message) {
  throw Object.assign(Error(message), {status});
}
function need(value, max, label, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) fail(400,'Invalid ' + label + '.');
  return value;
}
function latest(task) {
  return task.attempts.at(-1);
}
function inspectedRoute(model,freeBytes) {
  return {...model,endpoint:model.engine==='fixture'?null:
    model.backend==='llamacpp'?llamaCpp.endpoint:ollamaEndpoint,readiness:assessRoute(model,freeBytes)};
}
function view(task) {
  const run=active?.taskId===task.id ? active : null;
  const hold=retryHold(task);
  const copyHold=draftCopyHold(task,{active:!!run});
  const control=run?.control.snapshot();
  const attempts=publicAttempts(task.attempts);
  return {...task,attempts, copy:{allowed:!copyHold,reason:copyHold},recovery:hold?{blocked:true,message:hold}:null, live:run ? {chars:run.chars,heartbeat:now(),lastActivity:run.lastActivity,
    stopping:run.controller.signal.aborted,terminal:run.terminal,owner:control.owner,control} : null};
}
function scope(data) {
  if (!['change','brief'].includes(data.kind)) fail(400,'Choose a supported workflow.');
  const title=need(data.title,120,'title'), request=need(data.request,800,'request'), source=need(data.source,5000,'source');
  const filename=data.kind==='change' ? need(data.filename,100,'file name') : null;
  if (filename && (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(filename) || filename.endsWith('.'))) fail(400,'Enter a single file name without folders.');
  const expected=data.kind==='change' ? need(data.expected,400,'expected text') : null;
  return {kind:data.kind,title,request,source,filename,expected,sourceHash:hash(source)};
}
function inspect(task, result) {
  const artifact = result.artifact;
  if (!artifact || typeof artifact.summary !== 'string' || typeof artifact.content !== 'string' ||
      !artifact.content.trim() || artifact.content.length > 12000 || artifact.summary.length > 1200) {
    return {artifact:null, checks:[], problem:result.problem ?? 'The model returned an invalid proposal.'};
  }
  const checks = task.kind === 'change'
    ? [{name:'Proposed content differs from the approved snapshot', pass:artifact.content !== task.source},
       {name:'Contains the operator’s expected text', pass:artifact.content.includes(task.expected)}]
    : [{name:'Every citation points to a supplied source and at least one is present', pass:(() => {
      const refs = [...artifact.content.matchAll(/\[(\d+)\]/g)];
      const count = task.source.split(/\n+/).filter(line => line.trim()).length;
      return refs.length > 0 && refs.every(ref => +ref[1] >= 1 && +ref[1] <= count);
    })()}];
  const patch=task.kind==='change' ? unifiedPatch(task.filename,task.source,artifact.content) : null;
  return {artifact:{summary:artifact.summary,content:artifact.content,sha256:hash(artifact.content),patch,
    ...(typeof artifact.rawContent==='string'&&artifact.rawContent.length<=24000?{rawContent:artifact.rawContent}:{})},checks};
}

async function execute(task, run) {
  const attempt = latest(task);
  try {
    const adapter = providers[attempt.provider];
    const backend=attempt.backend??'ollama';
    const choices = await adapter.models({backend});
    const selected = choices.find(model => model.id === task.model &&
      (model.backend??(attempt.provider==='fixture'?'fixture':'ollama'))===backend);
    if (!selected) throw Error('The selected local model is unavailable or exceeds the configured model limit.');
    const approvedIdentity=backend==='llamacpp'?attempt.approvedModelFingerprint:attempt.approvedModelDigest;
    const reportedIdentity=backend==='llamacpp'?selected.fingerprint:selected.digest;
    if(attempt.provider!=='fixture'&&!matchesModelIdentity(approvedIdentity,reportedIdentity))
      throw Error('The model identity changed or is unavailable. Refresh routes and approve the current model again.');
    run.controller.signal.throwIfAborted();
    const currentRoute=inspectedRoute({...selected,engine:attempt.provider},freemem());
    const readiness=currentRoute.readiness;
    if(!readiness.eligible)throw Error(readiness.reason);
    if(attempt.approvedRouteRevision!==undefined) {
      const observedRevision=routeRevision(currentRoute);
      if(!matchesModelIdentity(attempt.approvedRouteRevision,observedRevision))
        throw Error('The selected route changed after review. Refresh routes and approve the current route again.');
      attempt.observedRouteRevision=observedRevision;
    }
    if(backend==='llamacpp') {
      attempt.modelFingerprint=selected.fingerprint;
      attempt.identityKind='server-metadata';
    } else attempt.modelDigest=selected.digest;
    attempt.quantization = selected.quantization ?? null;
    run.controller.signal.throwIfAborted();
    attempt.execution.phase='dispatching';
    attempt.execution.dispatchedAt=now();
    // Persist before crossing the provider boundary. A crash after this point
    // is conservatively treated as an unknown outcome.
    save(task,'attempt.dispatching');
    const result = await adapter.run({...task,backend}, {
      attemptId:attempt.id,
      signal:AbortSignal.any([run.controller.signal, AbortSignal.timeout(120000)]),
      progress(chars) { if (chars !== run.chars) { run.chars=chars; run.lastActivity=now(); } },
      terminal(message) { addTerminal(run,message); },
    });
    attempt.usage = result.usage;
    if (result.settled===true) attempt.execution.phase='settled';
    else recordOutcomeUncertainty(attempt,now());
    if (result.sessionId) attempt.engineSessionId=result.sessionId;
    Object.assign(attempt,inspect(task,result));
    task.status = attempt.artifact ? 'review' : 'failed';
  } catch (error) {
    recordObservedUsage(attempt,error);
    recordOutcomeUncertainty(attempt,now());
    task.status = run.controller.signal.aborted ? 'cancelled' : 'failed';
    attempt.problem = run.controller.signal.aborted
      ? error.processExited ? error.message : 'CydeWorks AI ended its request. Provider process termination has not been verified.'
      : error.name === 'TimeoutError' ? 'The local request exceeded 120 seconds. Check the recovery status before trying again.'
      : error instanceof TypeError || error instanceof SyntaxError ? 'The local provider connection or response was invalid.'
      : error.message;
  } finally {
    run.control.close();
    addTerminal(run,'Attempt '+task.status+'.');
    attempt.terminal=run.terminal;
    attempt.status=task.status;
    attempt.ended=now();
    attempt.elapsedMs=Date.parse(attempt.ended)-Date.parse(attempt.started);
    save(task,'attempt.'+task.status);
    active=undefined;
  }
}

function addTerminal(run,message) {
  if (run.terminal.at(-1)?.message===message) return;
  run.terminal.push({at:now(),message});
  if (run.terminal.length>150) run.terminal.shift();
}

async function jsonBody(request) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') fail(415,'Use application/json.');
  const chunks = [];
  let size=0;
  for await (const chunk of request) {
    size+=chunk.length;
    if (size>48000) fail(413,'Request exceeds the input limit.');
    chunks.push(chunk);
  }
  try {
    const data=JSON.parse(Buffer.concat(chunks).toString());
    if (!data || typeof data !== 'object' || Array.isArray(data)) fail(400,'Expected a JSON object.');
    return data;
  } catch {
    fail(400,'Invalid JSON request.');
  }
}

const server=http.createServer(async (req,res) => {
  const sessionAtArrival=session;
  const send=(status,value) => {
    res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});
    res.end(JSON.stringify(value));
  };
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'"+
    (uiMode==='experience'?"; img-src 'self'":""));
  try {
    if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== origin) ||
        req.headers['sec-fetch-site'] === 'cross-site' || req.headers['sec-fetch-site'] === 'same-site') fail(403,'Use the CydeWorks AI loopback address.');
    const url=new URL(req.url,origin);
    const path=url.pathname;
    if(path==='/api/health') {
      if(req.method!=='GET') {
        res.setHeader('Allow','GET');
        fail(405,'Use GET to check preview health.');
      }
      return send(200,{status:'ready',serverRevision});
    }
    if (req.method==='GET' && assets.has(path)) {
      const asset=assets.get(path);
      res.writeHead(200,{'Content-Type':asset.type+'; charset=utf-8'});
      return res.end(asset.data);
    }
    if (req.method==='POST' && req.headers.origin !== origin) fail(403,'A same-origin approval is required.');
    if (req.method==='POST' && path==='/api/desktop-view') {
      await jsonBody(req);
      const presented=presentedSessionValues(req.headers.cookie);
      if(sessionIdle()) {
        const matched=presented.some(value=>equal(value,session));
        endWorkspaceSession();
        if(desktopViewTicket) desktopViewTicket.delivered=true;
        if(matched) res.setHeader('Set-Cookie','bfe_session=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/api');
        fail(401,'Unlock this workspace with its local access.key file.');
      }
      if(!presented.some(value=>equal(value,session))) fail(401,'Unlock this workspace with its local access.key file.');
      const claimed=claimDesktopView(res);
      if(!claimed) fail(404,'The desktop view is not available.');
      return send(200,claimed);
    }
    if (req.method==='POST' && path==='/api/session') {
      const data=await jsonBody(req);
      if (!equal(data.key,key)) fail(401,'Choose this workspace’s access.key file.');
      if(sessionAtArrival!==session)fail(409,'The workspace was locked while unlocking. Choose the access file again.');
      if(sessionIdle())endWorkspaceSession();
      noteSessionActivity();
      const viewId=randomBytes(16).toString('hex');
      admittedViews.add(viewId);
      res.setHeader('Set-Cookie',sessionCookieHeaders());
      res.setHeader('X-View-Generation',viewGeneration);
      return send(200,{authorized:true,viewId,viewGeneration});
    }
    const presentedSessions=presentedSessionValues(req.headers.cookie);
    const expireSessionCookie=()=>res.setHeader('Set-Cookie','bfe_session=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/api');
    const requireSession=()=>{
      if(sessionIdle()) {
        const matched=presentedSessions.some(value=>equal(value,session));
        endWorkspaceSession();
        if(matched)expireSessionCookie();
        fail(401,'Unlock this workspace with its local access.key file.');
      }
      if(!presentedSessions.some(value=>equal(value,session))) fail(401,'Unlock this workspace with its local access.key file.');
      // Browser Fetch Metadata, including Sec-Fetch-Site: none on a direct navigation,
      // requires this view's admitted id. A stale or missing view is 401 and must not rotate the session or expire the cookie.
      // Callers that send neither Sec-Fetch-Site nor X-Workspace-View stay on the cookie check alone.
      const fetchSite=req.headers['sec-fetch-site'];
      const presentedView=req.headers['x-workspace-view'];
      if(fetchSite!==undefined||presentedView!==undefined) {
        const viewId=typeof presentedView==='string'?presentedView:'';
        if(!/^[a-f0-9]{32}$/.test(viewId)||!admittedViews.has(viewId)) fail(401,'Unlock this workspace with its local access.key file.');
      }
      res.setHeader('X-View-Generation',viewGeneration);
    };
    requireSession();
    const authenticatedBody=async()=>{
      const data=await jsonBody(req);
      // Lock or the idle deadline may have happened while an authenticated body was still arriving.
      requireSession();
      // Heartbeat renews only the 15-second terminal lease. Detach and cost presentation
      // are automatic teardown or read-only presentation, so they do not move this deadline.
      const passiveSessionRequest=path==='/api/cost-presentation'||
        (/^\/api\/tasks\/[a-f0-9-]{36}\/terminal$/.test(path)&&(data.command==='heartbeat'||data.command==='detach'));
      if(!passiveSessionRequest)noteSessionActivity();
      return data;
    };
    if(path==='/api/session/lock') {
      if(req.method!=='POST')fail(405,'Use POST to lock the workspace.');
      const data=await authenticatedBody();
      if(Object.keys(data).length)fail(400,'Use an empty object to lock the workspace.');
      endWorkspaceSession();
      expireSessionCookie();
      return send(200,{locked:true,scope:'all-workspace-views',terminalControlReleased:true,
        stopsWork:false,requiresAccessFile:true});
    }
    if(path==='/api/cost-presentation'||path==='/api/handoffs/review') {
      if(req.method!=='POST')fail(405,'Use POST for a bounded review request.');
      const data=await authenticatedBody();
      const result=path==='/api/cost-presentation'?presentSubmittedCost(data):
        reviewSubmittedHandoff(data,db.prepare('SELECT id FROM tasks').all().map(row=>row.id));
      return send(result.ok?200:400,result);
    }
    if(req.method==='POST'&&path==='/api/router/evaluate') {
      const data=await authenticatedBody();
      const result=evaluateSubmittedBatch(data,now());
      return send(result.ok?200:400,result);
    }
    const readinessMatch=/^\/api\/tasks\/([a-f0-9-]{36})\/readiness$/.exec(path);
    if (req.method==='GET' && (path==='/api/models'||readinessMatch)) {
      if(readinessMatch&&!find.get(readinessMatch[1]))fail(404,'Task not found.');
      const inventoryObservedAtMs=Date.now();
      const [inspection,codeCheck,llamaCheck]=await Promise.allSettled([ollama.inspect(),opencode.availability(),llamaCpp.inspect()]);
      const installed=inspection.status==='fulfilled'?inspection.value.models:[];
      const engines=codeCheck.status==='fulfilled'&&codeCheck.value==='present'?installed:[];
      const llamaModels=codeCheck.status==='fulfilled'&&codeCheck.value==='present'&&llamaCheck.status==='fulfilled'
        ?llamaCheck.value.models:[];
      const diagnostics=buildReadiness(inspection,codeCheck);
      if(llamaCpp.configured&&llamaCheck.status==='rejected')diagnostics.messages.push({code:'llamacpp_unavailable',
        text:'Could not verify the configured local llama.cpp model. Check the service and refresh routes.'});
      const available=freemem();
      const models=[...engines.map(model=>({...model,engine:'opencode'})),
        ...llamaModels.map(model=>({...model,engine:'opencode'})),
        ...installed.map(model=>({...model,engine:'ollama'})),
        ...(await fixture.models()).map(model=>({...model,engine:'fixture'}))];
      requireSession(); // Do not disclose probe results to a view locked while waiting.
      if(readinessMatch) {
        // Re-read after asynchronous probes: do not bind evidence to a stale task.
        const current=find.get(readinessMatch[1]);
        if(!current)fail(404,'Task not found.');
        return send(200,{...inspectTaskConnections(JSON.parse(current.data),models,
          {now:now(),freeBytes:available,endpoints:{ollama:ollamaEndpoint,llamacpp:llamaCpp.endpoint}}),diagnostics});
      }
      return send(200,{...buildRouteInventory(models.map(model=>inspectedRoute(model,available)),
        {observedAtMs:inventoryObservedAtMs}),diagnostics});
    }
    if (req.method==='GET' && path==='/api/tasks') {
      return send(200,{tasks:all().map(({id,title,kind,status}) => ({id,title,kind,status}))});
    }
    if (req.method==='GET' && path==='/api/attention') {
      return send(200,{tasks:all().map(attentionFor).filter(Boolean)});
    }
    if(path==='/api/receipts/analytics') {
      if(req.method!=='GET') {
        res.setHeader('Allow','GET');
        fail(405,'Use GET to read workspace receipt analytics.');
      }
      const workspaceTasks=workspaceTaskCount.get().count;
      const rows=receiptSnapshot.all();
      const envelopes=[];
      let unrunDrafts=0;
      for(const {data} of rows) {
        const envelope=exportReceipt(JSON.parse(data));
        if(!envelope.available && envelope.reasons.length===1 && envelope.reasons[0].code==='no-attempts-recorded') unrunDrafts++;
        else envelopes.push(envelope);
      }
      const summary=summarizeReceiptExports(envelopes,{maxEnvelopes:100});
      if(!summary.ok)fail(500,'Saved receipts could not be summarized.');
      return send(200,{coverage:{workspaceTasks,checkedTasks:rows.length,unrunDrafts,omittedTasks:workspaceTasks-rows.length},summary});
    }
    if (req.method==='GET' && path==='/api/removal-audit') {
      return send(200,{records:db.prepare('SELECT reference,removed_at AS removedAt,scope FROM task_removal_audit ORDER BY id DESC LIMIT 100').all()});
    }
    const runLookup=/^\/api\/tasks\/([a-f0-9-]{36})\/run-submissions\/([a-f0-9-]{36})$/.exec(path);
    if(req.method==='GET'&&runLookup) {
      const row=find.get(runLookup[1]);
      if(!row)fail(404,'Task not found.');
      const task=JSON.parse(row.data),attempt=findRunSubmission(task,runLookup[2]);
      if(!attempt)fail(404,'No recorded run submission was found.');
      return send(200,submissionResult(task,attempt,true));
    }
    const copyLookup=/^\/api\/draft-copies\/([a-f0-9-]{36})$/.exec(path);
    if(req.method==='GET'&&copyLookup) {
      const copy=db.prepare('SELECT draft_id FROM task_draft_copies WHERE request_id=?').get(copyLookup[1]);
      if(!copy)fail(404,'No saved copy result is visible.');
      if(!find.get(copy.draft_id))fail(410,'The recorded copy was removed.');
      return send(200,{taskId:copy.draft_id});
    }
    if (req.method==='POST' && path==='/api/tasks') {
      const data=await authenticatedBody();
      if (all().length>=100) fail(409,'This workspace has reached its 100-task capacity.');
      const task={id:randomUUID(),version:0,status:'draft',...scope(data),model:null,attempts:[],events:[]};
      save(task,'task.created');
      return send(201,view(task));
    }
    const match=/^\/api\/tasks\/([a-f0-9-]{36})(?:\/(scope|run|cancel|review|revise|export|receipt|artifact|terminal|removal-preview|remove|copy-draft))?$/.exec(path);
    if (!match) fail(404,'Route not found.');
    const [,id,action]=match;
    if(action==='artifact') {
      if(req.method!=='GET')fail(405,'Use GET to download an accepted proposal.');
      const row=find.get(id);
      if(!row)fail(404,'Task not found.');
      const download=acceptedArtifactDownload(JSON.parse(row.data),artifactDownloadRequest(url.searchParams));
      const bytes=Buffer.from(download.content,'utf8');
      res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8',
        'Content-Disposition':'attachment; filename="'+download.filename+'"',
        'Content-Length':bytes.length,'X-Artifact-SHA256':download.sha256});
      return res.end(bytes);
    }
    if (req.method==='GET' && (!action || action==='export' || action==='receipt' || action==='removal-preview')) {
      const row=find.get(id);
      if (!row) fail(404,'Task not found.');
      const task=JSON.parse(row.data);
      return send(200,action==='export' ? exportTask(task,url.searchParams.get('mode')??'standard')
        :action==='receipt'?exportReceipt(task,{timebase:url.searchParams.get('timebase')??undefined})
        :action==='removal-preview'?previewRemoval(task,{secret:removalSecret,active:active?.taskId===id}):view(task));
    }
    if (req.method!=='POST') fail(405,'Unsupported method.');
    const data=await authenticatedBody();
    // Read after awaiting the body, so concurrent submissions use current state.
    const row=find.get(id);
    if (!row) fail(404,'Task not found.');
    const task=JSON.parse(row.data);
    const submission=action==='run'?prepareRunSubmission(id,data):null;
    const recordedAttempt=action==='run'?replayRunSubmission(task,submission):null;
    if(recordedAttempt)return send(200,{...view(task),runSubmission:submissionResult(task,recordedAttempt,true)});
    if(action==='copy-draft') {
      if(data.confirm!==true||!Number.isSafeInteger(data.version)||data.version<0||
          typeof data.requestId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(data.requestId))
        fail(400,'Confirm the saved scope with a valid copy request.');
      db.exec('BEGIN IMMEDIATE');
      let draft,reused=false;
      try {
        const existing=db.prepare('SELECT * FROM task_draft_copies WHERE request_id=?').get(data.requestId);
        if(existing) {
          if(existing.source_id!==id||existing.source_version!==data.version)fail(409,'This copy request belongs to a different scope.');
          const saved=find.get(existing.draft_id);
          if(!saved)fail(410,'The recorded copy was removed. This request cannot recreate it.');
          draft=JSON.parse(saved.data);reused=true;
        } else {
          const current=JSON.parse(find.get(id).data);
          if(current.version!==data.version)fail(409,'The task changed. Review the current scope before copying.');
          if(all().length>=100)fail(409,'This workspace has reached its 100-task capacity.');
          draft={id:randomUUID(),version:0,status:'draft',...scope(copiedDraftScope(current,{active:active?.taskId===id})),
            model:null,attempts:[],events:[]};
          save(draft,'task.copied_as_draft');
          db.prepare('INSERT INTO task_draft_copies VALUES (?,?,?,?)').run(data.requestId,id,data.version,draft.id);
        }
        db.exec('COMMIT');
      } catch(error){db.exec('ROLLBACK');throw error;}
      return send(reused?200:201,{task:view(draft),reused});
    }
    if (action==='terminal') {
      if (active?.taskId!==id || latest(task)?.provider!=='opencode') fail(409,'No active OpenCode terminal.');
      const run=active;
      const result=run.control.command(data);
      if(result.message)addTerminal(run,result.message);
      if(result.stop)run.controller.abort();
      return send(200,result.response);
    }
    if (data.version!==task.version) fail(409,'This task changed. Refresh and review its current state.');
    if (action==='remove') {
      db.exec('BEGIN IMMEDIATE');
      try {
        const currentRow=find.get(id);
        if(!currentRow)fail(404,'Task not found.');
        const current=JSON.parse(currentRow.data);
        verifyRemoval(current,data,{secret:removalSecret,active:active?.taskId===id});
        const removed=db.prepare('DELETE FROM tasks WHERE id=?').run(id);
        if(removed.changes!==1)fail(409,'The task changed. Refresh before trying again.');
        db.prepare('INSERT INTO task_removal_audit (reference,removed_at,scope) VALUES (?,?,?)')
          .run(hash('task-removal:'+id),now(),'workspace-record-only-v1');
        db.exec('COMMIT');
      } catch(error) {db.exec('ROLLBACK');throw error;}
      return send(200,{removed:true,scope:'workspace-record-only-v1'});
    } else if (action==='scope') {
      if (task.status!=='draft') fail(409,'Create a new task to change an already approved scope.');
      Object.assign(task,scope(data));
      save(task,'scope.updated');
      return send(200,view(task));
    } else if (action==='run') {
      if (active) fail(409,'Another attempt is still active.');
      if (['running','cancelling','review'].includes(task.status)) fail(409,'Resolve the current attempt before starting another.');
      const hold=retryHold(task);
      if (hold) fail(409,hold);
      if (task.attempts.length>=20) fail(409,'This task has reached its 20-attempt capacity.');
      if (data.approve!==true || data.sourceHash!==task.sourceHash) fail(409,'Confirm the current source snapshot.');
      task.model=need(data.model,100,'model');
      const provider=data.engine ?? (task.model==='fixture'?'fixture':'ollama');
      if (!Object.hasOwn(providers,provider) || (provider==='fixture')!==(task.model==='fixture')) fail(400,'Choose a supported route.');
      const backend=provider==='fixture'?'fixture':data.backend??'ollama';
      if(!['fixture','ollama','llamacpp'].includes(backend)||(backend==='llamacpp'&&provider!=='opencode')||
          (backend==='fixture'&&provider!=='fixture'))fail(400,'Choose a supported local model route.');
      const approvedModelDigest=provider==='fixture'||backend==='llamacpp'?null:data.modelDigest;
      const approvedModelFingerprint=backend==='llamacpp'?data.modelFingerprint:null;
      const approvedIdentity=backend==='llamacpp'?approvedModelFingerprint:approvedModelDigest;
      if(provider!=='fixture'&&!matchesModelIdentity(approvedIdentity,approvedIdentity))
        fail(400,'Refresh routes and select a model with available identity information.');
      const revision=approvedRouteRevision(data);
      const scopeBinding=[task.sourceHash,task.request,task.expected,task.kind,task.model,provider,backend,approvedIdentity];
      if(revision!==undefined)scopeBinding.push(['routeRevision',revision]);
      const attempt={id:randomUUID(), model:task.model,provider,started:now(),status:'running', usage:null,
        backend,approvedModelDigest,approvedModelFingerprint,
        ...(revision!==undefined?{approvedRouteRevision:revision}:{}),scopeHash:hash(JSON.stringify(scopeBinding))};
      attempt.execution={phase:'claimed',claimId:attempt.id,claimedAt:now()};
      if(submission)attempt.submission=submission;
      task.attempts.push(attempt);
      task.status='running';
      save(task,'attempt.approved_and_started');
      const run={taskId:id,controller:new AbortController(),chars:0,lastActivity:now(),terminal:[],
        control:createTerminalControl(attempt.id)};
      addTerminal(run,'Scope approved. Checking the selected route.');
      active=run;
      send(202,{...view(task),...(submission?{runSubmission:submissionResult(task,attempt,false)}:{})});
      void execute(task,run);
    } else if (action==='cancel') {
      if (active?.taskId!==id || task.status!=='running') fail(409,'No active request can be cancelled.');
      if (latest(task)?.provider==='opencode') fail(409,'Use Stop in the OpenCode terminal.');
      // The executor owns its in-memory copy and records the final outcome.
      active.controller.abort();
      return send(202,{status:'cancelling'});
    } else if (action==='revise') {
      const attempt=latest(task);
      if(task.status!=='review'||!attempt?.artifact||data.artifactHash!==attempt.artifact.sha256)
        fail(409,'The proposal changed or is no longer reviewable.');
      const content=need(data.content,12000,'proposal');
      if(content===attempt.artifact.content)fail(400,'The proposal has no changes to save.');
      if((attempt.operatorEdits?.length??0)>=20)fail(409,'This attempt has reached its edit limit.');
      const revised=inspect(task,{artifact:{summary:'Edited by the operator. Review the changes and checks.',content}});
      if(!revised.artifact)fail(400,'The edited proposal could not be reviewed.');
      const previous=attempt.artifact;
      attempt.originalArtifact ??= previous;
      attempt.operatorEdits ??= [];
      attempt.operatorEdits.push({previousHash:previous.sha256,artifactHash:revised.artifact.sha256,at:now()});
      attempt.artifact=revised.artifact;
      attempt.checks=revised.checks;
      save(task,'proposal.operator_edited');
      return send(200,view(task));
    } else if (action==='review') {
      const attempt=latest(task);
      if (task.status!=='review' || data.artifactHash!==attempt?.artifact?.sha256) fail(409,'The proposal changed or is no longer reviewable.');
      if (!['accepted','rejected'].includes(data.decision)) fail(400,'Choose Accept or Reject.');
      if (data.decision==='accepted' && attempt.checks.some(check => !check.pass)) fail(409,'Resolve failed checks before accepting.');
      task.status=attempt.status=data.decision;
      save(task,'review.'+data.decision);
      return send(200,view(task));
    } else fail(404,'Route not found.');
  } catch (error) {
    if (!res.headersSent) send(error.status || 500,{error:error.status ? error.message : 'CydeWorks AI could not complete this operation.'});
    else res.end();
  }
});

const utilityParent=process.env.BFE_DESKTOP_BOOTSTRAP==='1'?process.parentPort:null;
const nodeParent=process.env.BFE_DESKTOP_BOOTSTRAP==='1'&&process.channel&&process.send?true:false;
const testTimeout=database===':memory:'?Number(process.env.BFE_TEST_OWNER_TIMEOUT_MS):NaN;
const ownerTimeout=Number.isInteger(testTimeout)&&testTimeout>=100&&testTimeout<=10000?testTimeout:15000;
const ownerLease=utilityParent?createOwnerLease(ownerTimeout):null;
function desktopSend(message) {
  if(utilityParent)utilityParent.postMessage(message);
  else if(nodeParent&&process.connected)process.send(message);
}
function closeOrphanedWorkspace() {
  server.closeAllConnections();
  server.close();
  process.exit(0);
}
function desktopMessage(message) {
    if(ownerLease?.expired()){closeOrphanedWorkspace();return;}
    if(message?.type==='bfe-owner-heartbeat' && ownerLease && !ownerLease.renew()){closeOrphanedWorkspace();return;}
    if(message?.type==='bfe-status-query' && typeof message.id==='string' &&
      /^[a-f0-9-]{36}$/.test(message.id)) {
      desktopSend({type:'bfe-status-result',id:message.id,active:!!active});
    }
}
if(utilityParent) {
  utilityParent.on('message',event=>desktopMessage(event.data));
  const watchdog=setInterval(()=>{if(ownerLease.expired())closeOrphanedWorkspace();},Math.min(2000,Math.max(50,ownerTimeout/2)));
  watchdog.unref();
} else if(nodeParent) {
  process.on('message',desktopMessage);
  process.once('disconnect',closeOrphanedWorkspace);
}

server.listen(port,'127.0.0.1',() => {
  host='127.0.0.1:'+server.address().port;
  origin='http://'+host;
  for (const task of all().filter(task => task.status==='running')) {
    recordInterruption(task,now());
    save(task,'attempt.interrupted');
  }
  console.log('CydeWorks AI is available at '+origin);
  if(utilityParent||nodeParent)desktopSend({type:'bfe-desktop-ready',port:server.address().port,session});
});
