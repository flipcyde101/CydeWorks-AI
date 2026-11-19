import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {
  DEFAULT_LIMITS, SEAL_MAGIC, decodeSealedBundle, maxFrameBytes, planSealedReader, readSealedFile, requireSealedBundle,
  sealedConsumerInput,
} from './sealed-handoff.mjs';

const {vectors} = JSON.parse(readFileSync(new URL('./sealed-handoff-vector.json', import.meta.url), 'utf8'));
const vector = vectors.find(v => v.name === 'ascii');
const raw = Buffer.from(vector.hex, 'hex');
const code = c => error => error.code === c;
const sha = b => createHash('sha256').update(b).digest();

function frame(entries) {
  const parts = [SEAL_MAGIC, Buffer.alloc(4)];
  parts[1].writeUInt32BE(entries.length);
  for (const e of entries) {
    const p = Buffer.from(e.path);
    const head = Buffer.alloc(5);
    head.writeUInt8(e.kind);
    head.writeUInt32BE(p.length, 1);
    parts.push(head, p);
    if (e.kind === 2) {
      const size = Buffer.alloc(8);
      size.writeBigUInt64BE(BigInt(e.data.length));
      parts.push(size, sha(e.data));
    }
  }
  const manifest = Buffer.concat(parts);
  const digest = sha(manifest);
  return {raw: Buffer.concat([manifest, ...entries.filter(e => e.kind === 2).map(e => e.data), digest]), digest: digest.toString('hex')};
}

test('decodes the cross-language golden vector produced by the Linux reader', () => {
  const bundle = decodeSealedBundle(raw, {expectedSealDigest: vector.sealDigest});
  assert.equal(bundle.sealDigest, vector.sealDigest);
  assert.deepEqual(bundle.entries.map(e => [e.kind, e.path]), [['file', 'limits.py'], ['dir', 'pkg'], ['file', 'pkg/m.py']]);
  for (const [path, text] of Object.entries(vector.files)) assert.equal(readSealedFile(bundle, path).toString(), text);
  assert.ok(Object.isFrozen(bundle) && Object.isFrozen(bundle.entries));
});

test('decodes the non-ASCII cross-language vector with exact path bytes', () => {
  const v = vectors.find(x => x.name === 'non-ascii');
  const bundle = decodeSealedBundle(Buffer.from(v.hex, 'hex'), {expectedSealDigest: v.sealDigest});
  assert.deepEqual(bundle.entries.map(e => e.path), ['café', 'café/naïve.py', '日本.txt']);
  for (const [path, text] of Object.entries(v.files)) assert.equal(readSealedFile(bundle, path).toString('utf8'), text);
  assert.equal(vectors.length, 2);
});

test('a leading UTF-8 BOM in a path is preserved by decoding and then rejected, as in Python', () => {
  const f = frame([{kind: 2, path: '﻿a', data: Buffer.from('x')}]);
  assert.ok(f.raw.includes(Buffer.from([0xef, 0xbb, 0xbf, 0x61])));
  assert.throws(() => decodeSealedBundle(f.raw, {expectedSealDigest: f.digest}), code('SEALED_PATH_INVALID'));
  const inner = frame([{kind: 1, path: 'd'}, {kind: 2, path: 'd/﻿b', data: Buffer.from('x')}]);
  assert.throws(() => decodeSealedBundle(inner.raw, {expectedSealDigest: inner.digest}), code('SEALED_PATH_INVALID'));
});

test('oversized input is refused before it is copied or parsed', () => {
  const limits = {maxEntries: 1, maxTotalBytes: 8, maxFileBytes: 8, maxPathBytes: 8};
  const cap = maxFrameBytes({...DEFAULT_LIMITS, ...limits});
  const big = new Uint8Array(cap + 1);
  Object.defineProperty(big, 'buffer', {get() { throw new Error('input was copied before the size cap'); }});
  assert.throws(() => decodeSealedBundle(big, {expectedSealDigest: '0'.repeat(64), limits}), code('SEALED_LIMIT_EXCEEDED'));
  const small = new Uint8Array(64);
  Object.defineProperty(small, 'buffer', {get() { throw new Error('copied'); }});
  assert.throws(() => decodeSealedBundle(small, {expectedSealDigest: '0'.repeat(64), limits}), /copied/); // positive control
});

test('requires a caller-supplied expected digest and rejects a different one', () => {
  assert.throws(() => decodeSealedBundle(raw), code('SEALED_EXPECTED_DIGEST_REQUIRED'));
  assert.throws(() => decodeSealedBundle(raw, {expectedSealDigest: '0'.repeat(64)}), code('SEALED_DIGEST_MISMATCH'));
});

test('detects content, manifest, trailer and length tampering', () => {
  const content = Buffer.from(raw); content[content.length - 33] ^= 1;
  assert.throws(() => decodeSealedBundle(content, {expectedSealDigest: vector.sealDigest}), code('SEALED_BUNDLE_INVALID'));
  const manifest = Buffer.from(raw); manifest[SEAL_MAGIC.length + 4 + 5] ^= 1;
  assert.throws(() => decodeSealedBundle(manifest, {expectedSealDigest: vector.sealDigest}), code('SEALED_DIGEST_MISMATCH'));
  assert.throws(() => decodeSealedBundle(Buffer.concat([raw, Buffer.of(0)]), {expectedSealDigest: vector.sealDigest}), code('SEALED_DIGEST_MISMATCH'));
  assert.throws(() => decodeSealedBundle(raw.subarray(0, 20), {expectedSealDigest: vector.sealDigest}), code('SEALED_BUNDLE_INVALID'));
});

test('caller mutation after decode cannot change sealed bytes', () => {
  const mine = Buffer.from(raw);
  const bundle = decodeSealedBundle(mine, {expectedSealDigest: vector.sealDigest});
  mine.fill(0);
  assert.equal(sha(sealedConsumerInput(bundle)).toString('hex'), sha(raw).toString('hex'));
  const out = readSealedFile(bundle, 'limits.py'); out.fill(0);
  assert.equal(readSealedFile(bundle, 'limits.py').toString(), 'limit\n');
});

test('rejects unsafe paths, bad order, orphan entries and case collisions', () => {
  for (const path of ['..', 'a/../b', '/abs', 'a\\b', 'c:x', 'a//b', 'x\u0001']) {
    const f = frame([{kind: 2, path, data: Buffer.from('x')}]);
    assert.throws(() => decodeSealedBundle(f.raw, {expectedSealDigest: f.digest}), code('SEALED_PATH_INVALID'), path);
  }
  const unordered = frame([{kind: 2, path: 'b', data: Buffer.from('1')}, {kind: 2, path: 'a', data: Buffer.from('2')}]);
  assert.throws(() => decodeSealedBundle(unordered.raw, {expectedSealDigest: unordered.digest}), code('SEALED_BUNDLE_INVALID'));
  const orphan = frame([{kind: 2, path: 'nodir/x', data: Buffer.from('1')}]);
  assert.throws(() => decodeSealedBundle(orphan.raw, {expectedSealDigest: orphan.digest}), code('SEALED_BUNDLE_INVALID'));
  const fileAsParent = frame([{kind: 2, path: 'a', data: Buffer.from('1')}, {kind: 2, path: 'a/b', data: Buffer.from('2')}]);
  assert.throws(() => decodeSealedBundle(fileAsParent.raw, {expectedSealDigest: fileAsParent.digest}), code('SEALED_BUNDLE_INVALID'));
  const collision = frame([{kind: 2, path: 'A', data: Buffer.from('1')}, {kind: 2, path: 'a', data: Buffer.from('2')}]);
  assert.throws(() => decodeSealedBundle(collision.raw, {expectedSealDigest: collision.digest}), code('SEALED_CASE_COLLISION'));
  const ok = frame([{kind: 1, path: 'd'}, {kind: 2, path: 'd/f', data: Buffer.from('ok')}]);
  assert.equal(readSealedFile(decodeSealedBundle(ok.raw, {expectedSealDigest: ok.digest}), 'd/f').toString(), 'ok');
});

test('enforces limits before trusting sizes', () => {
  assert.throws(() => decodeSealedBundle(raw, {expectedSealDigest: vector.sealDigest, limits: {maxEntries: 2}}), code('SEALED_LIMIT_EXCEEDED'));
  assert.throws(() => decodeSealedBundle(raw, {expectedSealDigest: vector.sealDigest, limits: {maxFileBytes: 5}}), code('SEALED_LIMIT_EXCEEDED'));
  const huge = Buffer.from(raw);
  huge.writeBigUInt64BE(2n ** 60n, SEAL_MAGIC.length + 4 + 5 + 'limits.py'.length);
  assert.throws(() => decodeSealedBundle(huge, {expectedSealDigest: vector.sealDigest}), code('SEALED_LIMIT_EXCEEDED'));
});

test('consumers refuse pathnames and look-alike objects', () => {
  for (const value of ['C:\\proj', '/mnt/c/proj', new URL('file:///proj'), {sealDigest: vector.sealDigest, entries: []}, null]) {
    assert.throws(() => requireSealedBundle(value), code('SEALED_HANDOFF_REQUIRED'));
    assert.throws(() => sealedConsumerInput(value), code('SEALED_HANDOFF_REQUIRED'));
  }
  const bundle = decodeSealedBundle(raw, {expectedSealDigest: vector.sealDigest});
  assert.throws(() => readSealedFile(bundle, '../limits.py'), code('SEALED_ENTRY_MISSING'));
});

test('reader plan fails closed outside qualified Linux', () => {
  assert.equal(planSealedReader({platform: 'linux'}).reader, 'posix-openat');
  assert.throws(() => planSealedReader({platform: 'win32'}), code('SEALED_HANDOFF_UNQUALIFIED'));
  assert.throws(() => planSealedReader({platform: 'win32', windowsQualification: {passed: true}}), code('SEALED_HANDOFF_UNQUALIFIED'));
  for (const platform of ['darwin', 'freebsd', 'aix', 'sunos'])
    assert.throws(() => planSealedReader({platform}), code('SEALED_HANDOFF_UNSUPPORTED'));
});
