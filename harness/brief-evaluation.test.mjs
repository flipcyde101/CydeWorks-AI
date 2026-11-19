import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BRIEF_EVALUATION_FORMAT,
  BRIEF_EVALUATION_LIMITS,
  BRIEF_EVALUATION_VERSION,
  CLAIM_VERIFICATION_KINDS,
  HUMAN_SEMANTIC_REVIEW_REQUIRED,
  RUBRIC_DIMENSIONS,
  STRUCTURAL_CHECK_DISCLAIMER,
  SYNTHETIC_HOLDOUT_CASE_IDS,
  SYNTHETIC_HOLDOUT_SUITE_LABEL,
  TRACKED_SYNTHETIC_CASE_IDS,
  VALID_SUITE_KINDS,
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
  BRIEF_EVALUATION_BAD_B13_PARAPHRASE_CONFIRMED,
  BRIEF_EVALUATION_BAD_B18_EXACTLY_500,
  BRIEF_EVALUATION_BAD_B18_PARAPHRASE_INCLUSIVE_500,
  BRIEF_EVALUATION_BAD_B20_FABRICATED,
  BRIEF_EVALUATION_BAD_B20_FABRICATED_SHIPMENT,
  BRIEF_EVALUATION_GOOD_B01,
  BRIEF_EVALUATION_GOOD_B13,
  BRIEF_EVALUATION_GOOD_B13_NOT_AGREED_VIDEO,
  BRIEF_EVALUATION_GOOD_B18,
  BRIEF_EVALUATION_GOOD_B18_PARAPHRASE_UNDER_500,
  BRIEF_EVALUATION_GOOD_B20,
  BRIEF_EVALUATION_EXPECTED_HOLDOUT,
  BRIEF_EVALUATION_EXPECTED_TRACKED,
  buildHoldoutSyntheticBriefMap,
  buildTrackedSyntheticBriefMap,
} from './test-support/brief-evaluation-sample-briefs.mjs';

test('exports frozen contract constants', () => {
  assert.equal(BRIEF_EVALUATION_FORMAT, 'cydeworks.brief-evaluation');
  assert.equal(BRIEF_EVALUATION_VERSION, 1);
  assert.equal(TRACKED_SYNTHETIC_CASE_IDS.length, 20);
  assert.equal(SYNTHETIC_HOLDOUT_CASE_IDS.length, 5);
  assert.deepEqual(VALID_SUITE_KINDS, ['tracked', 'holdout', 'ad-hoc']);
  assert.ok(Object.isFrozen(TRACKED_SYNTHETIC_CASE_IDS));
  assert.ok(Object.isFrozen(CLAIM_VERIFICATION_KINDS));
  assert.deepEqual(RUBRIC_DIMENSIONS.length, 5);
  assert.match(STRUCTURAL_CHECK_DISCLAIMER, /structural check only/i);
  assert.match(HUMAN_SEMANTIC_REVIEW_REQUIRED, /human semantic review/i);
});

test('listSyntheticSuites separates tracked and holdout labels', () => {
  const suites = listSyntheticSuites();
  assert.equal(suites.tracked.count, 20);
  assert.equal(suites.holdout.label, SYNTHETIC_HOLDOUT_SUITE_LABEL);
  assert.equal(suites.holdout.count, 5);
  assert.notDeepEqual(suites.tracked.caseIds, suites.holdout.caseIds);
});

test('parseSourceLineAnchors preserves boundaries for standalone note headers', () => {
  const lib = createBriefEvaluationLibrary();
  const source = '[1]\nAlpha line.\n\n[2] Beta line.';
  const parsed = lib.parseSourceLineAnchors(source);
  assert.equal(parsed.anchors.length, 2);
  assert.equal(parsed.anchors[0].headerLineNumber, 1);
  assert.equal(parsed.anchors[0].lineNumber, 2);
  assert.match(parsed.anchors[0].excerpt, /Alpha/);
  assert.throws(() => lib.parseSourceLineAnchors('[1] one\n[1] duplicate'), /Duplicate note id 1/);
});

test('explicit line references resolve to a single source line excerpt', () => {
  const spec = getTrackedSyntheticCaseDefinition('B01');
  const result = evaluateBrief({
    caseId: 'B01',
    suiteKind: 'tracked',
    taskText: spec.taskText,
    sourceText: spec.sourceText,
    briefText: 'Cedar capacity noted on line 1 [1].',
  });
  const lineClaim = result.claims.find((claim) => claim.citedLines.length > 0);
  assert.ok(lineClaim);
  const lineAnchor = lineClaim.sourceLineAnchors.find((anchor) => anchor.segmentKind === 'explicit-line-reference');
  assert.ok(lineAnchor);
  assert.equal(lineAnchor.lineEnd, lineAnchor.lineNumber);
  assert.ok(lineAnchor.excerpt.length <= 120);
});

test('factual claims with weak anchor overlap require human semantic review instead of verified status', () => {
  const spec = getTrackedSyntheticCaseDefinition('B01');
  const result = evaluateBrief({
    caseId: 'B01',
    suiteKind: 'tracked',
    taskText: spec.taskText,
    sourceText: spec.sourceText,
    briefText: 'The workshop is on Mars next week according to hidden plans [1][2][3].',
  });
  const claim = result.claims[0];
  assert.notEqual(claim.verificationKind, 'verified-by-anchor');
  assert.equal(claim.requiresHumanSemanticReview, true);
  assert.equal(claim.verificationKind, 'missing-evidence');
});

test('empty source marks invented facts unsupported', () => {
  const fabricated = scoreTrackedSyntheticCase('B20', { briefText: BRIEF_EVALUATION_BAD_B20_FABRICATED_SHIPMENT });
  assert.ok(fabricated.claims.every((claim) => claim.verificationKind === 'unsupported'));
  assert.ok(fabricated.materialErrors.length > 0);
});

test('B20 note request earns full traceability credit without citations', () => {
  const good = scoreTrackedSyntheticCase('B20', { briefText: BRIEF_EVALUATION_GOOD_B20 });
  assert.equal(good.rubric.dimensions.traceability, 2);
  assert.equal(good.materialErrors.length, 0);
});

test('distinguishes verified-by-anchor, unsupported, and missing-evidence claims', () => {
  const good = scoreTrackedSyntheticCase('B01', { briefText: BRIEF_EVALUATION_GOOD_B01 });
  assert.ok(
    good.claims.some(
      (claim) =>
        claim.verificationKind === 'missing-evidence' ||
        (claim.verificationKind === 'verified-by-anchor' && claim.requiresHumanSemanticReview === true),
    ),
  );

  const bad = scoreTrackedSyntheticCase('B01', { briefText: BRIEF_EVALUATION_BAD_B01_BOOKED });
  assert.ok(bad.materialErrors.length > 0);

  const missingEvidence = evaluateBrief({
    caseId: 'B01',
    suiteKind: 'tracked',
    taskText: getTrackedSyntheticCaseDefinition('B01').taskText,
    sourceText: getTrackedSyntheticCaseDefinition('B01').sourceText,
    briefText: 'Maple exceeds budget without citation.',
  });
  assert.ok(missingEvidence.claims.some((claim) => claim.verificationKind === 'missing-evidence'));
});

test('structural checks carry human semantic review guidance', () => {
  const result = scoreTrackedSyntheticCase('B01', { briefText: BRIEF_EVALUATION_GOOD_B01 });
  for (const check of result.structuralChecks) {
    assert.equal(check.kind, 'structural-check-only');
    assert.equal(check.requiresHumanSemanticReview, true);
    assert.equal(check.humanReviewNote, HUMAN_SEMANTIC_REVIEW_REQUIRED);
  }
});

test('B18 boundary uses semantic rules with paraphrased positive and negative briefs', () => {
  const good = scoreTrackedSyntheticCase('B18', {
    briefText: BRIEF_EVALUATION_GOOD_B18_PARAPHRASE_UNDER_500,
  });
  const badInclusive = scoreTrackedSyntheticCase('B18', {
    briefText: BRIEF_EVALUATION_BAD_B18_PARAPHRASE_INCLUSIVE_500,
  });
  const badExact = scoreTrackedSyntheticCase('B18', { briefText: BRIEF_EVALUATION_BAD_B18_EXACTLY_500 });

  assert.equal(
    good.structuralChecks.find((check) => check.name.includes('semantic rule'))?.pass,
    true,
  );
  assert.equal(badInclusive.materialErrors.some((err) => err.code === 'semantic-pilot-boundary'), true);
  assert.equal(badExact.materialErrors.length > 0, true);
  assert.equal(
    scoreTrackedSyntheticCase('B18', { briefText: BRIEF_EVALUATION_GOOD_B18 }).materialErrors.length,
    0,
  );
});

test('B13 inference limits use semantic rules with paraphrased positive and negative briefs', () => {
  const good = scoreTrackedSyntheticCase('B13', { briefText: BRIEF_EVALUATION_GOOD_B13 });
  const notAgreed = scoreTrackedSyntheticCase('B13', { briefText: BRIEF_EVALUATION_GOOD_B13_NOT_AGREED_VIDEO });
  const bad = scoreTrackedSyntheticCase('B13', { briefText: BRIEF_EVALUATION_BAD_B13_INFERENCE });
  const badParaphrase = scoreTrackedSyntheticCase('B13', { briefText: BRIEF_EVALUATION_BAD_B13_PARAPHRASE_CONFIRMED });

  assert.match(good.rubric.lookForHits.join(' '), /video/i);
  assert.equal(notAgreed.materialErrors.length, 0);
  assert.ok(bad.materialErrors.length > 0);
  assert.ok(badParaphrase.materialErrors.some((err) => err.code === 'semantic-inference-limit'));
});

test('suite gate counts material unsupported claims from whole-brief analysis across line breaks', () => {
  const partialGood = buildTrackedSyntheticBriefMap();
  partialGood.B01.briefText = 'Headline.\nA room has been booked for the workshop.';
  const tracked = runTrackedSyntheticSuite(partialGood);
  assert.ok(tracked.summary.materialUnsupportedClaimCount > 0);
  assert.equal(tracked.gates.zeroMaterialUnsupportedClaimsAcrossTracked, false);
});

test('scores all 20 tracked synthetic cases explicitly with expected fixture outcomes', () => {
  const tracked = runTrackedSyntheticSuite(buildTrackedSyntheticBriefMap());
  assert.equal(tracked.summary.count, 20);
  for (const [caseId, expected] of Object.entries(BRIEF_EVALUATION_EXPECTED_TRACKED)) {
    const scored = tracked.cases.find((item) => item.caseId === caseId);
    assert.ok(scored, caseId);
    if (expected.usableWithMinorEdits) {
      assert.equal(scored.rubric.usability.usableWithMinorEdits, true, caseId);
    }
    if (expected.traceabilityMin !== undefined) {
      assert.ok(scored.rubric.dimensions.traceability >= expected.traceabilityMin, caseId);
    }
    if (expected.dimensionSumMin !== undefined) {
      assert.ok(scored.rubric.usability.dimensionSum >= expected.dimensionSumMin, caseId);
    }
    if (caseId === 'B16' && expected.mustOmitOfficeMove) {
      assert.doesNotMatch(scored.rubric.lookForHits.join(' '), /office move/i);
      assert.doesNotMatch(buildTrackedSyntheticBriefMap().B16.briefText, /office move/i);
    }
  }
});

test('scores five holdout cases with expected fixture outcomes', () => {
  const holdout = runHoldoutSyntheticSuite(buildHoldoutSyntheticBriefMap());
  assert.equal(holdout.summary.count, 5);
  for (const [caseId, expected] of Object.entries(BRIEF_EVALUATION_EXPECTED_HOLDOUT)) {
    const scored = holdout.cases.find((item) => item.caseId === caseId);
    assert.ok(scored, caseId);
    assert.equal(scored.rubric.usability.usableWithMinorEdits, expected.usableWithMinorEdits, caseId);
    assert.equal(
      scored.materialErrors.filter((err) => err.code === 'material-unsupported-claim').length,
      expected.materialUnsupportedCount,
      caseId,
    );
    if (expected.dimensionSumMin !== undefined) {
      assert.ok(scored.rubric.usability.dimensionSum >= expected.dimensionSumMin, caseId);
    }
  }
});

test('runTwentyPlusFiveEvaluation returns tracked plus holdout sections', () => {
  const report = runTwentyPlusFiveEvaluation({
    tracked: buildTrackedSyntheticBriefMap(),
    holdout: buildHoldoutSyntheticBriefMap(),
  });
  assert.equal(report.tracked.summary.count, 20);
  assert.equal(report.holdout.summary.count, 5);
});

test('fail closed on unknown case ids and invalid suite kinds', () => {
  assert.throws(() => scoreTrackedSyntheticCase('B99', { briefText: 'x' }), /Unknown tracked/);
  assert.throws(() => scoreHoldoutSyntheticCase('H99', { briefText: 'x' }), /Unknown holdout/);
  const spec = getTrackedSyntheticCaseDefinition('B01');
  assert.throws(
    () =>
      evaluateBrief({
        caseId: 'B01',
        suiteKind: 'holdout',
        taskText: spec.taskText,
        sourceText: spec.sourceText,
        briefText: 'x',
      }),
    /Unknown holdout|Registered synthetic/,
  );
  assert.throws(
    () =>
      evaluateBrief({
        caseId: 'B01',
        suiteKind: 'nope',
        taskText: spec.taskText,
        sourceText: spec.sourceText,
        briefText: 'x',
      }),
    /Unsupported suite kind/,
  );
});

test('ad hoc evaluation is labeled honestly without registered answer keys', () => {
  const adHoc = evaluateBrief({
    taskText: 'Summarize.',
    sourceText: '[1] Alpha.',
    briefText: 'Alpha noted [1].',
    suiteKind: 'ad-hoc',
  });
  assert.equal(adHoc.suiteKind, 'ad-hoc');
  assert.equal(adHoc.suiteLabel, 'ad-hoc-unregistered');
  assert.ok(Array.isArray(adHoc.limitations));
});

test('rejects oversize suite maps, accessors, and unexpected case ids', () => {
  const partial = buildTrackedSyntheticBriefMap();
  partial.ZZ99 = { briefText: 'rogue' };
  assert.throws(() => runTrackedSyntheticSuite(partial), /unexpected case id/i);

  const tooMany = { ...buildTrackedSyntheticBriefMap() };
  for (let index = 0; index < 20; index += 1) {
    tooMany[`BX${index}`] = { briefText: 'x'.repeat(40) };
  }
  assert.throws(() => runTrackedSyntheticSuite(tooMany), /maximum suite map size/i);

  const accessorHost = {};
  Object.defineProperty(accessorHost, 'B01', {
    get() {
      return { briefText: 'accessor' };
    },
    enumerable: true,
  });
  assert.throws(() => runTrackedSyntheticSuite(accessorHost), /accessor properties/i);
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
});

test('boundary inputs reject malformed types and oversize text', () => {
  assert.throws(() => evaluateBrief(null), /must be a plain object/);
  assert.throws(() => evaluateBrief({ briefText: 'x' }), /taskText must be a string/);
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
});

test('B20 rejects fabricated brief while allowing note request', () => {
  const bad = scoreTrackedSyntheticCase('B20', { briefText: BRIEF_EVALUATION_BAD_B20_FABRICATED });
  assert.ok(bad.materialErrors.length > 0);
});

test('BriefEvaluationLibrary mirrors exported functions', () => {
  const lib = createBriefEvaluationLibrary();
  assert.ok(lib instanceof BriefEvaluationLibrary);
  const scored = lib.scoreTrackedSyntheticCase('B02', {
    briefText: buildTrackedSyntheticBriefMap().B02.briefText,
  });
  assert.equal(scored.caseId, 'B02');
});