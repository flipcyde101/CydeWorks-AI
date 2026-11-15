import {createHash,randomUUID} from 'node:crypto';

const roles=new Set(['planner','researcher','builder','reviewer']);
const identifier=/^[a-z][a-z0-9_-]{0,39}$/;
const digest=/^[a-f0-9]{64}$/;
const fail=message=>{throw new Error(message);};
const hash=value=>createHash('sha256').update(value).digest('hex');

function text(value,max,label) {
  if(typeof value!=='string'||!value.trim()||value.length>max)fail('Invalid '+label+'.');
  return value.trim();
}
function workspacePath(value) {
  const item=text(value,240,'file ownership path');
  if(item!==value||item.startsWith('/')||/[\x00-\x1f<>:"\\|?*]/.test(item)||
    item.split('/').some(part=>!part||part==='.'||part==='..'||part.endsWith('.')||part.endsWith(' ')||
      /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i.test(part))) {
    fail('File ownership must use a relative path without traversal.');
  }
  return item;
}
function overlaps(first,second) {
  const a=first,b=second;
  return a===b||a.startsWith(b+'/')||b.startsWith(a+'/');
}

export function prepareSwarmPlan(input) {
  if(!input||typeof input!=='object'||Array.isArray(input))fail('A swarm plan is required.');
  const title=text(input.title,120,'plan title');
  if(typeof input.scopeHash!=='string'||!digest.test(input.scopeHash))fail('A source snapshot hash is required.');
  if(!Number.isInteger(input.maxConcurrent)||input.maxConcurrent<1||input.maxConcurrent>16)fail('Choose between 1 and 16 concurrent agents.');
  if(!Array.isArray(input.nodes)||input.nodes.length<1||input.nodes.length>64)fail('A swarm requires between 1 and 64 tasks.');
  let totalWrites=0;
  const nodes=input.nodes.map(node=>{
    if(!node||typeof node!=='object'||Array.isArray(node)||typeof node.id!=='string'||!identifier.test(node.id))fail('Invalid task identifier.');
    if(!roles.has(node.role))fail('Choose a supported agent role.');
    if(!node.route||typeof node.route!=='object'||Array.isArray(node.route)||
      typeof node.route.engine!=='string'||!/^[a-z][a-z0-9_-]{0,39}$/.test(node.route.engine))fail('Choose a valid agent engine.');
    const route={engine:node.route.engine,model:text(node.route.model,100,'agent model')};
    if(!Array.isArray(node.dependsOn)||!Array.isArray(node.writes)||node.dependsOn.length>64||node.writes.length>64)fail('Dependencies and file ownership must be lists.');
    totalWrites+=node.writes.length;
    if(totalWrites>256)fail('A swarm can have at most 256 file ownership entries.');
    if(node.dependsOn.some(id=>typeof id!=='string'||!identifier.test(id)))fail('Invalid dependency identifier.');
    const dependsOn=[...new Set(node.dependsOn)].sort();
    const writes=[...new Set(node.writes.map(workspacePath))].sort();
    if(dependsOn.length!==node.dependsOn.length||writes.length!==node.writes.length)fail('Duplicate dependencies or file ownership entries are not allowed.');
    return {id:node.id,role:node.role,request:text(node.request,2000,'agent request'),route,dependsOn,writes};
  });
  const byId=new Map(nodes.map(node=>[node.id,node]));
  if(byId.size!==nodes.length)fail('Task identifiers must be unique.');
  for(const node of nodes)for(const dep of node.dependsOn)if(!byId.has(dep)||dep===node.id)fail('A task dependency is missing or self-referential.');
  const visiting=new Set(),visited=new Set();
  function visit(id) {
    if(visiting.has(id))fail('Task dependencies contain a cycle.');
    if(visited.has(id))return;
    visiting.add(id);
    for(const dep of byId.get(id).dependsOn)visit(dep);
    visiting.delete(id);visited.add(id);
  }
  for(const node of nodes)visit(node.id);
  function depends(node,target) {
    const stack=[...node.dependsOn],seen=new Set();
    while(stack.length) {
      const id=stack.pop();
      if(id===target)return true;
      if(seen.has(id))continue;
      seen.add(id);
      stack.push(...byId.get(id).dependsOn);
    }
    return false;
  }
  const ownership=nodes.map(node=>node.writes.map(path=>path.normalize('NFC').toLowerCase()));
  for(let i=0;i<nodes.length;i++)for(let j=i+1;j<nodes.length;j++) {
    const a=nodes[i],b=nodes[j];
    if(ownership[i].some(x=>ownership[j].some(y=>overlaps(x,y)))&&!depends(a,b.id)&&!depends(b,a.id)) {
      fail('Tasks with overlapping file ownership need an explicit dependency.');
    }
  }
  const plan={version:1,title,scopeHash:input.scopeHash,maxConcurrent:input.maxConcurrent,nodes};
  return {plan,planHash:hash(JSON.stringify(plan))};
}

// This coordinator has no model, shell, network or filesystem execution.
// An independently qualified broker must consume claims and enforce scope.
export class SwarmCoordinator {
  constructor(db,{clock=()=>Number(process.hrtime.bigint()/1000000n),nonce=randomUUID}={}) {
    this.db=db;this.clock=clock;this.nonce=nonce;this.grants=new Map();
    db.exec(`CREATE TABLE IF NOT EXISTS swarm_plans (
      id TEXT PRIMARY KEY, definition TEXT NOT NULL, digest TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL, grant_id TEXT
    ); CREATE TABLE IF NOT EXISTS swarm_nodes (
      swarm_id TEXT NOT NULL, node_id TEXT NOT NULL, status TEXT NOT NULL, claim TEXT, artifact TEXT,
      PRIMARY KEY(swarm_id,node_id)
    ); CREATE TABLE IF NOT EXISTS swarm_events (
      swarm_id TEXT NOT NULL, seq INTEGER NOT NULL, event TEXT NOT NULL, node_id TEXT, at TEXT NOT NULL,
      PRIMARY KEY(swarm_id,seq)
    )`);
    this.readPlan=db.prepare('SELECT * FROM swarm_plans WHERE id=?');
    this.readNodes=db.prepare('SELECT * FROM swarm_nodes WHERE swarm_id=?');
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {const value=fn();this.db.exec('COMMIT');return value;}
    catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  event(id,name,nodeId=null) {
    const row=this.readPlan.get(id);
    const version=row.version+1;
    this.db.prepare('UPDATE swarm_plans SET version=? WHERE id=?').run(version,id);
    this.db.prepare('INSERT INTO swarm_events VALUES (?,?,?,?,?)').run(id,version,name,nodeId,new Date().toISOString());
  }
  create(input) {
    const {plan,planHash}=prepareSwarmPlan(input),id=this.nonce();
    this.transaction(()=>{
      this.db.prepare('INSERT INTO swarm_plans VALUES (?,?,?,?,?,?)').run(id,JSON.stringify(plan),planHash,'draft',0,null);
      const insert=this.db.prepare('INSERT INTO swarm_nodes VALUES (?,?,?,?,?)');
      for(const node of plan.nodes)insert.run(id,node.id,'pending',null,null);
      this.event(id,'plan.created');
    });
    return this.view(id);
  }
  view(id) {
    const row=this.readPlan.get(id);
    if(!row)fail('Swarm not found.');
    const states=new Map(this.readNodes.all(id).map(node=>[node.node_id,node]));
    const plan=JSON.parse(row.definition);
    return {id,version:row.version,status:row.status,planHash:row.digest,plan,
      nodes:plan.nodes.map(node=>({id:node.id,status:states.get(node.id).status,artifactHash:states.get(node.id).artifact}))};
  }
  approve(id,planHash,scopeHash,ttlMs=3600000) {
    if(!Number.isSafeInteger(ttlMs)||ttlMs<1||ttlMs>86400000)fail('The approval duration is invalid.');
    const grantId=this.nonce();
    this.transaction(()=>{
      const row=this.readPlan.get(id);
      if(!row)fail('Swarm not found.');
      const plan=JSON.parse(row.definition);
      if(row.digest!==planHash||hash(row.definition)!==row.digest||plan.scopeHash!==scopeHash)fail('The plan or source snapshot changed.');
      if(!['draft','needs-approval'].includes(row.status))fail('This plan cannot be approved in its current state.');
      this.db.prepare('UPDATE swarm_plans SET status=?,grant_id=? WHERE id=?').run('approved',grantId,id);
      this.event(id,'plan.approved');
    });
    this.grants.set(id,{grantId,planHash,scopeHash,deadline:this.clock()+ttlMs});
    return this.view(id);
  }
  claimReady(id,scopeHash) {
    const grant=this.grants.get(id);
    const result=this.transaction(()=>{
      const row=this.readPlan.get(id);
      if(!grant||!row||row.grant_id!==grant.grantId)return {error:'Swarm approval is missing or expired.'};
      if(this.clock()>=grant.deadline) {
        if(['approved','running'].includes(row.status)) {
          const running=this.readNodes.all(id).some(node=>node.status==='running');
          this.db.prepare('UPDATE swarm_plans SET status=?,grant_id=NULL WHERE id=?').run(running?'needs-attention':'needs-approval',id);
          this.event(id,'approval.expired');
        }
        return {error:'Swarm approval is missing or expired.'};
      }
      if(!row||row.digest!==grant.planHash||hash(row.definition)!==row.digest||grant.scopeHash!==scopeHash)fail('The approved plan or source snapshot changed.');
      if(!['approved','running'].includes(row.status))fail('This swarm needs attention before further work.');
      const plan=JSON.parse(row.definition),states=new Map(this.readNodes.all(id).map(node=>[node.node_id,node]));
      if([...states.values()].some(node=>['unknown','failed'].includes(node.status)))fail('A previous agent outcome needs review.');
      let slots=plan.maxConcurrent-[...states.values()].filter(node=>node.status==='running').length;
      const claims=[];
      for(const node of plan.nodes) {
        if(slots<=0)break;
        if(states.get(node.id).status!=='pending'||!node.dependsOn.every(dep=>states.get(dep).status==='succeeded'))continue;
        const claim=this.nonce();
        this.db.prepare('UPDATE swarm_nodes SET status=?,claim=? WHERE swarm_id=? AND node_id=? AND status=?')
          .run('running',claim,id,node.id,'pending');
        claims.push({nodeId:node.id,claim,role:node.role,request:node.request,route:node.route,writes:node.writes,
          approval:{grantId:grant.grantId,planHash:grant.planHash,scopeHash:grant.scopeHash,deadline:grant.deadline}});
        this.event(id,'node.claimed',node.id);
        slots--;
      }
      if(claims.length)this.db.prepare('UPDATE swarm_plans SET status=? WHERE id=?').run('running',id);
      return {claims};
    });
    if(result.error){this.grants.delete(id);fail(result.error);}
    return result.claims;
  }
  validateDispatch(id,nodeId,claim,scopeHash) {
    return this.transaction(()=>{
      const grant=this.grants.get(id),row=this.readPlan.get(id);
      if(!grant||!row||row.grant_id!==grant.grantId||this.clock()>=grant.deadline||
        row.digest!==grant.planHash||hash(row.definition)!==row.digest||grant.scopeHash!==scopeHash||row.status!=='running') {
        fail('The agent approval is missing, expired or changed.');
      }
      const node=this.readNodes.all(id).find(item=>item.node_id===nodeId);
      if(!node||node.status!=='running'||node.claim!==claim)fail('The agent claim is no longer valid.');
      return {planHash:grant.planHash,scopeHash:grant.scopeHash,grantId:grant.grantId,deadline:grant.deadline};
    });
  }
  finish(id,nodeId,claim,{status,artifactHash=null}) {
    if(!['succeeded','failed'].includes(status))fail('Unsupported agent outcome.');
    if(status==='succeeded'&&(typeof artifactHash!=='string'||!digest.test(artifactHash)))fail('A verified artifact hash is required.');
    if(status==='failed'&&artifactHash!==null)fail('A failed agent cannot provide an accepted artifact.');
    const result=this.transaction(()=>{
      const node=this.readNodes.all(id).find(item=>item.node_id===nodeId);
      if(!node||node.claim!==claim)fail('The agent claim is no longer valid.');
      if(node.status===status&&node.artifact===artifactHash)return {duplicate:true};
      if(node.status!=='running')fail('The agent outcome conflicts with an earlier result.');
      this.db.prepare('UPDATE swarm_nodes SET status=?,artifact=? WHERE swarm_id=? AND node_id=?').run(status,artifactHash,id,nodeId);
      this.event(id,'node.'+status,nodeId);
      const states=this.readNodes.all(id);
      const grant=this.grants.get(id),validGrant=grant&&this.clock()<grant.deadline;
      const next=states.some(item=>item.status==='failed')?'needs-attention'
        :states.every(item=>item.status==='succeeded')?'completed'
        :validGrant?'running':states.some(item=>item.status==='running')?'needs-attention':'needs-approval';
      this.db.prepare('UPDATE swarm_plans SET status=?,grant_id=CASE WHEN ? IN (\'completed\',\'needs-approval\') THEN NULL ELSE grant_id END WHERE id=?').run(next,next,id);
      return {duplicate:false,closedGrant:['completed','needs-approval'].includes(next)};
    });
    if(result.closedGrant)this.grants.delete(id);
    return {duplicate:result.duplicate};
  }
  recoverInterrupted() {
    return this.transaction(()=>{
      const rows=this.db.prepare("SELECT id FROM swarm_plans WHERE grant_id IS NOT NULL OR status IN ('approved','running') OR EXISTS (SELECT 1 FROM swarm_nodes WHERE swarm_id=swarm_plans.id AND status='running')").all();
      for(const {id} of rows) {
        this.db.prepare("UPDATE swarm_nodes SET status='unknown',claim=NULL WHERE swarm_id=? AND status='running'").run(id);
        const nodes=this.readNodes.all(id);
        const unknown=nodes.some(node=>node.status==='unknown'),failed=nodes.some(node=>node.status==='failed');
        const next=unknown?'needs-recovery':failed?'needs-attention':'needs-approval';
        this.db.prepare('UPDATE swarm_plans SET status=?,grant_id=NULL WHERE id=?').run(next,id);
        this.event(id,unknown?'swarm.interrupted':failed?'swarm.needs-attention':'approval.expired');
        this.grants.delete(id);
      }
      return rows.length;
    });
  }
}
