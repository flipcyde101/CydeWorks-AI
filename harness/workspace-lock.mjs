import {DatabaseSync} from 'node:sqlite';

// A dedicated SQLite transaction keeps the workspace lock for this process's
// lifetime without holding open a transaction on the task database. The OS
// releases the lock when this connection or process exits.
export function acquireWorkspaceLock(database) {
  const filename=database===':memory:'?':memory:':database+'.owner.sqlite';
  const lock=new DatabaseSync(filename,{timeout:0});
  try {
    lock.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE');
    return lock;
  } catch(error) {
    lock.close();
    if (/database is (?:locked|busy)/i.test(error.message)) {
      throw new Error('This workspace is already open in another CydeWorks AI service.');
    }
    throw error;
  }
}
