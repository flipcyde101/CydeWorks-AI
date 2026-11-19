import {createObserver} from './observer.js';
import {bindExportDialog} from './export-dialog.js';
import {summarizeUsage,describeStepReceipt} from './usage.js';
import {describeProgress,progressAnnouncement} from './progress.js';
import {bindRemovalDialog} from './removal-dialog.js';
import {diagnosticMessages} from './route-diagnostics.js';
import {bindProposalEditor} from './proposal-editor.js';
import {terminalRequest,ownsTerminal} from './terminal-request.js';
import {bindDraftCopyDialog} from './draft-copy-dialog.js';
import {bindWorkspaceLock,createSessionEpoch,workspaceLockCopy} from './workspace-lock.js';
const $ = id => document.getElementById(id);
const form = $('create');
const field = name => form.elements.namedItem(name);
let task, models=[], selection=0, busy=false, editing, lease, detached=false, listRevision=0, listTimer;
let connection='connected', needsReconcile=false, explicitLock=null;
let actionRevision=0;
const sessionGate=createSessionEpoch();
let lockEpoch=0;
const resumeKey='bfe-last-task';
const remember=id=>{try { if (id) sessionStorage.setItem(resumeKey,id); else sessionStorage.removeItem(resumeKey); } catch { /* Storage may be disabled. */ }};
const remembered=()=>{try { return sessionStorage.getItem(resumeKey); } catch { return null; }};
const routeBackend=model=>model.engine==='fixture'?'fixture':model.backend??'ollama';
const routeKey=model=>JSON.stringify([model.engine,routeBackend(model),model.id]);

function element(tag,text) {
  const node=document.createElement(tag);
  if (text!==undefined) node.textContent=text;
  return node;
}
function definition(container, pairs) {
  container.replaceChildren();
  for (const [label,value] of pairs) container.append(element('dt',label),element('dd',value ?? 'Unavailable'));
}
function note(message='') { $('notice').textContent=message; }
async function api(path,body) {
  const response=await fetch(path,body===undefined ? {signal:AbortSignal.timeout(8000)} : {
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),
    signal:AbortSignal.timeout(8000),
  });
  const data=await response.json();
  if (!response.ok) throw Object.assign(Error(data.error),{status:response.status});
  return data;
}
async function act(fn) {
  if (busy||sessionGate.locked()) return;
  const epoch=sessionGate.epoch();
  busy=true;
  actionRevision++;
  $('new-task').disabled=true;
  note();
  try { await fn(); } catch (error) {
    if(!sessionGate.current(epoch))return;
    note(error.message);
    if (task && error.status===401) {
      lease=undefined;
      observer.stop();
      if(!explicitLock)setConnection({phase:'locked'});
    } else if (task && (!error.status || error.status===409 || error.status>=500)) {
      lease=undefined;
      needsReconcile=true;
      setConnection({phase:'checking'});
      observer.start(task.id,850);
      note(error.status===409 ? error.message+' Checking current saved state.'
        : 'The last action could not be confirmed. Checking saved state. No action will be sent again automatically.');
    }
  } finally {
    busy=false;
    if(sessionGate.current(epoch)&&connection==='connected'&&!needsReconcile)$('new-task').disabled=false;
  }
}
const path = () => '/api/tasks/'+task.id;
const seconds = ms => ms == null ? null : (ms/1000).toFixed(2)+' s';
const active = status => status==='running';
const labels = {draft:'Needs approval', review:'Needs review', running:'Running', accepted:'Accepted', rejected:'Rejected',
  failed:'Needs attention', cancelled:'Request cancelled', interrupted:'Needs recovery'};

function concealLocalSession() {
  lockEpoch=sessionGate.conceal();
  lease=undefined;
  observer.stop();
  clearTimeout(listTimer);
  $('new-task').disabled=true;
  for (const id of ['run-button','terminal-take','terminal-release','terminal-status','terminal-stop','terminal-detach','terminal-attach','edit','edit-proposal','reject','copy-task','download','download-patch','refresh-routes','export','remove-task']) {
    const node=$(id);
    if (node) node.disabled=true;
  }
  cancel.disabled=true;
  $('accept').disabled=true;
  return lockEpoch;
}
function setConnection(state) {
  if (sessionGate.locked() && state.phase!=='locked') return;
  if (state.phase==='locked' && !sessionGate.locked()) concealLocalSession();
  connection=state.phase;
  $('connection').hidden=connection==='connected';
  $('reconnect').hidden=connection==='locked';
  $('connection-message').textContent=connection==='reconnecting'
    ? 'Connection interrupted. Saved view may be stale. Read attempt '+state.failures+' failed; retrying in '+(state.retryMs/1000)+' seconds. Run outcome is unknown until reconnected. No commands are replayed. Recovery ETA is unavailable until the local service responds.'
    : connection==='checking' ? 'Checking saved task state before enabling more actions. No command will be replayed.'
    : connection==='locked' ? (workspaceLockCopy[explicitLock] ?? 'The workspace session ended. Select its access file to unlock and resume observation. The previous run outcome is unknown.')
    : connection==='missing' ? 'This task is no longer available. Open another task or reconnect to check again.' : '';
  if (connection==='locked') {
    $('unlock').hidden=false;
    $('lock-workspace').hidden=true;
  }
  if (connection!=='connected') $('approve').checked=false;
  if (task) render();
}
const observer=createObserver({
  read:id=>api('/api/tasks/'+id),
  async onData(latest,isCurrent) {
    const epoch=sessionGate.epoch();
    if (busy || !sessionGate.current(epoch)) return false;
    const id=task?.id, stamp=selection, actionStamp=actionRevision;
    if (latest.id!==id || latest.version<task.version) return false;
    if(lease&&!ownsTerminal(latest,lease))lease=undefined;
    if (lease && active(latest.status)) {
      const held=lease;
      try { await api('/api/tasks/'+id+'/terminal',terminalRequest(latest,held,'heartbeat')); }
      catch { if (lease===held && isCurrent()) lease=undefined; }
    }
    if (!isCurrent() || busy || !sessionGate.current(epoch) || actionStamp!==actionRevision || stamp!==selection || task?.id!==id || latest.version<task.version) return false;
    const changed=latest.version!==task.version;
    task=latest;
    if (needsReconcile) {
      needsReconcile=false;
      note('Saved task state restored. Review the current status before taking another action.');
    }
    if (changed) void refreshList().catch(()=>{});
  },
  onState:setConnection,
  onDisconnect(){ lease=undefined; needsReconcile=true; },
});
bindWorkspaceLock({
  openButton:$('lock-workspace'),dialog:$('lock-dialog'),confirmButton:$('lock-confirm'),cancelButton:$('lock-cancel'),
  status:$('access-status'),send:body=>api('/api/session/lock',body),focusTarget:$('access-file'),
  onLocalLock() {
    concealLocalSession();
    explicitLock='waiting';
    setConnection({phase:'locked'});
  },
  onOutcome(outcome) {
    if(!sessionGate.outcomeCurrent(lockEpoch)){
      if(!sessionGate.locked())$('access-status').textContent='';
      return;
    }
    explicitLock=outcome;
    setConnection({phase:'locked'});
  },
});
$('reconnect').onclick=()=>{ if (task&&!sessionGate.locked()) observer.start(task.id); };

async function refreshList() {
  const epoch=sessionGate.epoch(), stamp=++listRevision;
  const [all,alerts]=await Promise.all([api('/api/tasks'),api('/api/attention')]);
  if(stamp!==listRevision||!sessionGate.current(epoch))return;
  const activeElement=document.activeElement;
  const focusedId=activeElement?.dataset?.taskId,focusedList=activeElement?.dataset?.taskList;
  for(const [list,items] of [['tasks',all.tasks],['attention',alerts.tasks]]) {
    const target=$(list),children=[];
    for(const item of items) {
      const label=item.title+' · '+(item.reasons?item.reasons.join(', '):labels[item.status]);
      const node=element('button',label);
      node.dataset.taskId=item.id;
      node.dataset.taskList=list;
      node.setAttribute('aria-current',String(item.id===task?.id));
      node.onclick=()=>act(()=>openTask(item.id));
      const li=element('li');li.append(node);children.push(li);
    }
    if(list==='attention'&&!items.length)children.push(element('li','Nothing needs your attention.'));
    target.replaceChildren(...children);
  }
  if(focusedId&&focusedList)Array.from($(focusedList).querySelectorAll('button'))
    .find(button=>button.dataset.taskId===focusedId)?.focus({preventScroll:true});
}
function watchList() {
  clearTimeout(listTimer);
  listTimer=setTimeout(async()=>{
    const epoch=sessionGate.epoch();
    try {await refreshList();}
    catch(error) {
      if(!sessionGate.current(epoch))return;
      if(error.status===401){
        needsReconcile=true;
        if(!explicitLock){
          setConnection({phase:'locked'});
          $('access-status').textContent='Unlock to resume the workspace.';
        }
        return;
      }
    }
    if(sessionGate.current(epoch)&&!$('workspace').hidden)watchList();
  },5000);
}
function showRoute() {
  const model=models.find(item=>routeKey(item)===$('model').value);
  const destination=model?.engine==='fixture'
    ? 'Synthetic fixture. This route generates a sample without contacting a model.'
    : model?.backend==='llamacpp' ? 'OpenCode sends the approved request and source to llama.cpp on this computer ('+model.endpoint+'). The server controls model execution; network isolation is not verified.'
    : model ? (model.engine==='opencode'?'OpenCode → ':'')+'Ollama endpoint on this computer ('+model.endpoint+') receives the approved request and source. The server controls model execution; its settings may change, and network isolation is not verified.'
      : 'No eligible route is selected.';
  $('destination').textContent=destination+(model?.fingerprint?' The fingerprint represents server-reported metadata, not the model weights.':
    model?.digest?' Ollama reported this digest at preflight: '+model.digest.slice(0,12)+
    '… The model tag could change before execution.':'')+
    (model?.readiness?.reason?' '+model.readiness.reason:'');
}
function populateRoutes(inventory,preferred) {
  models=inventory.models;
  $('model').replaceChildren(...models.map(model=>{
    const label=model.backend==='llamacpp'?'OpenCode · llama.cpp · ':model.engine==='opencode'?'OpenCode · ':model.engine==='ollama'?'Ollama · ':'';
    const option=element('option',label+model.label+(model.quantization?' · '+model.quantization:'')+
      (model.readiness?.eligible?'':' (not ready)'));
    option.value=routeKey(model);
    option.disabled=!model.readiness?.eligible;
    return option;
  }));
  const unavailable=models.filter(model=>!model.readiness?.eligible).map(model=>
    element('li',(model.backend==='llamacpp'?'OpenCode · llama.cpp · ':model.engine==='opencode'?'OpenCode · ':model.engine==='ollama'?'Ollama · ':'')+
      model.label+': '+(model.readiness?.reason??'Availability is unknown.')));
  const diagnosticRows=diagnosticMessages(inventory).map(message=>element('li',message));
  $('route-exclusions').replaceChildren(...diagnosticRows,...unavailable);
  const selected=models.find(model=>routeKey(model)===preferred&&model.readiness?.eligible) ??
    models.find(model=>model.id===task?.model&&model.engine===task.attempts.at(-1)?.provider&&
      routeBackend(model)===(task.attempts.at(-1)?.backend??(task.attempts.at(-1)?.provider==='fixture'?'fixture':'ollama'))&&model.readiness?.eligible) ??
    [...models].filter(model=>model.bytes&&model.readiness?.eligible).sort((a,b)=>a.bytes-b.bytes)[0] ??
    models.find(model=>model.readiness?.eligible);
  $('model').value=selected?routeKey(selected):'';
  $('approve').checked=false;
  showRoute();
}
async function openTask(id,{chooseRoute=false}={}) {
  if(sessionGate.locked())return;
  const epoch=sessionGate.epoch();
  releaseView();
  observer.stop();
  const stamp=++selection;
  const [record, inventory]=await Promise.all([api('/api/tasks/'+id),api('/api/models')]);
  if (stamp!==selection||!sessionGate.current(epoch)) return;
  task=record;
  remember(id);
  connection='connected';
  needsReconcile=false;
  $('connection').hidden=true;
  editing=undefined;
  lease=undefined;
  detached=false;
  populateRoutes(inventory);
  if(chooseRoute&&task.status==='draft'){$('model').value='';$('approve').checked=false;showRoute();}
  $('compose').hidden=true;
  $('detail').hidden=false;
  render();
  $('task-title').focus();
  observer.start(id,850);
  await refreshList();
}

function renderProgress(attempt) {
  const box=$('progress');
  const progress=active(task.status)&&connection==='connected'?describeProgress(task,attempt):null;
  const announcement=progressAnnouncement(task,progress,connection);
  if ($('progress-announcement').textContent!==announcement) $('progress-announcement').textContent=announcement;
  box.hidden=!attempt;
  box.replaceChildren();
  if (box.hidden) return;
  if (connection!=='connected') {
    box.append(element('p','The saved task state may be stale while the workspace is disconnected.'));
    return;
  }
  if (!active(task.status)) {
    box.append(element('h2','Attempt status'));
    if (announcement) box.append(element('p',announcement));
    if (attempt?.problem) box.append(element('p',attempt.problem));
    if (task.recovery?.blocked && task.recovery.message!==attempt?.problem) box.append(element('p',task.recovery.message));
    if (task.status==='review') {
      const checks=attempt.checks??[];
      const failed=checks.filter(check=>!check.pass).length;
      box.append(element('p',checks.length?checks.length+' structural check(s) completed; '+failed+' need attention. Review accuracy before accepting.'
        :'No automated checks were recorded.'));
    }
    return;
  }
  box.append(element('h2',attempt?.provider==='fixture'?'Synthetic fixture request':'Local model request'));
  box.append(element('p',progress.explanation));
  const dl=element('dl');
  definition(dl,[['Status',progress.status],['Current step',progress.status],
    ['Completed','Scope approved'],['Remaining',progress.remaining],
    ['Elapsed',seconds(progress.elapsedMs)],['Output',progress.chars===null?null:progress.chars+' characters; total unknown'],
    ['Rate',progress.rate===null?null:progress.rate.toFixed(1)+' characters/s since dispatch'],
    ['Workspace heartbeat',progress.heartbeat===null?null:new Date(progress.heartbeat).toLocaleTimeString()],
    ['Last activity recorded',progress.lastActivity===null?null:new Date(progress.lastActivity).toLocaleTimeString()],
    ['Current step ETA',progress.eta],['Projected local completion',progress.completion]]);
  box.append(dl);
  // Keep the control stable while polling so keyboard focus is retained.
}
const cancel=element('button','Cancel request');
cancel.onclick=()=>act(async()=>{
  await api(path()+'/cancel',{version:task.version});
  note('Cancellation requested.');
});
$('progress').after(cancel);

function renderUsage() {
  const box=$('usage');
  const expanded=new Map([...box.querySelectorAll('details[data-attempt]')].map(node=>[node.dataset.attempt,node.open]));
  const expandedSteps=new Set([...box.querySelectorAll('details[data-steps]')].filter(node=>node.open).map(node=>node.dataset.steps));
  const focused=document.activeElement?.closest('#usage details[data-attempt]')?.dataset.attempt;
  const focusedSteps=document.activeElement?.closest('#usage details[data-steps]')?.dataset.steps;
  box.replaceChildren();
  if (!task.attempts.length) box.append(element('p','Usage appears after a run.'));
  const complete=task.attempts.filter(attempt=>['provider reported','OpenCode reported'].includes(attempt.usage?.evidence));
  const coverage=summarizeUsage(task.attempts);
  if (coverage.attempts) {
    box.append(element('p',coverage.attempts+' attempt(s): '+coverage.finished+' with a recorded outcome, '+coverage.unresolved+
      ' unresolved, '+coverage.active+' active. '+coverage.observed+' have usage events and '+coverage.reported+' have numeric fields.'));
    if (coverage.totalElapsedMs!==null) box.append(element('p','Recorded local attempt time: '+seconds(coverage.totalElapsedMs)+
      ' across '+coverage.timed+' of '+coverage.ended+' locally ended attempt(s), including failures and retries. Unresolved work may continue beyond the recorded time.'));
    if (coverage.missing) box.append(element('p',coverage.missing+' ended attempt(s) have no usable numeric usage fields. Missing values are not counted as zero.'));
    if (coverage.pending) box.append(element('p',coverage.pending+' active attempt(s) are still awaiting a final usage receipt.'));
    for(const [key,title] of [['provider','Direct provider reporting'],['opencode','OpenCode engine reporting']]) {
      const group=coverage.groups[key];
      if(!group.attempts)continue;
      box.append(element('h3',title));
      const counters=element('dl');
      const labels=key==='opencode'
        ?[['OpenCode input, engine-defined','input'],['OpenCode output, engine-defined','output'],
          ['OpenCode cache read','cached'],['OpenCode cache write','cacheWrite'],['OpenCode reasoning','reasoning']]
        :[['Provider input','input'],['Provider output','output'],['Provider cache read','cached'],['Provider reasoning','reasoning']];
      definition(counters,labels.map(([label,field])=>{
        const item=group.counters[field];
        const amount=item.overflow?'Unavailable: reported counts exceed the safe display range'
          :item.value===null?'Unavailable':item.value.toLocaleString()+' reported';
        return [label,amount+' across '+item.reported+' of '+item.attempts+' attempts'+
          (item.partial?' ('+item.partial+' OpenCode attempt'+(item.partial===1?'':'s')+' with partial coverage)':'')];
      }));
      box.append(counters);
    }
    box.append(element('p','OpenCode can normalize token categories and use zero for missing provider values. Its figures are engine-reported, not a provider invoice, and are not combined with direct provider figures.'));
    box.append(element('p','Cache and reasoning values are provider-reported categories. They may overlap other token counts and should not be added together.'));
    box.append(element('p','The endpoint is on this computer, but any upstream destination and provider charges are not independently verified. Electricity and hardware costs are not included.'));
  }
  const accepted=complete.filter(attempt=>attempt.status==='accepted'&&typeof attempt.elapsedMs==='number'&&Number.isFinite(attempt.elapsedMs));
  const chosen=accepted.at(-1);
  const baseline=accepted.find(attempt=>attempt.model!==chosen?.model);
  if (baseline && chosen) {
    const delta=chosen.elapsedMs-baseline.elapsedMs;
    box.append(element('p','Observed request comparison for the same source and task. '+chosen.model+' took '+seconds(Math.abs(delta))+
      (delta>0?' longer than ':delta<0?' less than ':' compared with ')+baseline.model+
      '. One run per model. Both proposals were accepted, but equivalent quality was not independently measured.'));
  }
  for (const [i,attempt] of task.attempts.entries()) {
    const detail=element('details');
    detail.dataset.attempt=attempt.id;
    detail.open=expanded.get(attempt.id) ?? i===task.attempts.length-1;
    detail.append(element('summary','Attempt '+(i+1)+' · '+attempt.model+' · '+(labels[attempt.status]??attempt.status)));
    const usage=attempt.usage;
    const openCodeUsage=usage?.evidence==='OpenCode reported';
    const dl=element('dl');
    const stepReceipt=describeStepReceipt(usage);
    definition(dl,[['Evidence',usage?.evidence],['Receipt coverage',usage?.evidence==='OpenCode reported'
      ? stepReceipt?'Totals cover recorded steps only when identity and the relevant counts allow. Missing events are not known.'
        :'Last reported OpenCode step. Earlier or missing steps are not included.'
      : usage?.evidence==='provider reported'?'Final provider response; missing fields remain unavailable.':null],
      ['Route',attempt.provider==='fixture'?'Synthetic fixture':attempt.backend==='llamacpp'?'OpenCode → loopback llama.cpp':
        attempt.provider==='opencode'?'OpenCode → loopback Ollama':'Loopback Ollama endpoint'],
      [attempt.backend==='llamacpp'?'Quantization (server reported)':'Quantization',attempt.quantization],
      [openCodeUsage?'OpenCode input, engine-defined':'Input tokens',usage?.input],
      ['Cached input tokens',usage?.cached],[openCodeUsage?'OpenCode cache write':'Cache write tokens',usage?.cacheWrite],
      [openCodeUsage?'OpenCode output, engine-defined':'Output tokens',usage?.output],['Model load',seconds(usage?.loadMs)],['Prompt evaluation',seconds(usage?.promptMs)],
      ['Reported reasoning tokens',usage?.reasoning],
      ['Generation',seconds(usage?.generationMs)],['Attempt wall time',seconds(attempt.elapsedMs)],
      ['Provider reported total',seconds(usage?.providerMs)],
      ['Generation rate',usage?.generationMs && usage.output!=null?(usage.output*1000/usage.generationMs).toFixed(2)+' tokens/s':null],
      ['Provider charge',usage?.providerCharge===0?'Legacy zero value; provider charge not independently verified':null]]);
    detail.append(dl);
    if(stepReceipt) {
      const steps=element('details');
      steps.dataset.steps=attempt.id;
      steps.open=expandedSteps.has(attempt.id);
      steps.append(element('summary','Observed OpenCode steps ('+stepReceipt.items.length+' recorded)'));
      for(const message of stepReceipt.notes)steps.append(element('p',message));
      const list=element('ol');
      for(const item of stepReceipt.items) {
        const row=element('li');
        const metrics=element('dl');
        definition(metrics,[['OpenCode input, engine-defined',item.input],['OpenCode output, engine-defined',item.output],
          ['Cache read tokens',item.cached],['Cache write tokens',item.cacheWrite],['Reasoning tokens',item.reasoning]]);
        row.append(metrics);
        list.append(row);
      }
      steps.append(list);
      detail.append(steps);
    }
    box.append(detail);
    if (focusedSteps===attempt.id) detail.querySelector('details[data-steps] summary')?.focus({preventScroll:true});
    else if (focused===attempt.id) detail.querySelector('summary').focus({preventScroll:true});
  }
}
function renderTerminal(attempt) {
  const openCode=attempt?.provider==='opencode';
  const running=openCode && active(task.status);
  if (!running||!ownsTerminal(task,lease)) lease=undefined;
  $('terminal').hidden=!openCode;
  $('terminal-owner').textContent=connection!=='connected' ? 'Read-only · connection unverified'
    : lease ? 'You have control' : (task.live?.owner==='Operator' ? 'Another view has control' : 'Read-only');
  $('terminal-note').textContent=detached ? 'View detached. Reattach to observe the run.'
    : task.live?.stopping ? 'Stopping OpenCode. Waiting for process exit.'
    : 'Observe this run or take control to check status and stop it.';
  $('terminal-log').hidden=detached;
  const lines=task.live?.terminal ?? attempt?.terminal ?? [];
  const output=lines.map(line=>new Date(line.at).toLocaleTimeString()+'  '+line.message).join('\n');
  if ($('terminal-log').textContent!==output) $('terminal-log').textContent=output;
  $('terminal-take').hidden=!running||detached||!!lease||task.live?.stopping;
  $('terminal-take').textContent=task.live?.owner==='Operator'?'Take over':'Take control';
  for (const id of ['terminal-release','terminal-status','terminal-stop']) $(id).hidden=!running||!lease;
  $('terminal-detach').hidden=detached;
  $('terminal-attach').hidden=!detached;
}
const control=(command,confirm=false)=>api(path()+'/terminal',terminalRequest(task,lease,command,confirm));
function releaseView() {
  if (!task || !lease) return;
  void control('detach').catch(()=>{});
  lease=undefined;
}
$('terminal-take').onclick=()=>act(async()=>{
  const takeover=task.live?.owner==='Operator';
  if (takeover && !window.confirm('Move terminal control from the other view to this view?')) return;
  lease=await control('take',takeover);
  task.live.control={attemptId:lease.attemptId,generation:lease.generation,owner:'Operator',closed:false};
  task.live.owner='Operator';
  render();
});
$('terminal-release').onclick=()=>act(async()=>{
  await control('release');
  lease=undefined;
  task=await api(path());
  render();
});
$('terminal-status').onclick=()=>act(async()=>{await control('status');task=await api(path());render();});
$('terminal-stop').onclick=()=>act(async()=>{
  if (!window.confirm('Stop the managed OpenCode process?')) return;
  await control('stop',true);
  lease=undefined;
  task=await api(path());
  render();
});
$('terminal-detach').onclick=()=>act(async()=>{
  const held=lease;
  lease=undefined;
  detached=true;
  render();
  $('terminal-attach').focus({preventScroll:true});
  // Detach is local observation state even if releasing the old lease fails.
  if(held)await api(path()+'/terminal',terminalRequest(task,held,'detach'));
  task=await api(path());
  render();
});
$('terminal-attach').onclick=()=>{
  if(sessionGate.locked()||connection!=='connected')return;
  detached=false;render();$('terminal-detach').focus({preventScroll:true});
};
function render() {
  const attempt=task.attempts.at(-1);
  $('task-title').textContent=task.title;
  $('status').textContent=labels[task.status];
  definition($('scope-meta'),[['Request',task.request],['File',task.filename??'Pasted text'],
    ['Expected text',task.expected??'Source citation check'],['Snapshot SHA-256',task.sourceHash]]);
  $('source').textContent=task.source;
  $('edit').hidden=task.status!=='draft';
  $('run').hidden=active(task.status)||task.status==='review'||!!task.recovery?.blocked;
  $('run-button').textContent=task.attempts.length?'Approve another attempt':'Approve and run';
  renderProgress(attempt);
  cancel.hidden=!active(task.status)||attempt?.provider==='opencode';
  renderTerminal(attempt);
  $('result').hidden=!attempt?.artifact;
  if (attempt?.artifact) {
    $('summary').textContent=attempt.artifact.summary;
    const originalRaw=attempt.originalArtifact?.rawContent??attempt.artifact.rawContent;
    $('raw-proposal').hidden=!originalRaw;
    $('raw-proposal-content').textContent=originalRaw??'';
    $('original-proposal').hidden=!attempt.originalArtifact?.content;
    $('original-proposal-content').textContent=attempt.originalArtifact?.content??'';
    $('before').textContent=task.source;
    $('artifact').textContent=attempt.artifact.content;
    $('patch-review').hidden=!attempt.artifact.patch;
    $('patch').textContent=attempt.artifact.patch??'';
    $('comparison').classList.toggle('single',task.kind==='brief');
    $('checks').replaceChildren(...attempt.checks.map(check=>{
      const li=element('li',(check.pass?'Pass · ':'Fail · ')+check.name);
      li.className=check.pass?'pass':'fail';
      return li;
    }));
    $('accept').hidden=$('reject').hidden=task.status!=='review';
    $('edit-proposal').hidden=task.status!=='review';
    $('accept').disabled=attempt.checks.some(check=>!check.pass);
    $('download').hidden=task.status!=='accepted';
    $('download-patch').hidden=task.status!=='accepted'||!attempt.artifact.patch;
  }
  renderUsage();
  $('events').replaceChildren(...task.events.map(event=>element('li',new Date(event.at).toLocaleString()+' · '+event.event.replaceAll('.',' / ').replaceAll('_',' '))));
  const actionsBlocked=connection!=='connected'||needsReconcile||sessionGate.locked();
  for (const id of ['run-button','terminal-take','terminal-release','terminal-status','terminal-stop','terminal-detach','terminal-attach','edit','edit-proposal','reject','copy-task','download','download-patch','refresh-routes','export','remove-task']) {
    $(id).disabled=actionsBlocked;
  }
  $('new-task').disabled=actionsBlocked||busy;
  cancel.disabled=actionsBlocked;
  $('accept').disabled=actionsBlocked||!attempt?.checks||attempt.checks.some(check=>!check.pass);
}
function download(name,content,type='text/plain') {
  const url=URL.createObjectURL(new Blob([content],{type}));
  const anchor=element('a');
  anchor.href=url;
  anchor.download=name;
  anchor.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
$('new-task').onclick=()=>{
  if (busy||sessionGate.locked()||connection!=='connected') return;
  releaseView();
  selection++;
  task=undefined;
  editing=undefined;
  observer.stop();
  remember(null);
  $('connection').hidden=true;
  $('detail').hidden=true;
  $('compose').hidden=false;
  note();
  field('title').focus();
};
field('kind').onchange=()=>{$('change-fields').hidden=field('kind').value!=='change';};
$('edit').onclick=()=>{
  if(sessionGate.locked()||connection!=='connected')return;
  editing={id:task.id,version:task.version};
  for (const name of ['title','kind','request','source','filename','expected']) field(name).value=task[name]??'';
  field('kind').onchange();
  $('compose').hidden=false;
  $('detail').hidden=true;
  field('source').focus();
};
$('file').onchange=()=>act(async()=>{
  const file=$('file').files[0];
  if (!file) return;
  if (file.size>20000) throw Error('This preview accepts a small text file, up to 5,000 characters.');
  const source=await file.text();
  if (source.length>5000 || source.includes('\0')) throw Error('Choose a text file of at most 5,000 characters.');
  field('source').value=source;
  field('filename').value=file.name;
});
form.onsubmit=event=>{
  event.preventDefault();
  void act(async()=>{
    const fields=Object.fromEntries(new FormData(form));
    const created=editing
      ? await api('/api/tasks/'+editing.id+'/scope',{...fields,version:editing.version})
      : await api('/api/tasks',fields);
    await openTask(created.id);
  });
};
$('model').onchange=()=>{$('approve').checked=false;showRoute();};
$('refresh-routes').onclick=()=>act(async()=>{
  const preferred=$('model').value;
  populateRoutes(await api('/api/models'),preferred);
  note('Routes refreshed. Review the selected route and approve the scope again.');
});
$('run').onsubmit=event=>{
  event.preventDefault();
  void act(async()=>{
    const route=models.find(model=>routeKey(model)===$('model').value);
    if (!route?.readiness?.eligible) throw Error('Select an eligible route or refresh the route list.');
    task=await api(path()+'/run',{version:task.version,sourceHash:task.sourceHash,model:route.id,engine:route.engine,
      backend:routeBackend(route),modelDigest:route.digest??null,modelFingerprint:route.fingerprint??null,approve:$('approve').checked});
    detached=false;
    $('approve').checked=false;
    render();
    observer.start(task.id,850);
    await refreshList();
  });
};
for (const [id,decision] of [['accept','accepted'],['reject','rejected']]) $(id).onclick=()=>act(async()=>{
  task=await api(path()+'/review',{version:task.version,decision,artifactHash:task.attempts.at(-1).artifact.sha256});
  render();
  await refreshList();
});
bindProposalEditor({openButton:$('edit-proposal'),dialog:$('proposal-dialog'),form:$('proposal-form'),
  content:$('proposal-content'),status:$('proposal-status'),saveButton:$('proposal-save'),cancelButton:$('proposal-cancel'),
  normalizeChoice:$('proposal-normalize'),normalizeGroup:$('proposal-normalize-group'),
  current:()=>task?{id:task.id,version:task.version,status:task.status,artifact:task.attempts.at(-1)?.artifact}:null,
  submit:(id,body)=>api('/api/tasks/'+id+'/revise',body),onSaved:(id,result)=>{
    if(task?.id===id && result.version>=task.version) {task=result;render();note('Edited proposal saved for review.');}
    void refreshList().catch(()=>note('Edited proposal saved, but the task list could not be refreshed.'));
  }});
$('download').onclick=()=>{
  if(sessionGate.locked()||connection!=='connected')return;
  download(task.kind==='change'?'proposed-'+task.filename:'brief.md',task.attempts.at(-1).artifact.content);
};
$('download-patch').onclick=()=>{
  if(sessionGate.locked()||connection!=='connected')return;
  download('proposal.patch',task.attempts.at(-1).artifact.patch);
};
bindDraftCopyDialog({openButton:$('copy-task'),dialog:$('copy-dialog'),target:$('copy-target'),status:$('copy-status'),
  copyButton:$('copy-submit'),checkButton:$('copy-check'),retryButton:$('copy-retry'),closeButton:$('copy-close'),current:()=>task,
  submit:(id,body)=>api('/api/tasks/'+id+'/copy-draft',body),
  lookup:requestId=>api('/api/draft-copies/'+requestId),onCopied:id=>{
    void act(async()=>{await openTask(id,{chooseRoute:true});note('Opened the saved copy. Review its scope and select a route before approving a run.');});
  }});
bindExportDialog({openButton:$('export'),dialog:$('export-dialog'),mode:$('export-mode'),
  description:$('export-description'),status:$('export-status'),preview:$('export-preview'),
  saveButton:$('export-save'),closeButton:$('export-close'),currentTaskId:()=>task?.id,
  load:(id,mode)=>api('/api/tasks/'+id+'/export?mode='+encodeURIComponent(mode)),
  download:content=>download('harness-task-metadata.json',content,'application/json')});
bindRemovalDialog({openButton:$('remove-task'),dialog:$('removal-dialog'),target:$('removal-target'),preview:$('removal-preview'),
  status:$('removal-status'),confirmation:$('removal-confirmation'),removeButton:$('removal-submit'),closeButton:$('removal-close'),
  currentTaskId:()=>task?.id,load:id=>api('/api/tasks/'+id+'/removal-preview'),
  remove:(id,body)=>api('/api/tasks/'+id+'/remove',body),onRemoved:id=>{
    if(sessionGate.locked())return;
    if(task?.id===id) {
      observer.stop();lease=undefined;task=undefined;editing=undefined;remember(null);selection++;
      form.reset();
      for(const name of ['title','request','source','filename','expected'])field(name).value='';
      field('kind').onchange();
      for(const name of ['task-title','status','scope-meta','source','before','artifact','summary','checks','patch','events','usage','progress','original-proposal-content','raw-proposal-content'])
        $(name).replaceChildren();
      $('detail').hidden=true;$('compose').hidden=false;
    }
    note('Task record removed. OpenCode files, backups and provider copies were not removed.');
    void refreshList().catch(()=>note('Task record removed, but the task list could not be refreshed.'));
  }});
async function enter() {
  explicitLock=null;
  $('access-status').textContent='';
  $('lock-workspace').hidden=true;
  const epoch=sessionGate.unlock();
  try {
    await refreshList();
    if(!sessionGate.current(epoch))return;
    connection='connected';
    $('connection').hidden=true;
    $('unlock').hidden=true;
    $('workspace').hidden=false;
    $('lock-workspace').hidden=false;
    watchList();
    const id=task?.id??remembered();
    if (id) {
      try { await openTask(id); }
      catch(error) {
        if (error.status===404) remember(null);
        else if(!sessionGate.current(epoch))return;
        else throw error;
      }
    }
  } catch(error) {
    if(!sessionGate.current(epoch))return;
    concealLocalSession();
    $('lock-workspace').hidden=true;
    throw error;
  }
}
$('access-file').onchange=async()=>{
  const input=$('access-file'), file=input.files[0];
  if (!file) return;
  try {
    if (file.size>256) throw Error('Choose the workspace access file.');
    await api('/api/session',{key:(await file.text()).trim()});
    await enter();
  } catch(error) { $('access-status').textContent=error.message; }
  finally { input.value=''; }
};
void enter().catch(()=>{});
