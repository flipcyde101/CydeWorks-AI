import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {claimRun, reconcileClaim, runOwned} from './runner-lifecycle.mjs';
import {createSyntheticWslAdapter} from './lifecycle-wsl.mjs';

if (process.argv[2] === 'controller') {
  const claim = claimRun(process.argv[3], {synthetic: true});
  await createSyntheticWslAdapter().start({record: identity => claim.append({state:'owned',identity})});
  claim.close();
  process.exit(0);
}

test('durable claims reject replay and truncated journals', () => {
  const dir = mkdtempSync(new URL('./lifecycle-test-', import.meta.url));
  try {
    const path = join(dir, 'claim'); const claim = claimRun(path, {synthetic:true});
    assert.throws(() => claimRun(path, {}), {code:'EEXIST'});
    claim.close(); assert.equal(reconcileClaim(path).state,'unresolved');
    writeFileSync(path,'{'); assert.equal(reconcileClaim(path).replayAllowed,false);
  } finally { rmSync(dir,{recursive:true}); }
});

test('Windows Stop cancels owned WSL parent and child; repeated and stale Stop', {skip:process.platform !== 'win32'}, async () => {
  const dir = mkdtempSync(new URL('./lifecycle-test-', import.meta.url));
  const claim = claimRun(join(dir,'claim'),{synthetic:true});
  const adapter = createSyntheticWslAdapter();
  let worker;
  try {
    worker = await adapter.start({record: identity => claim.append({state:'owned',identity})});
    assert.equal((await adapter.stopAndVerify(worker,'stale')).cleanup,'unknown');
    const forged = structuredClone(worker); forged.child.birthIdentity += '0';
    assert.equal((await adapter.stopAndVerify(forged)).cleanup,'unknown');
    assert.equal((await adapter.stopAndVerify(worker)).cleanup,'verified');
    assert.equal((await adapter.stopAndVerify(worker)).cleanup,'verified');
    const controller = new AbortController();
    const attempt = runOwned({claim,adapter,signal:controller.signal,execute:async()=>{
      controller.abort(Error('Synthetic Stop')); return new Promise(()=>{});
    }});
    await assert.rejects(attempt,/unresolved/);
    assert.equal(reconcileClaim(join(dir,'claim')).state,'unresolved');
  } finally {
    await adapter.stopAndVerify(); claim.close(); rmSync(dir,{recursive:true});
  }
});

test('Windows controller restart reconciles persisted identity without replay', {skip:process.platform !== 'win32'}, async () => {
  const dir = mkdtempSync(new URL('./lifecycle-test-', import.meta.url));
  const path = join(dir,'claim');
  try {
    execFileSync(process.execPath,[new URL(import.meta.url).pathname.replace(/^\/(\w:)/,'$1'),'controller',path],
      {windowsHide:true,timeout:10000});
    const recovered = reconcileClaim(path);
    assert.equal(recovered.state,'unresolved'); assert.equal(recovered.replayAllowed,false);
    assert.throws(()=>claimRun(path,{synthetic:true}),{code:'EEXIST'});
    const identity = recovered.rows.find(row=>row.state==='owned').identity;
    const adapter = createSyntheticWslAdapter();
    assert.equal((await adapter.stopAndVerify(identity)).cleanup,'verified');
    assert.equal((await adapter.stopAndVerify(identity)).cleanup,'verified');
  } finally { rmSync(dir,{recursive:true}); }
});

test('unresolved cleanup and unknown inference cannot complete a claim', async () => {
  const dir = mkdtempSync(new URL('./lifecycle-test-', import.meta.url));
  try {
    for (const [name,stop] of [
      ['unknown',async()=>({cleanup:'unknown',inference:'settled'})],
      ['timeout',async()=>new Promise(()=>{})],
    ]) {
      const path=join(dir,name); const claim=claimRun(path,{synthetic:true});
      try {
        await assert.rejects(runOwned({claim,cleanupTimeoutMs:20,adapter:{
          start:async({nonce,record})=>{record({nonce,birthIdentity:'fixture'});return {};},
          stopAndVerify:stop,
        },execute:async()=>1}),/unresolved/);
        assert.equal(reconcileClaim(path).state,'unresolved');
      } finally {claim.close();}
    }
  } finally {rmSync(dir,{recursive:true});}
});

for (const hangs of [true, false]) test(`execute settlement independent of cleanup: hangs=${hangs}`, async () => {
  const dir = mkdtempSync(new URL('./lifecycle-test-', import.meta.url));
  const path = join(dir, 'claim'); const claim = claimRun(path, {});
  try {
    const adapter = {start: async ({nonce, record}) => {
      assert.equal(reconcileClaim(path).rows.at(-1).state, 'launching');
      record({nonce, birthIdentity:'fixture'}); return {};
    }, stopAndVerify: async () => ({cleanup: hangs ? 'verified' : 'unknown', inference:'settled'})};
    await assert.rejects(runOwned({claim, adapter, executeTimeoutMs:20, settlementTimeoutMs:20,
      confirmInferenceSettled: async () => true,
      execute: async () => hangs ? new Promise(() => {}) : 1}), /unresolved/);
    const last = reconcileClaim(path).rows.at(-1);
    assert.equal(last.cleanup, hangs ? 'verified' : 'unknown');
    assert.equal(last.inference, hangs ? 'unknown' : 'settled');
  } finally { claim.close(); rmSync(dir,{recursive:true}); }
});

test('verified process cleanup cannot stand in for broker evidence', async () => {
  const dir = mkdtempSync(new URL('./lifecycle-test-', import.meta.url));
  try {
    for (const confirmed of [false, true]) {
      const path = join(dir, String(confirmed));
      const claim = claimRun(path, {synthetic: true});
      try {
        const attempt = runOwned({
          claim,
          adapter: {
            start: async ({nonce, record}) => {
              record({nonce, birthIdentity: 'fixture'});
              return {};
            },
            stopAndVerify: async () => ({cleanup: 'verified', inference: 'settled'}),
          },
          execute: async () => 'fixture',
          confirmInferenceSettled: async () => confirmed,
        });
        if (confirmed) assert.equal(await attempt, 'fixture');
        else await assert.rejects(attempt, /unresolved/);
        assert.equal(reconcileClaim(path).state, confirmed ? 'complete' : 'unresolved');
      } finally { claim.close(); }
    }
  } finally { rmSync(dir, {recursive: true}); }
});

test('startup deadline aborts owned startup and retains uncertainty', async () => {
  const dir = mkdtempSync(new URL('./lifecycle-test-', import.meta.url));
  const path = join(dir,'claim'); const claim = claimRun(path,{});
  let signal;
  try {
    await assert.rejects(runOwned({claim, startupTimeoutMs:20, adapter:{
      start: async input => { signal=input.signal; return new Promise(()=>{}); },
      stopAndVerify: async () => { assert.equal(signal.aborted,true); return {cleanup:'unknown'}; }
    }, execute:()=>assert.fail('must not execute')}), /unresolved/);
    assert.equal(reconcileClaim(path).state,'unresolved');
  } finally {claim.close();rmSync(dir,{recursive:true});}
});
