import {parentPort,workerData} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {UsageLedger} from './usage-ledger.mjs';

const db=new DatabaseSync(workerData.path);
const ledger=new UsageLedger(db);
parentPort.postMessage('ready');
Atomics.wait(new Int32Array(workerData.barrier),0,0,10000);
try {
  ledger.reserve({id:'r'+workerData.id,attemptId:'attempt'+workerData.id,currency:'USD',maxMicros:70,budgets:['period']});
  parentPort.postMessage('reserved');
} catch (error) {
  if (!/budget/i.test(error.message)) throw error;
  parentPort.postMessage('budget hold');
} finally {db.close();}
