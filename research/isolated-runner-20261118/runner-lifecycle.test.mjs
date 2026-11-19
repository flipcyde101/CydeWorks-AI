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
    await assert.rejects(attempt,/Synthetic Stop/);
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
      ['unknown',async()=>({cleanup:'verified',inference:'unknown'})],
      ['timeout',async()=>new Promise(()=>{})],
    ]) {
      const path=join(dir,name); const claim=claimRun(path,{synthetic:true});
      try {
        await assert.rejects(runOwned({claim,cleanupTimeoutMs:20,adapter:{
          start:async({record})=>{record({nonce:'inert',birthIdentity:'fixture'});return {};},
          stopAndVerify:stop,
        },execute:async()=>1}),/unresolved/);
        assert.equal(reconcileClaim(path).state,'unresolved');
      } finally {claim.close();}
    }
  } finally {rmSync(dir,{recursive:true});}
});
