// A local accounting primitive. It is not connected to a provider, router or paid route.
// Provider adapters must establish their own semantics before importing events here.
const MAX_AMOUNT=1000000000000;
const FIELDS=['input','output','cached','reasoning'];
const identifier=(value,label)=>{
  if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(value)) throw Error('Invalid '+label+'.');
  return value;
};
const currency=value=>{
  if(typeof value!=='string'||!/^[A-Z]{3}$/.test(value)) throw Error('Invalid currency.');
  return value;
};
const amount=(value,label)=>{
  if(!Number.isSafeInteger(value)||value<0||value>MAX_AMOUNT) throw Error('Invalid '+label+'.');
  return value;
};
const count=(value,label)=>value===null?null:amount(value,label);
const payload=value=>JSON.stringify(value);

export class UsageLedger {
  constructor(db) {
    this.db=db;
    db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS ledger_usage_events (
        event_id TEXT PRIMARY KEY,attempt_id TEXT NOT NULL,phase TEXT NOT NULL,
        sequence INTEGER NOT NULL,body TEXT NOT NULL,
        UNIQUE(attempt_id,phase,sequence));
      CREATE TABLE IF NOT EXISTS ledger_budgets (
        id TEXT PRIMARY KEY,currency TEXT NOT NULL,cap INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS ledger_reservations (
        id TEXT PRIMARY KEY,attempt_id TEXT NOT NULL UNIQUE,currency TEXT NOT NULL,
        amount INTEGER NOT NULL,state TEXT NOT NULL,charge INTEGER,body TEXT NOT NULL,
        dispatch_claimed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS ledger_allocations (
        reservation_id TEXT NOT NULL REFERENCES ledger_reservations(id),
        budget_id TEXT NOT NULL REFERENCES ledger_budgets(id),PRIMARY KEY(reservation_id,budget_id));
      CREATE TABLE IF NOT EXISTS ledger_charge_events (
        event_id TEXT PRIMARY KEY,reservation_id TEXT NOT NULL REFERENCES ledger_reservations(id),
        body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ledger_release_events (
        event_id TEXT PRIMARY KEY,reservation_id TEXT NOT NULL REFERENCES ledger_reservations(id),
        body TEXT NOT NULL);`);
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {const result=fn();this.db.exec('COMMIT');return result;}
    catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
  recordUsage(event) {
    if(!event||typeof event!=='object') throw Error('Invalid usage event.');
    const normalized={eventId:identifier(event.eventId,'event id'),attemptId:identifier(event.attemptId,'attempt id'),
      phase:event.phase,sequence:amount(event.sequence,'sequence'),evidence:event.evidence};
    if(!['partial','final'].includes(normalized.phase)||!['reported','estimated'].includes(normalized.evidence))
      throw Error('Invalid usage event provenance.');
    for(const field of FIELDS) normalized[field]=count(event[field]??null,field);
    const body=payload(normalized);
    return this.transaction(()=>{
      const existing=this.db.prepare('SELECT body FROM ledger_usage_events WHERE event_id=?').get(normalized.eventId);
      if(existing) {
        if(existing.body!==body)throw Error('Usage event id conflict.');
        return {duplicate:true};
      }
      if(normalized.phase==='final' && this.db.prepare("SELECT event_id FROM ledger_usage_events WHERE attempt_id=? AND phase='final' LIMIT 1").get(normalized.attemptId))
        throw Error('Final usage already exists; an audited correction is required.');
      const sequence=this.db.prepare('SELECT body FROM ledger_usage_events WHERE attempt_id=? AND phase=? AND sequence=?')
        .get(normalized.attemptId,normalized.phase,normalized.sequence);
      if(sequence)throw Error('Usage event sequence conflict.');
      this.db.prepare('INSERT INTO ledger_usage_events VALUES (?,?,?,?,?)')
        .run(normalized.eventId,normalized.attemptId,normalized.phase,normalized.sequence,body);
      return {duplicate:false};
    });
  }
  getUsage(attemptId) {
    identifier(attemptId,'attempt id');
    const row=this.db.prepare(`SELECT body FROM ledger_usage_events WHERE attempt_id=?
      ORDER BY CASE phase WHEN 'final' THEN 1 ELSE 0 END DESC,sequence DESC LIMIT 1`).get(attemptId);
    return row?JSON.parse(row.body):null;
  }
  sumUsage(attemptIds) {
    if(!Array.isArray(attemptIds)||attemptIds.length>10000)throw Error('Invalid attempt ids.');
    return this.transaction(()=>{
      const records=[...new Set(attemptIds.map(id=>identifier(id,'attempt id')))].map(id=>this.getUsage(id));
      return Object.fromEntries(FIELDS.map(field=>{
        let total=0,known=0,overflow=false;
        const byEvidence={reported:{value:0,known:0},estimated:{value:0,known:0}};
        for(const record of records) {
          if(record?.[field]===null||record?.[field]===undefined)continue;
          known++;
          const source=byEvidence[record.evidence];
          source.known++;
          if(!Number.isSafeInteger(source.value+record[field]))source.overflow=true;
          else if(!source.overflow)source.value+=record[field];
          if(!Number.isSafeInteger(total+record[field]))overflow=true;
          else if(!overflow)total+=record[field];
        }
        for(const source of Object.values(byEvidence))if(!source.known||source.overflow)source.value=null;
        return [field,{value:known&&!overflow?total:null,known,missing:records.length-known,byEvidence,...(overflow?{overflow:true}:{})}];
      }));
    });
  }
  createBudget(input) {
    const budget={id:identifier(input?.id,'budget id'),currency:currency(input?.currency),capMicros:amount(input?.capMicros,'budget cap')};
    return this.transaction(()=>{
      const previous=this.db.prepare('SELECT currency,cap FROM ledger_budgets WHERE id=?').get(budget.id);
      if(previous) {
        if(previous.currency!==budget.currency||previous.cap!==budget.capMicros)throw Error('Budget version conflict.');
        return {duplicate:true};
      }
      this.db.prepare('INSERT INTO ledger_budgets VALUES (?,?,?)').run(budget.id,budget.currency,budget.capMicros);
      return {duplicate:false};
    });
  }
  getBudget(id) {
    identifier(id,'budget id');
    const budget=this.db.prepare('SELECT id,currency,cap FROM ledger_budgets WHERE id=?').get(id);
    if(!budget)throw Error('Budget not found.');
    const totals=this.db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN r.state IN ('reserved','dispatching','cancellation-unsettled') THEN r.amount ELSE 0 END),0) AS reserved,
      COALESCE(SUM(CASE WHEN r.state='settled' THEN r.charge ELSE 0 END),0) AS spent
      FROM ledger_allocations a JOIN ledger_reservations r ON r.id=a.reservation_id WHERE a.budget_id=?`).get(id);
    if(!Number.isSafeInteger(totals.reserved)||!Number.isSafeInteger(totals.spent)||
       !Number.isSafeInteger(totals.reserved+totals.spent))throw Error('Budget total exceeds the safe accounting range.');
    const total=totals.reserved+totals.spent;
    return {id:budget.id,currency:budget.currency,capMicros:budget.cap,reservedMicros:totals.reserved,
      spentMicros:totals.spent,availableMicros:Math.max(0,budget.cap-total),exceeded:total>budget.cap};
  }
  reserve(input) {
    if(!Array.isArray(input?.budgets)||input.budgets.length<1||input.budgets.length>8)throw Error('Invalid budgets.');
    const budgets=input.budgets.map(id=>identifier(id,'budget id')).sort();
    if(new Set(budgets).size!==budgets.length)throw Error('Duplicate budget.');
    const reservation={id:identifier(input.id,'reservation id'),attemptId:identifier(input.attemptId,'attempt id'),
      currency:currency(input.currency),maxMicros:amount(input.maxMicros,'reservation'),budgets};
    if(reservation.maxMicros===0)throw Error('A paid reservation must have a positive upper bound.');
    const body=payload(reservation);
    return this.transaction(()=>{
      const prior=this.db.prepare('SELECT body,state FROM ledger_reservations WHERE id=?').get(reservation.id);
      if(prior) {
        if(prior.body!==body)throw Error('Reservation id conflict.');
        return {duplicate:true,state:prior.state};
      }
      if(this.db.prepare('SELECT id FROM ledger_reservations WHERE attempt_id=?').get(reservation.attemptId))
        throw Error('Attempt reservation conflict.');
      for(const id of budgets) {
        const budget=this.getBudget(id);
        if(budget.currency!==reservation.currency)throw Error('Budget currency conflict.');
        if(budget.exceeded||budget.availableMicros<reservation.maxMicros)throw Error('Budget cap would be exceeded.');
      }
      this.db.prepare('INSERT INTO ledger_reservations (id,attempt_id,currency,amount,state,charge,body) VALUES (?,?,?,?,?,?,?)')
        .run(reservation.id,reservation.attemptId,reservation.currency,reservation.maxMicros,'reserved',null,body);
      const insert=this.db.prepare('INSERT INTO ledger_allocations VALUES (?,?)');
      for(const id of budgets)insert.run(reservation.id,id);
      return {duplicate:false,state:'reserved'};
    });
  }
  claimDispatch(id) {
    identifier(id,'reservation id');
    return this.transaction(()=>{
      const row=this.db.prepare('SELECT state FROM ledger_reservations WHERE id=?').get(id);
      if(!row)throw Error('Reservation not found.');
      if(row.state!=='reserved')return {claimed:false,state:row.state};
      const budgets=this.db.prepare('SELECT budget_id FROM ledger_allocations WHERE reservation_id=?').all(id);
      if(!budgets.length)throw Error('Reservation has no budgets.');
      for(const budget of budgets)if(this.getBudget(budget.budget_id).exceeded)
        return {claimed:false,state:'budget-hold'};
      this.db.prepare("UPDATE ledger_reservations SET state='dispatching',dispatch_claimed=1 WHERE id=?").run(id);
      // A claim prevents duplicate dispatch; it is not an authorization decision.
      return {claimed:true,state:'dispatching'};
    });
  }
  markCancellation(id) {
    identifier(id,'reservation id');
    return this.transaction(()=>{
      const row=this.db.prepare('SELECT state FROM ledger_reservations WHERE id=?').get(id);
      if(!row)throw Error('Reservation not found.');
      if(['reserved','dispatching'].includes(row.state))
        this.db.prepare("UPDATE ledger_reservations SET state='cancellation-unsettled' WHERE id=?").run(id);
      return {state:['reserved','dispatching'].includes(row.state)?'cancellation-unsettled':row.state};
    });
  }
  releaseUndispatched(input) {
    const event={eventId:identifier(input?.eventId,'event id'),reservationId:identifier(input?.reservationId,'reservation id'),
      reason:input?.reason};
    if(event.reason!=='cancelled-before-dispatch')throw Error('Invalid release reason.');
    const body=payload(event);
    return this.transaction(()=>{
      const previous=this.db.prepare('SELECT body FROM ledger_release_events WHERE event_id=?').get(event.eventId);
      if(previous) {
        if(previous.body!==body)throw Error('Release event id conflict.');
        return {duplicate:true};
      }
      const row=this.db.prepare('SELECT state,dispatch_claimed FROM ledger_reservations WHERE id=?').get(event.reservationId);
      if(!row)throw Error('Reservation not found.');
      if(row.dispatch_claimed!==0||!['reserved','cancellation-unsettled'].includes(row.state))
        throw Error('Release is only allowed before dispatch.');
      this.db.prepare('INSERT INTO ledger_release_events VALUES (?,?,?)').run(event.eventId,event.reservationId,body);
      this.db.prepare("UPDATE ledger_reservations SET state='released' WHERE id=?").run(event.reservationId);
      return {duplicate:false};
    });
  }
  settle(input) {
    const event={eventId:identifier(input?.eventId,'event id'),reservationId:identifier(input?.reservationId,'reservation id'),
      currency:currency(input?.currency),chargeMicros:amount(input?.chargeMicros,'charge')};
    const body=payload(event);
    return this.transaction(()=>{
      const previous=this.db.prepare('SELECT body FROM ledger_charge_events WHERE event_id=?').get(event.eventId);
      if(previous) {
        if(previous.body!==body)throw Error('Charge event id conflict.');
        return {duplicate:true};
      }
      const row=this.db.prepare('SELECT currency,state,dispatch_claimed FROM ledger_reservations WHERE id=?').get(event.reservationId);
      if(!row)throw Error('Reservation not found.');
      if(row.currency!==event.currency)throw Error('Charge currency conflict.');
      if(row.state==='settled')throw Error('Reservation already settled; reconciliation is required.');
      if(row.dispatch_claimed!==1||!['dispatching','cancellation-unsettled'].includes(row.state))
        throw Error('A charge requires a prior dispatch claim.');
      this.db.prepare('INSERT INTO ledger_charge_events VALUES (?,?,?)').run(event.eventId,event.reservationId,body);
      this.db.prepare("UPDATE ledger_reservations SET state='settled',charge=? WHERE id=?")
        .run(event.chargeMicros,event.reservationId);
      return {duplicate:false};
    });
  }
}
