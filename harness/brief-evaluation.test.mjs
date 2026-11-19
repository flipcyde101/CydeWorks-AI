import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BRIEF_EVALUATION_FORMAT,
  BRIEF_EVALUATION_LIMITS,
  BRIEF_EVALUATION_VERSION,
  CLAIM_VERIFICATION_KINDS,
  RUBRIC_DIMENSIONS,
  STRUCTURAL_CHECK_DISCLAIMER,
  SYNTHETIC_HOLDOUT_CASE_IDS,
  SYNTHETIC_HOLDOUT_SUITE_LABEL,
  TRACKED_SYNTHETIC_CASE_IDS,
  BriefEvaluationLibrary,
  createBriefEvaluationLibrary,
  evaluateBrief,
  getHoldoutSyntheticCaseDefinition,
  getTrackedSyntheticCaseDefinition,
  listSyntheticSuites,
  runHoldoutSyntheticSuite,
  runTrackedSyntheticSuite,
  runTwentyPlusFiveEvaluation,
  scoreHoldoutSyntheticCase,
  scoreTrackedSyntheticCase,
} from './brief-evaluation.mjs';
import {
  BRIEF_EVALUATION_BAD_B01_BOOKED,
  BRIEF_EVALUATION_BAD_B13_INFERENCE,
  BRIEF_EVALUATION_BAD_B18_EXACTLY_500,
  BRIEF_EVALUATION_BAD_B20_FABRICATED,
  BRIEF_EVALUATION_GOOD_B01,
  BRIEF_EVALUATION_GOOD_B18,
  BRIEF_EVALUATION_GOOD_B20,
  buildHoldoutSyntheticBriefMap,
  buildTrackedSyntheticBriefMap,
} from './test-support/brief-evaluation-sample-briefs.mjs';

test('exports frozen contract constants', () => {
  assert.equal(BRIEF_EVALUATION_FORMAT, 'cydeworks.brief-evaluation');
  assert.equal(BRIEF_EVALUATION_VERSION, 1);
  assert.equal(TRACKED_SYNTHETIC_CASE_IDS.length, 20);
  assert.equal(SYNTHETIC_HOLDOUT_CASE_IDS.length, 5);
  assert.ok(Object.isFrozen(TRACKED_SYNTHETIC_CASE_IDS));
  assert.ok(Object.isFrozen(CLAIM_VERIFICATION_KINDS));
  assert.deepEqual(RUBRIC_DIMENSIONS.length, 5);
  assert.match(STRUCTURAL_CHECK_DISCLAIMER, /structural check only/i);
});

test('listSyntheticSuites separates tracked and holdout labels', () => {
  const suites = listSyntheticSuites();
  assert.equal(suites.tracked.count, 20);
  assert.equal(suites.holdout.label, SYNTHETIC_HOLDOUT_SUITE_LABEL);
  assert.equal(suites.holdout.count, 5);
  assert.notDeepEqual(suites.tracked.caseIds, suites.holdout.caseIds);
});

test('parseSourceLineAnchors preserves note and line anchors', () => {
  const lib = createBriefEvaluationLibrary();
  const source = '[1] Alpha line.\nMore alpha.\n\n[2] Beta line.';
  const parsed = lib.parseSourceLineAnchors(source);
  assert.equal(parsed.anchors.length, 2);
  assert.equal(parsed.anchors[0].lineNumber, 1);
  assert.equal(parsed.anchors[0].anchorId, 1);
  assert.match(parsed.anchors[0].excerpt, /Alpha/);
  assert.equal(parsed.anchors[1].anchorId, 2);
});

test('every claim exposes source line anchors it cites', () => {
  const result = scoreTrackedSyntheticCase('B01', { briefText: BRIEF_EVALUATION_GOOD_B01 });
  for (const claim of result.claims) {
    if (claim.citedNoteIds.length > 0) {
      assert.ok(claim.sourceLineAnchors.length > 0, claim.text);
      for (const anchor of claim.sourceLineAnchors) {
        assert.ok(typeof anchor.lineNumber === 'number');
        assert.ok(typeof anchor.excerpt === 'string');
      }
    }
  }
});

test('distinguishes verified-by-anchor, unsupported, and missing-evidence claims', () => {
  const good = scoreTrackedSyntheticCase('B01', { briefText: BRIEF_EVALUATION_GOOD_B01 });
  assert.ok(good.claims.some((claim) => claim.verificationKind === 'verified-by-anchor'));

  const bad = scoreTrackedSyntheticCase('B01', { briefText: BRIEF_EVALUATION_BAD_B01_BOOKED });
  assert.ok(bad.claims.some((claim) => claim.verificationKind === 'unsupported'));

  const missingEvidence = evaluateBrief({
    caseId: 'B01',
    suiteKind: 'tracked',
    taskText: getTrackedSyntheticCaseDefinition('B01').taskText,
    sourceText: getTrackedSyntheticCaseDefinition('B01').sourceText,
    briefText: 'Maple exceeds budget without citation.',
  });
  assert.ok(missingEvidence.claims.some((claim) => claim.verificationKind === 'missing-evidence'));
});

test('structural checks carry structural-only disclaimer', () => {
  const result = scoreTrackedSyntheticCase('B01', { briefText: BRIEF_EVALUATION_GOOD_B01 });
  for (const check of result.structuralChecks) {
    assert.equal(check.kind, 'structural-check-only');
    assert.equal(check.disclaimer, STRUCTURAL_CHECK_DISCLAIMER);
  }
  assert.equal(result.disclaimer, STRUCTURAL_CHECK_DISCLAIMER);
});

test('B18 scoring clarifies strictly under $500 boundary', () => {
  const good = scoreTrackedSyntheticCase('B18', { briefText: BRIEF_EVALUATION_GOOD_B18 });
  const bad = scoreTrackedSyntheticCase('B18', { briefText: BRIEF_EVALUATION_BAD_B18_EXACTLY_500 });
  assert.ok(
    good.structuralChecks.find((check) => check.name.includes('$500'))?.pass,
    'good brief should pass B18 boundary structural check',
  );
  assert.equal(
    bad.structuralChecks.find((check) => check.name.includes('$500'))?.pass,
    false,
  );
  assert.ok(bad.materialErrors.some((err) => err.code === 'b18-exactly-500-boundary'));
  assert.match(bad.rubric.scoringNotes ?? getTrackedSyntheticCaseDefinition('B18').notes, /under \$500/i);
});

test('B13 preserves inference limits on booking and video commitments', () => {
  const bad = scoreTrackedSyntheticCase('B13', { briefText: BRIEF_EVALUATION_BAD_B13_INFERENCE });
  const inferenceCheck = bad.structuralChecks.find((check) => check.name.includes('B13'));
  assert.equal(inferenceCheck?.pass, false);
  assert.ok(bad.unsupportedClaims.length > 0);
  assert.match(getTrackedSyntheticCaseDefinition('B13').notes, /inference limits/i);
});

test('B20 empty input expects note request and rejects fabrication', () => {
  const good = scoreTrackedSyntheticCase('B20', { briefText: BRIEF_EVALUATION_GOOD_B20 });
  assert.ok(
    good.structuralChecks.find((check) => check.name.includes('Empty source'))?.pass,
    'should request notes on empty source',
  );

  const bad = scoreTrackedSyntheticCase('B20', { briefText: BRIEF_EVALUATION_BAD_B20_FABRICATED });
  assert.ok(bad.materialErrors.length > 0);
  assert.ok(bad.unsupportedClaims.length > 0 || bad.rubric.usability.usableWithMinorEdits === false);
});

test('scores all 20 tracked synthetic cases explicitly', () => {
  const tracked = runTrackedSyntheticSuite(buildTrackedSyntheticBriefMap());
  assert.equal(tracked.summary.count, 20);
  assert.equal(tracked.summary.expectedCount, 20);
  assert.deepEqual(
  tracked.cases.map((item) => item.caseId),
    [...TRACKED_SYNTHETIC_CASE_IDS],
  );
  assert.equal(tracked.suiteLabel, 'tracked-synthetic');
});

test('scores five holdout cases separately with holdout label', () => {
  const holdout = runHoldoutSyntheticSuite(buildHoldoutSyntheticBriefMap());
  assert.equal(holdout.summary.count, 5);
  assert.equal(holdout.suiteLabel, SYNTHETIC_HOLDOUT_SUITE_LABEL);
  assert.equal(holdout.summary.notDrawnFromTrackedSuite, true);
  for (const item of holdout.cases) {
    assert.equal(item.suiteKind, 'holdout');
    assert.equal(item.suiteLabel, SYNTHETIC_HOLDOUT_SUITE_LABEL);
    assert.ok(!TRACKED_SYNTHETIC_CASE_IDS.includes(item.caseId));
  }
});

test('runTwentyPlusFiveEvaluation returns tracked plus holdout sections', () => {
  const report = runTwentyPlusFiveEvaluation({
    tracked: buildTrackedSyntheticBriefMap(),
    holdout: buildHoldoutSyntheticBriefMap(),
  });
  assert.equal(report.tracked.summary.count, 20);
  assert.equal(report.holdout.summary.count, 5);
  assert.equal(typeof report.tracked.gates.meetsProposedUsableGate, 'boolean');
  assert.equal(report.tracked.gates.proposedUsableThreshold, 16);
  assert.ok(report.tracked.gates.usableWithMinorEditsCount >= 0);
});

test('rejects missing tracked case in suite map', () => {
  const partial = buildTrackedSyntheticBriefMap();
  delete partial.B20;
  assert.throws(() => runTrackedSyntheticSuite(partial), /missing explicit case briefs/i);
});

test('rejects source or task mismatch for registered synthetic case', () => {
  const spec = getTrackedSyntheticCaseDefinition('B01');
  assert.throws(
    () =>
      evaluateBrief({
        caseId: 'B01',
        suiteKind: 'tracked',
        taskText: 'Different task',
        sourceText: spec.sourceText,
        briefText: BRIEF_EVALUATION_GOOD_B01,
      }),
    /taskText does not match/,
  );
  assert.throws(
    () =>
      evaluateBrief({
        caseId: 'B01',
        suiteKind: 'tracked',
        taskText: spec.taskText,
        sourceText: 'altered source',
        briefText: BRIEF_EVALUATION_GOOD_B01,
      }),
    /sourceText does not match/,
  );
});

test('boundary inputs reject malformed types and oversize text', () => {
  assert.throws(() => evaluateBrief(null), /must be a plain object/);
  assert.throws(() => evaluateBrief({ briefText: 'x' }), /taskText must be a string/);
  assert.throws(
    () =>
      evaluateBrief({
        taskText: 't',
        sourceText: 's',
        briefText: 42,
      }),
    /briefText must be a string/,
  );
  const huge = 'a'.repeat(BRIEF_EVALUATION_LIMITS.maxBriefTextBytes + 1);
  assert.throws(
    () =>
      evaluateBrief({
        taskText: 't',
        sourceText: 's',
        briefText: huge,
      }),
    /exceeds the maximum byte length/,
  );
});

test('invalid note anchors and duplicate claims are surfaced', () => {
  const spec = getTrackedSyntheticCaseDefinition('B01');
  const invalidAnchor = evaluateBrief({
    caseId: 'B01',
    suiteKind: 'tracked',
    taskText: spec.taskText,
    sourceText: spec.sourceText,
    briefText: 'Unknown fact from note [99].',
  });
  const structural = invalidAnchor.structuralChecks.find((check) => check.name.includes('citation references'));
  assert.equal(structural?.pass, false);

  const duplicate = evaluateBrief({
    caseId: 'B01',
    suiteKind: 'tracked',
    taskText: spec.taskText,
    sourceText: spec.sourceText,
    briefText: 'Cedar is too small [1]. Cedar is too small [1].',
  });
  assert.ok(duplicate.claims.some((claim) => claim.duplicate === true));
});

test('holdout definitions are available and distinct from tracked ids', () => {
  for (const caseId of SYNTHETIC_HOLDOUT_CASE_IDS) {
    const spec = getHoldoutSyntheticCaseDefinition(caseId);
    assert.equal(spec.suiteKind, 'holdout');
    assert.ok(!TRACKED_SYNTHETIC_CASE_IDS.includes(spec.caseId));
  }
});

test('BriefEvaluationLibrary mirrors exported functions', () => {
  const lib = createBriefEvaluationLibrary();
  assert.ok(lib instanceof BriefEvaluationLibrary);
  const scored = lib.scoreTrackedSyntheticCase('B02', {
    briefText: buildTrackedSyntheticBriefMap().B02.briefText,
  });
  assert.equal(scored.caseId, 'B02');
});