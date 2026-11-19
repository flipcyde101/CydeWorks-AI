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
  assert.deepEqual(CLAIM_VERIFICATION_KINDS, [
    'structurally-cited',
    'not-classified-as-factual',
    'unsupported',
    'missing-evidence',
  ]);
  assert.equal(CLAIM_VERIFICATION_KINDS.includes('verified-by-anchor'), false);
  assert.equal(Object.hasOwn(BRIEF_EVALUATION_LIMITS, 'factualAnchorOverlapMinimum'), false);
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
  assert.equal(parsed.anchors[0].lineEnd, 2);
  assert.equal(parsed.anchors[1].lineNumber, 4);
  assert.equal(parsed.anchors[1].lineEnd, 4);
  assert.match(parsed.anchors[0].excerpt, /Alpha/);
  assert.throws(() => lib.parseSourceLineAnchors('[1] one\n[1] duplicate'), /Duplicate note id 1/);
});

test('note anchors end on the last physical content line', () => {
  const lib = createBriefEvaluationLibrary();
  const inline = lib.parseSourceLineAnchors('[1] Alpha\n[2] Beta');
  assert.equal(inline.sourceLines.length, 2);
  assert.equal(inline.anchors[0].headerLineNumber, 1);
  assert.equal(inline.anchors[0].lineNumber, 1);
  assert.equal(inline.anchors[0].lineEnd, 1);
  assert.equal(inline.anchors[1].headerLineNumber, 2);
  assert.equal(inline.anchors[1].lineNumber, 2);
  assert.equal(inline.anchors[1].lineEnd, 2);

  const mixed = lib.parseSourceLineAnchors('[1] Alpha starts\nhere.\n\n[2]\nBeta only.');
  assert.equal(mixed.anchors[0].headerLineNumber, 1);
  assert.equal(mixed.anchors[0].lineNumber, 1);
  assert.equal(mixed.anchors[0].lineEnd, 2);
  assert.match(mixed.anchors[0].excerpt, /Alpha starts/);
  assert.match(mixed.anchors[0].excerpt, /here/);
  assert.equal(mixed.anchors[1].headerLineNumber, 4);
  assert.equal(mixed.anchors[1].lineNumber, 5);
  assert.equal(mixed.anchors[1].lineEnd, 5);
  assert.ok(mixed.anchors[1].lineEnd <= mixed.sourceLines.length);

  const headerOnly = lib.parseSourceLineAnchors('[1]\n\n[2] Tail');
  assert.equal(headerOnly.anchors[0].headerLineNumber, 1);
  assert.equal(headerOnly.anchors[0].lineNumber, 1);
  assert.equal(headerOnly.anchors[0].lineEnd, 1);
  assert.equal(headerOnly.anchors[1].headerLineNumber, 3);
  assert.equal(headerOnly.anchors[1].lineNumber, 3);
  assert.equal(headerOnly.anchors[1].lineEnd, 3);
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

function evaluateTrackedBrief(caseId, briefText) {
  const spec = getTrackedSyntheticCaseDefinition(caseId);
  return evaluateBrief({
    caseId,
    suiteKind: 'tracked',
    taskText: spec.taskText,
    sourceText: spec.sourceText,
    briefText,
  });
}

function assertStructurallyCitedAndUnproven(claim) {
  assert.equal(claim.verificationKind, 'structurally-cited');
  assert.notEqual(claim.verificationKind, 'verified-by-anchor');
  assert.notEqual(claim.verificationKind, 'unsupported');
  assert.notEqual(claim.verificationKind, 'missing-evidence');
  assert.equal(claim.requiresHumanSemanticReview, true);
  assert.equal(claim.factualVerificationPerformed, false);
  assert.equal(claim.structuralOnly, true);
}

test('same words with opposite meaning stay structurally cited and unproven', () => {
  const result = evaluateTrackedBrief('B01', '28 people have not confirmed [2].');
  const claim = result.claims[0];
  assertStructurallyCitedAndUnproven(claim);
  assert.match(claim.sourceLineAnchors[0].excerpt, /28 people have confirmed/i);
  assert.equal(result.factsProven, false);
  assert.equal(result.materialErrors.length, 0);
});

test('invented numbers and invented details stay structurally cited and unproven', () => {
  const inventedNumber = evaluateTrackedBrief('B01', 'Room Cedar holds 240 and costs $180 [1].');
  assertStructurallyCitedAndUnproven(inventedNumber.claims[0]);
  assert.match(inventedNumber.claims[0].sourceLineAnchors[0].excerpt, /holds 24/i);
  assert.doesNotMatch(inventedNumber.claims[0].sourceLineAnchors[0].excerpt, /holds 240/i);

  const inventedDay = evaluateTrackedBrief('B01', 'Nia will ask Maple for a discount by Wednesday [3].');
  assertStructurallyCitedAndUnproven(inventedDay.claims[0]);
  assert.match(inventedDay.claims[0].sourceLineAnchors[0].excerpt, /Tuesday/i);
  assert.equal(inventedDay.materialErrors.length, 0);
});

test('an unrelated resolved anchor is structurally cited, not missing and not fabricated', () => {
  const result = evaluateTrackedBrief(
    'B01',
    'The workshop is on Mars next week according to hidden plans [1].',
  );
  const claim = result.claims[0];
  assertStructurallyCitedAndUnproven(claim);
  assert.equal(claim.citedNoteIds[0], 1);
  assert.match(claim.sourceLineAnchors[0].excerpt, /Cedar/i);
  assert.equal(result.materialErrors.length, 0);
});

test('a truthful anchored claim still requires human semantic review', () => {
  const result = evaluateTrackedBrief('B01', 'Room Cedar holds 24 and costs $180 [1].');
  const claim = result.claims[0];
  assertStructurallyCitedAndUnproven(claim);
  assert.match(claim.sourceLineAnchors[0].excerpt, /Room Cedar holds 24 and costs \$180/i);
  assert.equal(result.factualVerificationPerformed, false);
  assert.equal(result.rubric.usability.factsProven, false);
  assert.equal(result.rubric.usability.passLabel, 'structural-rubric-only');
});

test('caller assertion cannot mark a factual claim verified', () => {
  const spec = getTrackedSyntheticCaseDefinition('B01');
  assert.throws(
    () =>
      evaluateBrief({
        caseId: 'B01',
        suiteKind: 'tracked',
        taskText: spec.taskText,
        sourceText: spec.sourceText,
        briefText: 'Room Cedar holds 24 and costs $180 [1].',
        verificationKind: 'verified-by-anchor',
        factualVerificationPerformed: true,
      }),
    /unknown field/i,
  );
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
  assert.equal(good.rubric.usability.usableWithMinorEdits, false);
  const scan = good.structuralChecks.find((check) => check.scanKind === 'detected-pattern');
  assert.ok(scan);
  assert.equal(good.structuralChecks.some((check) => /does not fabricate project facts/i.test(check.name)), false);
  assert.equal(scan.provesAbsenceOfFabrication, false);
  assert.equal(scan.fabricationJudgment, 'pending-human-review');
  assert.equal(good.rubric.usability.usableGateProvesFactualAcceptance, false);
  assert.equal(good.rubric.usability.passLabel, 'structural-rubric-only');
  assert.equal(good.factsProven, false);
});

test('empty-source invented prose stays unproven and outside the usable gate', () => {
  const acmeText =
    'No notes were supplied. Ask for notes or decision context because the input is empty. Acme acquired the project.';
  const acme = scoreTrackedSyntheticCase('B20', { briefText: acmeText });
  assert.equal(acme.structuralChecks.some((check) => /does not fabricate project facts/i.test(check.name)), false);
  const scan = acme.structuralChecks.find((check) => check.scanKind === 'detected-pattern');
  assert.ok(scan);
  assert.equal(scan.pass, false);
  assert.equal(scan.scanKind, 'detected-pattern');
  assert.equal(scan.provesAbsenceOfFabrication, false);
  assert.equal(scan.fabricationJudgment, 'pending-human-review');
  assert.equal(acme.rubric.usability.usableWithMinorEdits, false);
  assert.equal(acme.rubric.usability.usableGateProvesFactualAcceptance, false);
  assert.equal(acme.rubric.usability.passLabel, 'structural-rubric-only');
  assert.ok(acme.rubric.dimensions.traceability < 2);
  const invented = acme.claims.find((claim) => /acquired/i.test(claim.text));
  assert.ok(invented);
  assert.equal(invented.verificationKind, 'not-classified-as-factual');
  assert.equal(invented.emptySourceFabrication, false);
  assert.equal(invented.structuralOnly, true);
  assert.equal(invented.requiresHumanSemanticReview, true);
  assert.equal(invented.factualVerificationPerformed, false);
  assert.equal(acme.factsProven, false);
  assert.equal(acme.factualVerificationPerformed, false);
});

test('empty-source shipment date counts as pattern hits on one claim', () => {
  const result = scoreTrackedSyntheticCase('B20', { briefText: 'The shipment will leave on June 12.' });
  const claim = result.claims.find((item) => /june 12/i.test(item.text));
  assert.ok(claim);
  assert.equal(claim.verificationKind, 'unsupported');
  assert.equal(claim.emptySourceFabrication, true);
  assert.equal(claim.requiresHumanSemanticReview, true);
  assert.equal(result.detectedPatternScan.scanKind, 'detected-pattern');
  assert.equal(result.detectedPatternScan.detectedPatternClaimCount, 1);
  assert.ok(result.detectedPatternScan.detectedPatternHitCount >= 2);
  assert.deepEqual(result.detectedPatternScan.detectedPatternClaimIds, [claim.claimId]);
  assert.equal(result.detectedPatternScan.provesZeroUnsupportedFacts, false);
  assert.equal(result.detectedPatternScan.provesAbsenceOfFabrication, false);

  const briefs = buildTrackedSyntheticBriefMap();
  briefs.B20.briefText = 'The shipment will leave on June 12.';
  const tracked = runTrackedSyntheticSuite(briefs);
  assert.ok(tracked.summary.detectedPatternClaimCount >= 1);
  assert.ok(tracked.summary.detectedPatternHitCount >= 2);
  assert.equal(tracked.summary.provesZeroUnsupportedFacts, false);
});

test('distinguishes structurally cited, unsupported, and missing-evidence claims', () => {
  const good = scoreTrackedSyntheticCase('B01', { briefText: BRIEF_EVALUATION_GOOD_B01 });
  assert.ok(good.claims.some((claim) => claim.verificationKind === 'structurally-cited'));
  assert.ok(good.claims.some((claim) => claim.verificationKind === 'missing-evidence'));
  assert.ok(good.claims.every((claim) => claim.verificationKind !== 'verified-by-anchor'));
  assert.ok(good.claims.every((claim) => claim.requiresHumanSemanticReview === true));
  assert.equal(good.factsProven, false);
  assert.equal(good.rubric.usability.passLabel, 'structural-rubric-only');
  assert.match(good.rubric.scoringLimit, /do not prove factual claims/i);

  const bad = scoreTrackedSyntheticCase('B01', { briefText: BRIEF_EVALUATION_BAD_B01_BOOKED });
  assert.ok(bad.materialErrors.length > 0);
  assert.ok(bad.claims.some((claim) => claim.verificationKind === 'unsupported'));

  const missingEvidence = evaluateTrackedBrief('B01', 'Maple exceeds budget without citation.');
  assert.ok(missingEvidence.claims.every((claim) => claim.verificationKind === 'missing-evidence'));
  assert.ok(missingEvidence.claims.every((claim) => claim.verificationKind !== 'unsupported'));

  const invalidCitation = evaluateTrackedBrief('B01', 'Unknown fact from note [99].');
  assert.ok(invalidCitation.claims.every((claim) => claim.verificationKind === 'unsupported'));
  assert.equal(
    invalidCitation.structuralChecks.find((check) => check.name.includes('citation references'))?.pass,
    false,
  );
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

test('B13 keeps real booking violations and ignores a negated booking', () => {
  const negated = scoreTrackedSyntheticCase('B13', { briefText: 'Neither guest is booked [3].' });
  assert.equal(negated.materialErrors.length, 0);
  assert.equal(negated.claims[0].verificationKind, 'structurally-cited');
  assert.equal(negated.claims[0].structuralOnly, true);
  assert.equal(negated.claims[0].requiresHumanSemanticReview, true);

  const booked = scoreTrackedSyntheticCase('B13', { briefText: 'Guest B is booked [1].' });
  assert.ok(booked.materialErrors.length > 0);
  assert.ok(booked.claims.some((claim) => claim.verificationKind === 'unsupported'));

  const agreed = scoreTrackedSyntheticCase('B13', { briefText: 'Guest A agreed to video [1].' });
  assert.ok(agreed.materialErrors.length > 0);
  assert.ok(agreed.claims.some((claim) => claim.verificationKind === 'unsupported'));

  const confirmed = scoreTrackedSyntheticCase('B13', { briefText: 'Guest B is confirmed for June 14 [1].' });
  assert.ok(confirmed.materialErrors.some((err) => err.code === 'semantic-inference-limit'));
});

test('B18 keeps the pilot boundary and accepts an exact-amount exclusion', () => {
  const exclusion = scoreTrackedSyntheticCase('B18', {
    briefText: 'Invoices of exactly $500 stay in existing review [1].',
  });
  assert.equal(exclusion.materialErrors.length, 0);
  assert.equal(exclusion.claims[0].verificationKind, 'structurally-cited');
  assert.equal(exclusion.claims[0].requiresHumanSemanticReview, true);

  const included = scoreTrackedSyntheticCase('B18', {
    briefText: 'The pilot includes invoices of exactly $500 [1].',
  });
  assert.ok(included.materialErrors.length > 0);

  const qualify = scoreTrackedSyntheticCase('B18', {
    briefText: 'Invoices of exactly $500 qualify for the new pilot [1].',
  });
  assert.ok(qualify.materialErrors.length > 0);
  assert.equal(qualify.detectedPatternScan.detectedPatternClaimCount, 1);
  assert.ok(qualify.detectedPatternScan.detectedPatternHitCount > qualify.detectedPatternScan.detectedPatternClaimCount);
  assert.equal(qualify.detectedPatternScan.provesZeroUnsupportedFacts, false);

  const upTo = scoreTrackedSyntheticCase('B18', {
    briefText: 'New invoices up to $500 qualify for the one-week pilot [1].',
  });
  assert.ok(upTo.materialErrors.length > 0);

  const started = scoreTrackedSyntheticCase('B18', { briefText: 'The pilot already started Monday [2].' });
  assert.ok(started.materialErrors.length > 0);

  assert.equal(
    scoreTrackedSyntheticCase('B18', { briefText: BRIEF_EVALUATION_GOOD_B18 }).materialErrors.length,
    0,
  );
  assert.equal(
    scoreTrackedSyntheticCase('B18', { briefText: BRIEF_EVALUATION_GOOD_B18_PARAPHRASE_UNDER_500 }).materialErrors.length,
    0,
  );
});

test('a line break inside a flagged phrase still counts once per overlapping claim', () => {
  const partialGood = buildTrackedSyntheticBriefMap();
  partialGood.B01.briefText = 'Headline. A room has\nbeen booked for the workshop.';
  const tracked = runTrackedSyntheticSuite(partialGood);
  const scored = tracked.cases.find((item) => item.caseId === 'B01');
  const fragments = scored.claims.filter((claim) => /room has|been booked/i.test(claim.text));
  assert.equal(fragments.length, 2);
  for (const claim of fragments) {
    assert.equal(claim.text.toLowerCase().includes('room has been booked'), false);
    assert.ok(scored.detectedPatternScan.detectedPatternClaimIds.includes(claim.claimId));
  }
  assert.ok(scored.detectedPatternScan.detectedPatternHitCount >= 1);
  assert.equal(scored.detectedPatternScan.detectedPatternClaimCount, fragments.length);
  assert.equal(scored.detectedPatternScan.provesZeroUnsupportedFacts, false);
  assert.equal(tracked.summary.provesZeroUnsupportedFacts, false);
  assert.equal(tracked.gates.provesZeroUnsupportedFacts, false);
  assert.equal(tracked.gates.usableGateLabel, 'provisional-structural-threshold');
  assert.equal(typeof tracked.gates.meetsProvisionalStructuralThreshold, 'boolean');
  assert.equal(Object.hasOwn(tracked.summary, 'materialUnsupportedClaimCount'), false);
  assert.equal(Object.hasOwn(tracked.summary, 'zeroMaterialUnsupportedClaims'), false);
  assert.equal(Object.hasOwn(tracked.gates, 'zeroMaterialUnsupportedClaimsAcrossTracked'), false);
  assert.equal(Object.hasOwn(tracked.gates, 'meetsProposedUsableGate'), false);
});

test('clean suite pattern totals do not prove that unsupported facts are absent', () => {
  const tracked = runTrackedSyntheticSuite(buildTrackedSyntheticBriefMap());
  const holdout = runHoldoutSyntheticSuite(buildHoldoutSyntheticBriefMap());
  assert.equal(tracked.summary.detectedPatternHitCount, 0);
  assert.equal(tracked.summary.detectedPatternClaimCount, 0);
  assert.equal(tracked.summary.provesZeroUnsupportedFacts, false);
  assert.equal(tracked.gates.provesZeroUnsupportedFacts, false);
  assert.equal(tracked.gates.usableGateLabel, 'provisional-structural-threshold');
  assert.equal(holdout.summary.detectedPatternHitCount, 0);
  assert.equal(holdout.summary.detectedPatternClaimCount, 0);
  assert.equal(holdout.summary.provesZeroUnsupportedFacts, false);
});

test('scores all 20 tracked synthetic cases explicitly with expected fixture outcomes', () => {
  const tracked = runTrackedSyntheticSuite(buildTrackedSyntheticBriefMap());
  assert.equal(tracked.summary.count, 20);
  assert.equal(Object.keys(BRIEF_EVALUATION_EXPECTED_TRACKED).length, 20);
  for (const caseId of TRACKED_SYNTHETIC_CASE_IDS) {
    assert.equal(Object.hasOwn(BRIEF_EVALUATION_EXPECTED_TRACKED, caseId), true, caseId);
  }
  for (const [caseId, expected] of Object.entries(BRIEF_EVALUATION_EXPECTED_TRACKED)) {
    const scored = tracked.cases.find((item) => item.caseId === caseId);
    assert.ok(scored, caseId);
    assert.equal(scored.rubric.usability.usableWithMinorEdits, expected.usableWithMinorEdits, caseId);
    assert.equal(scored.rubric.usability.dimensionSum, expected.dimensionSum, caseId);
    assert.equal(scored.rubric.usability.usableGateProvesFactualAcceptance, false, caseId);
    assert.equal(scored.rubric.usability.passLabel, 'structural-rubric-only', caseId);
    assert.equal(
      scored.materialErrors.filter((err) => err.code === 'material-unsupported-claim').length,
      expected.materialUnsupportedCount,
      caseId,
    );
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
  assert.equal(Object.keys(BRIEF_EVALUATION_EXPECTED_HOLDOUT).length, 5);
  for (const caseId of SYNTHETIC_HOLDOUT_CASE_IDS) {
    assert.equal(Object.hasOwn(BRIEF_EVALUATION_EXPECTED_HOLDOUT, caseId), true, caseId);
  }
  for (const [caseId, expected] of Object.entries(BRIEF_EVALUATION_EXPECTED_HOLDOUT)) {
    const scored = holdout.cases.find((item) => item.caseId === caseId);
    assert.ok(scored, caseId);
    assert.equal(scored.rubric.usability.usableWithMinorEdits, expected.usableWithMinorEdits, caseId);
    assert.equal(scored.rubric.usability.dimensionSum, expected.dimensionSum, caseId);
    assert.equal(scored.rubric.usability.usableGateProvesFactualAcceptance, false, caseId);
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
  assert.equal(report.tracked.summary.factsProven, false);
  assert.equal(report.tracked.gates.factsProven, false);
  assert.equal(report.tracked.gates.factualVerificationPerformed, false);
  assert.equal(report.holdout.summary.factsProven, false);
  for (const item of [...report.tracked.cases, ...report.holdout.cases]) {
    assert.equal(item.factsProven, false, item.caseId);
    assert.equal(item.factualVerificationPerformed, false, item.caseId);
    assert.equal(item.rubric.usability.factsProven, false, item.caseId);
    assert.equal(item.rubric.usability.passLabel, 'structural-rubric-only', item.caseId);
    for (const claim of item.claims) {
      assert.notEqual(claim.verificationKind, 'verified-by-anchor', `${item.caseId}:${claim.claimId}`);
      assert.equal(claim.requiresHumanSemanticReview, true, item.caseId);
      assert.equal(claim.factualVerificationPerformed, false, item.caseId);
      assert.ok(CLAIM_VERIFICATION_KINDS.includes(claim.verificationKind), claim.verificationKind);
    }
  }
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