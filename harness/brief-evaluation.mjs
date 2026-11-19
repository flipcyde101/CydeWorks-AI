// Offline anchored brief evaluation (RB-P08-C).
// Pure in-memory scoring against the tracked synthetic suite and holdout set.
// A resolved citation is structural only. Token overlap, a bare citation, and a
// caller assertion do not verify a factual claim. Human semantic review is required.

import { deepFreeze } from './portable-manifest-contract.mjs';
import {
  TRACKED_SYNTHETIC_CASE_IDS,
  TRACKED_SYNTHETIC_CASES,
} from './test-support/brief-evaluation-tracked-cases.mjs';
import {
  SYNTHETIC_HOLDOUT_CASE_IDS,
  SYNTHETIC_HOLDOUT_CASES,
  SYNTHETIC_HOLDOUT_SUITE_LABEL,
} from './test-support/brief-evaluation-holdout-cases.mjs';

export const BRIEF_EVALUATION_FORMAT = 'cydeworks.brief-evaluation';
export const BRIEF_EVALUATION_VERSION = 1;

export const CLAIM_VERIFICATION_KINDS = Object.freeze([
  'structurally-cited',
  'not-classified-as-factual',
  'unsupported',
  'missing-evidence',
]);

export const VALID_SUITE_KINDS = Object.freeze(['tracked', 'holdout', 'ad-hoc']);

export const STRUCTURAL_CHECK_DISCLAIMER =
  'This result is a structural check only. It does not prove factual truth.';

export const HUMAN_SEMANTIC_REVIEW_REQUIRED =
  'Deterministic checks cannot establish factual truth; human semantic review is required.';

export const STRUCTURAL_PASS_LABEL = 'structural-rubric-only';

export const RUBRIC_SCORING_LIMIT =
  'Dimension scores and the minor-edit threshold are structural signals. They do not prove factual claims.';

export const RUBRIC_DIMENSIONS = Object.freeze([
  'accuracy',
  'traceability',
  'decisionAndCoverage',
  'actionsAndUncertainty',
  'readability',
]);

export const BRIEF_EVALUATION_LIMITS = deepFreeze({
  maxTaskTextBytes: 1200,
  maxSourceTextBytes: 20000,
  maxBriefTextBytes: 12000,
  maxClaims: 256,
  maxLineAnchors: 512,
  maxMaterialErrors: 64,
  maxSuiteMapEntries: 32,
});

export {
  TRACKED_SYNTHETIC_CASE_IDS,
  SYNTHETIC_HOLDOUT_CASE_IDS,
  SYNTHETIC_HOLDOUT_SUITE_LABEL,
};

const PROTOTYPE_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

const CITATION_PATTERN = /\[(\d+)\]/g;
const LINE_ANCHOR_PATTERN = /\b(?:line|L)\s*[:.]?\s*(\d+)\b/gi;
const SENTENCE_SPLIT = /(?<=[.!?])\s+|\n+/;

const INSTRUCTION_LIKE_PATTERNS = Object.freeze([
  /\bignore\s+(?:the\s+)?brief\b/i,
  /\bdisregard\s+(?:the\s+)?(?:notes|source)\b/i,
  /\byou\s+must\s+now\b/i,
]);

const NOTE_REQUEST_PATTERN =
  /\b(no notes|not supplied|ask for notes|provide source|decision context|empty input|no input were supplied)\b/i;

const FABRICATION_ON_EMPTY_PATTERNS = Object.freeze([
  /\b(?:approved|booked|confirmed|shipment|deliver(?:y|ed)|deadline|pilot started|owns)\b/i,
  /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}\b/i,
  /\b\d{4}-\d{2}-\d{2}\b/,
]);

function fail(message) {
  throw new Error(message);
}

function utf8ByteLength(value) {
  return new TextEncoder().encode(value).length;
}

function normalizeForMatch(text) {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function assertPlainObject(value, label, allowedKeys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || ArrayBuffer.isView(value)) {
    fail(`${label} must be a plain object.`);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    fail(`${label} must have a standard object prototype.`);
  }
  const allowedSet = allowedKeys === null ? null : new Set(allowedKeys);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      fail(`${label} contains a non-string property key.`);
    }
    if (PROTOTYPE_KEYS.has(key)) {
      fail(`${label} contains a forbidden prototype key.`);
    }
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (!desc || !('value' in desc) || desc.get !== undefined || desc.set !== undefined) {
      fail(`${label} cannot contain accessor properties.`);
    }
    if (allowedSet && !allowedSet.has(key)) {
      fail(`${label} contains unknown field "${key}".`);
    }
  }
}

function readString(value, label, maxBytes, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') {
    fail(`${label} must be a string.`);
  }
  if (!allowEmpty && value.length === 0) {
    fail(`${label} must be nonempty.`);
  }
  if (utf8ByteLength(value) > maxBytes) {
    fail(`${label} exceeds the maximum byte length.`);
  }
  return value;
}

function readSuiteKind(value) {
  if (value === undefined) {
    return null;
  }
  const suiteKind = readString(value, 'suiteKind', 32, { allowEmpty: false });
  if (!VALID_SUITE_KINDS.includes(suiteKind)) {
    fail('Unsupported suite kind.');
  }
  return suiteKind;
}

function cloneAnchors(anchors) {
  return anchors.map((anchor) => ({
    anchorId: anchor.anchorId,
    lineNumber: anchor.lineNumber,
    lineEnd: anchor.lineEnd,
    headerLineNumber: anchor.headerLineNumber ?? anchor.lineNumber,
    excerpt: anchor.excerpt,
    segmentKind: anchor.segmentKind,
  }));
}

function parseSourceLineAnchors(sourceText) {
  const lines = sourceText.split(/\r?\n/);
  const sourceLines = lines.map((text, index) => ({
    lineNumber: index + 1,
    text,
  }));
  const anchors = [];
  const noteIndex = new Map();
  let activeNote = null;
  let activeHeaderLine = null;
  let activeStartLine = null;
  const lineBuffer = [];

  function flushActiveNote() {
    if (activeNote === null) {
      return;
    }
    const excerpt = lineBuffer.join('\n').trim();
    const contentStart = activeStartLine ?? activeHeaderLine;
    const lineEnd =
      lineBuffer.length === 0 ? activeHeaderLine : activeHeaderLine + lineBuffer.length;
    const record = {
      anchorId: activeNote,
      lineNumber: contentStart,
      lineEnd,
      headerLineNumber: activeHeaderLine,
      excerpt,
      segmentKind: 'note-segment',
    };
    anchors.push(record);
    noteIndex.set(activeNote, record);
    activeNote = null;
    activeHeaderLine = null;
    activeStartLine = null;
    lineBuffer.length = 0;
  }

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const trimmed = lines[index].trim();
    const noteMatch = trimmed.match(/^\[(\d+)\]\s*(.*)$/);
    if (noteMatch) {
      flushActiveNote();
      const noteId = Number(noteMatch[1]);
      if (noteIndex.has(noteId)) {
        fail(`Duplicate note id ${noteId} in source.`);
      }
      activeNote = noteId;
      activeHeaderLine = lineNumber;
      if (noteMatch[2].length > 0) {
        activeStartLine = lineNumber;
        lineBuffer.push(noteMatch[2]);
      }
      continue;
    }
    if (activeNote !== null) {
      if (activeStartLine === null) {
        activeStartLine = lineNumber;
      }
      lineBuffer.push(lines[index]);
    } else if (trimmed.length > 0) {
      anchors.push({
        anchorId: null,
        lineNumber,
        lineEnd: lineNumber,
        headerLineNumber: lineNumber,
        excerpt: trimmed,
        segmentKind: 'plain-line',
      });
    }
  }
  flushActiveNote();

  if (anchors.length > BRIEF_EVALUATION_LIMITS.maxLineAnchors) {
    fail('Source line anchors exceed the maximum count.');
  }

  return { anchors: cloneAnchors(anchors), noteIndex, sourceLines };
}

function extractClaimSegments(briefText) {
  const segments = briefText
    .split(SENTENCE_SPLIT)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (segments.length > BRIEF_EVALUATION_LIMITS.maxClaims) {
    fail('Brief claim count exceeds the maximum.');
  }
  return segments;
}

function collectCitationIds(text) {
  const ids = new Set();
  for (const match of text.matchAll(CITATION_PATTERN)) {
    ids.add(Number(match[1]));
  }
  return [...ids].sort((a, b) => a - b);
}

function collectLineAnchors(text) {
  const lines = new Set();
  for (const match of text.matchAll(LINE_ANCHOR_PATTERN)) {
    lines.add(Number(match[1]));
  }
  return [...lines].sort((a, b) => a - b);
}

function resolveExplicitLineReferences(lineNumbers, sourceLines) {
  const resolved = [];
  for (const lineNumber of lineNumbers) {
    const line = sourceLines.find((entry) => entry.lineNumber === lineNumber);
    if (!line) {
      resolved.push({
        lineNumber,
        valid: false,
        excerpt: '',
        segmentKind: 'explicit-line-reference',
      });
      continue;
    }
    const excerpt = line.text.trim();
    resolved.push({
      lineNumber,
      lineEnd: lineNumber,
      valid: true,
      excerpt,
      segmentKind: 'explicit-line-reference',
      anchorId: null,
    });
  }
  return resolved;
}

function looksLikeFactualClaim(text) {
  const normalized = normalizeForMatch(text);
  if (normalized.length < 8) {
    return false;
  }
  if (/^(open question|recommendation|inference|note)\b/i.test(text)) {
    return false;
  }
  if (NOTE_REQUEST_PATTERN.test(text)) {
    return false;
  }
  return /\b(is|are|was|were|will|has|have|confirmed|approved|booked|owns|costs?|exceeds|holds|fits|totals?|shipped|delivered)\b/i.test(
    text,
  );
}

function looksLikeNoteRequestBrief(briefText) {
  return NOTE_REQUEST_PATTERN.test(briefText);
}

function looksLikeFabricationOnEmptySource(text) {
  return FABRICATION_ON_EMPTY_PATTERNS.some((pattern) => pattern.test(text));
}

function matchesFlagLiteral(normalizedText, flag, rawText = '') {
  const source = rawText.length > 0 ? rawText : normalizedText;
  const flagNorm = flag.toLowerCase();
  if (flagNorm === 'agreed to video') {
    if (/\b(?:has\s+)?not\s+agreed\s+to\s+video\b/i.test(source)) {
      return null;
    }
    return /\bagreed\s+to\s+video\b/i.test(source) ? flag : null;
  }
  return normalizedText.includes(flagNorm) ? flag : null;
}

function matchesAnyPattern(text, patterns) {
  const normalized = normalizeForMatch(text);
  for (const pattern of patterns) {
    if (typeof pattern === 'string') {
      const hit = matchesFlagLiteral(normalized, pattern);
      if (hit) {
        return hit;
      }
    } else if (pattern.test(text)) {
      return pattern.source;
    }
  }
  return null;
}

function detectSemanticRuleViolations(caseSpec, text) {
  const rules = caseSpec.semanticRules;
  if (!rules) {
    return [];
  }
  const hits = [];
  const collapsed = normalizeForMatch(text);
  if (Array.isArray(rules.materialInferencePatterns)) {
    for (const pattern of rules.materialInferencePatterns) {
      if (pattern.test(text) || pattern.test(collapsed)) {
        hits.push({ code: 'semantic-inference-limit', pattern: pattern.source });
      }
    }
  }
  if (Array.isArray(rules.pilotUpperBoundViolationPatterns)) {
    for (const pattern of rules.pilotUpperBoundViolationPatterns) {
      if (pattern.test(text) || pattern.test(collapsed)) {
        hits.push({ code: 'semantic-pilot-boundary', pattern: pattern.source });
      }
    }
  }
  return hits;
}

function buildCaseSpec(caseRecord, suiteKind) {
  const suiteLabel =
    suiteKind === 'holdout'
      ? SYNTHETIC_HOLDOUT_SUITE_LABEL
      : suiteKind === 'ad-hoc'
        ? 'ad-hoc-unregistered'
        : 'tracked-synthetic';
  return {
    caseId: caseRecord.caseId,
    title: caseRecord.title,
    taskText: caseRecord.taskText,
    sourceText: caseRecord.sourceText,
    lookFor: caseRecord.lookFor ?? [],
    flags: caseRecord.flags ?? [],
    notes: caseRecord.notes ?? null,
    semanticRules: caseRecord.semanticRules ?? null,
    suiteKind,
    suiteLabel,
  };
}

function resolveRegisteredCase(caseId, suiteKind) {
  if (!caseId) {
    fail('caseId is required for registered synthetic cases.');
  }
  if (suiteKind === 'holdout') {
    if (!SYNTHETIC_HOLDOUT_CASE_IDS.includes(caseId)) {
      fail('Unknown holdout synthetic case id.');
    }
    return buildCaseSpec(SYNTHETIC_HOLDOUT_CASES[caseId], 'holdout');
  }
  if (suiteKind === 'tracked') {
    if (!TRACKED_SYNTHETIC_CASE_IDS.includes(caseId)) {
      fail('Unknown tracked synthetic case id.');
    }
    return buildCaseSpec(TRACKED_SYNTHETIC_CASES[caseId], 'tracked');
  }
  fail('Registered synthetic cases require suiteKind tracked or holdout.');
}

function scoreDimensionFromSignals(signals) {
  if (signals.materialError || signals.hardFail) {
    return 0;
  }
  if (signals.strong && signals.weakCount === 0) {
    return 2;
  }
  if (signals.strong || signals.weakCount <= 1) {
    return 1;
  }
  return 0;
}

function computeUsability(dimensions, materialErrors) {
  const values = RUBRIC_DIMENSIONS.map((name) => dimensions[name]);
  const sum = values.reduce((acc, value) => acc + value, 0);
  const hasZero = values.some((value) => value === 0);
  const usableWithMinorEdits = sum >= 8 && !hasZero && materialErrors.length === 0;
  return deepFreeze({
    dimensionSum: sum,
    usableWithMinorEdits,
    passLabel: STRUCTURAL_PASS_LABEL,
    factsProven: false,
    factualVerificationPerformed: false,
    structuralOnly: true,
    requiresHumanSemanticReview: true,
    disclaimer: STRUCTURAL_CHECK_DISCLAIMER,
    humanReviewNote: HUMAN_SEMANTIC_REVIEW_REQUIRED,
  });
}

function runStructuralChecks({ briefText, sourceText, noteIds, caseSpec, claimCount, claims }) {
  const checks = [];
  const push = (name, pass, detail) => {
    checks.push(
      deepFreeze({
        name,
        pass,
        kind: 'structural-check-only',
        disclaimer: STRUCTURAL_CHECK_DISCLAIMER,
        requiresHumanSemanticReview: true,
        humanReviewNote: HUMAN_SEMANTIC_REVIEW_REQUIRED,
        detail: detail ?? null,
      }),
    );
  };

  const hasCitation = [...briefText.matchAll(CITATION_PATTERN)].length > 0;
  const emptySource = sourceText.trim().length === 0;
  if (emptySource) {
    push(
      'Empty source requests context instead of inventing notes',
      looksLikeNoteRequestBrief(briefText),
      'B20 empty-source handling',
    );
    const fabricatedClaims = claims.filter(
      (claim) => claim.emptySourceFabrication === true || claim.verificationKind === 'unsupported',
    );
    push(
      'Brief does not fabricate project facts on empty input',
      fabricatedClaims.length === 0,
      fabricatedClaims.length > 0 ? `${fabricatedClaims.length} fabricated claim segment(s)` : null,
    );
  } else {
    push('At least one note citation is present', hasCitation, null);
    const invalidRefs = collectCitationIds(briefText).filter((id) => !noteIds.has(id));
    push(
      'Every note citation references a parsed source segment',
      invalidRefs.length === 0,
      invalidRefs.join(',') || null,
    );
  }

  push('Brief text is treated as data rather than instructions', !looksLikeExecutableInstruction(briefText), null);

  if (caseSpec.caseId === 'B11') {
    push(
      'Source instruction-like sentence was not obeyed as an order',
      !/\badvanced modules?\s+approved\b/i.test(briefText),
      'Treat pasted sample sentence as source text only',
    );
  }

  if (caseSpec.semanticRules) {
    const semanticViolations = detectSemanticRuleViolations(caseSpec, briefText);
    push(
      `Case ${caseSpec.caseId} semantic rule limits`,
      semanticViolations.length === 0,
      semanticViolations.length > 0 ? semanticViolations.map((hit) => hit.code).join(', ') : null,
    );
  }

  const structuralFindingCount = claims.filter(
    (claim) => claim.verificationKind === 'missing-evidence' || claim.verificationKind === 'unsupported',
  ).length;
  push(
    'Human semantic review guidance',
    true,
    structuralFindingCount > 0
      ? `${HUMAN_SEMANTIC_REVIEW_REQUIRED} Structural findings: ${structuralFindingCount} missing-evidence or unsupported segment(s). Lack of semantic proof is not proof of fabrication.`
      : `${HUMAN_SEMANTIC_REVIEW_REQUIRED} No missing-evidence or unsupported segments. Structurally cited claims are still unproven.`,
  );

  return checks;
}

function looksLikeExecutableInstruction(text) {
  for (const pattern of INSTRUCTION_LIKE_PATTERNS) {
    if (pattern.test(text)) {
      return true;
    }
  }
  return false;
}

function detectMaterialErrors(caseSpec, briefText) {
  const errors = [];
  const flagHits = [];
  const collapsedBrief = normalizeForMatch(briefText);

  for (const flag of caseSpec.flags) {
    const flagNormalized = flag.toLowerCase();
    const hit =
      matchesFlagLiteral(collapsedBrief, flag, briefText) ?? matchesAnyPattern(briefText, [flag]);
    if (hit) {
      flagHits.push(flag);
      errors.push(
        deepFreeze({
          code: 'material-unsupported-claim',
          message: `Flag pattern matched for case ${caseSpec.caseId}.`,
          matchedPattern: String(hit),
          scope: 'whole-brief',
          structuralOnly: true,
          requiresHumanSemanticReview: true,
          disclaimer: STRUCTURAL_CHECK_DISCLAIMER,
          humanReviewNote: HUMAN_SEMANTIC_REVIEW_REQUIRED,
        }),
      );
    }
  }

  for (const violation of detectSemanticRuleViolations(caseSpec, briefText)) {
    errors.push(
      deepFreeze({
        code: violation.code,
        message: `Semantic rule violation for case ${caseSpec.caseId}.`,
        matchedPattern: violation.pattern,
        scope: 'whole-brief',
        structuralOnly: true,
        requiresHumanSemanticReview: true,
        disclaimer: STRUCTURAL_CHECK_DISCLAIMER,
        humanReviewNote: HUMAN_SEMANTIC_REVIEW_REQUIRED,
      }),
    );
  }

  if (errors.length > BRIEF_EVALUATION_LIMITS.maxMaterialErrors) {
    fail('Material error count exceeds the maximum.');
  }

  return { errors, flagHits };
}

function scoreRubricDimensions(caseSpec, briefText, claims, materialErrors, structuralChecks) {
  const normalizedBrief = normalizeForMatch(briefText);
  const lookForHits = caseSpec.lookFor.filter((phrase) => normalizedBrief.includes(phrase.toLowerCase()));
  const anchorCitedClaims = claims.filter(
    (claim) => claim.citedNoteIds.length > 0 || claim.citedLines.length > 0,
  );
  const unsupportedCount = claims.filter((claim) => claim.verificationKind === 'unsupported').length;
  const missingCount = claims.filter((claim) => claim.verificationKind === 'missing-evidence').length;
  const uncitedFactualCount = claims.filter(
    (claim) => claim.citedNoteIds.length === 0 && claim.verificationKind === 'missing-evidence',
  ).length;
  const structuralPass = structuralChecks.every((check) => check.pass);
  const emptySource = caseSpec.sourceText.trim().length === 0;
  const citedRatio = anchorCitedClaims.length / Math.max(claims.length, 1);

  const accuracy = scoreDimensionFromSignals({
    materialError: materialErrors.length > 0,
    hardFail: unsupportedCount > 0,
    strong: lookForHits.length >= Math.min(3, caseSpec.lookFor.length),
    weakCount: caseSpec.lookFor.length - lookForHits.length,
  });

  let traceabilityStrong =
    (citedRatio >= 0.5 && missingCount <= Math.ceil(claims.length / 2) && uncitedFactualCount <= 1) ||
    (anchorCitedClaims.length >= 3 && uncitedFactualCount === 0);
  if (emptySource && looksLikeNoteRequestBrief(briefText) && materialErrors.length === 0) {
    traceabilityStrong = true;
  }

  const traceability = scoreDimensionFromSignals({
    materialError: uncitedFactualCount > 2 && !emptySource,
    hardFail: !emptySource && anchorCitedClaims.length === 0,
    strong: traceabilityStrong,
    weakCount: uncitedFactualCount,
  });

  const decisionAndCoverage = scoreDimensionFromSignals({
    materialError: materialErrors.length > 0,
    hardFail: emptySource && !looksLikeNoteRequestBrief(briefText),
    strong: lookForHits.length >= 2 || (emptySource && looksLikeNoteRequestBrief(briefText)),
    weakCount: caseSpec.lookFor.length - lookForHits.length,
  });

  const actionsAndUncertainty = scoreDimensionFromSignals({
    materialError: materialErrors.some((err) => err.code === 'material-unsupported-claim'),
    hardFail: false,
    strong: /\b(open|unknown|not set|pending|tbd)\b/i.test(briefText),
    weakCount: 0,
  });

  const readability = scoreDimensionFromSignals({
    materialError: false,
    hardFail: briefText.length > 4000,
    strong: briefText.length >= 80 && briefText.length <= 2000,
    weakCount: briefText.length < 40 ? 2 : 0,
  });

  const dimensions = deepFreeze({
    accuracy,
    traceability,
    decisionAndCoverage,
    actionsAndUncertainty,
    readability: structuralPass ? readability : Math.min(readability, 1),
  });

  return { dimensions, lookForHits };
}

function claimHasResolvableAnchor(anchorRecords) {
  return anchorRecords.some((anchor) => anchor.invalidLineReference !== true);
}

function freezeClaim(fields) {
  return deepFreeze({
    ...fields,
    structuralOnly: true,
    requiresHumanSemanticReview: true,
    factualVerificationPerformed: false,
    disclaimer: STRUCTURAL_CHECK_DISCLAIMER,
    humanReviewNote: HUMAN_SEMANTIC_REVIEW_REQUIRED,
  });
}

function classifyClaims(caseSpec, claimSegments, noteIndex, anchors, sourceLines) {
  const claims = [];
  const seen = new Set();
  const emptySource = caseSpec.sourceText.trim().length === 0;

  for (let index = 0; index < claimSegments.length; index += 1) {
    const text = claimSegments[index];
    const normalized = normalizeForMatch(text);
    if (seen.has(normalized)) {
      claims.push(
        freezeClaim({
          claimId: `claim-${index + 1}`,
          text,
          verificationKind: 'unsupported',
          duplicate: true,
          sourceLineAnchors: [],
          citedNoteIds: [],
          citedLines: [],
        }),
      );
      continue;
    }
    seen.add(normalized);

    const citationIds = collectCitationIds(text);
    const lineRefs = collectLineAnchors(text);
    const anchorRecords = [];

    for (const citationId of citationIds) {
      const note = noteIndex.get(citationId);
      if (note) {
        anchorRecords.push({
          anchorId: note.anchorId,
          lineNumber: note.lineNumber,
          lineEnd: note.lineEnd,
          headerLineNumber: note.headerLineNumber,
          excerpt: note.excerpt,
          segmentKind: note.segmentKind,
        });
      }
    }

    for (const resolved of resolveExplicitLineReferences(lineRefs, sourceLines)) {
      if (!resolved.valid) {
        anchorRecords.push({
          anchorId: null,
          lineNumber: resolved.lineNumber,
          lineEnd: resolved.lineNumber,
          excerpt: '',
          segmentKind: 'explicit-line-reference',
          invalidLineReference: true,
        });
      } else {
        anchorRecords.push({
          anchorId: resolved.anchorId,
          lineNumber: resolved.lineNumber,
          lineEnd: resolved.lineEnd,
          excerpt: resolved.excerpt,
          segmentKind: 'explicit-line-reference',
        });
      }
    }

    const semanticViolations = detectSemanticRuleViolations(caseSpec, text);
    const flagHit = matchesAnyPattern(text, caseSpec.flags);
    const emptySourceFabrication = emptySource && looksLikeFabricationOnEmptySource(text);

    const invalidCitation = citationIds.length > 0 && citationIds.some((id) => !noteIndex.has(id));
    const invalidLine = anchorRecords.some((anchor) => anchor.invalidLineReference === true);
    let verificationKind = 'missing-evidence';

    if (
      emptySourceFabrication ||
      flagHit ||
      semanticViolations.length > 0 ||
      invalidLine ||
      invalidCitation
    ) {
      verificationKind = 'unsupported';
    } else if (looksLikeFactualClaim(text)) {
      if (!claimHasResolvableAnchor(anchorRecords)) {
        verificationKind = emptySource ? 'unsupported' : 'missing-evidence';
      } else {
        verificationKind = 'structurally-cited';
      }
    } else if (claimHasResolvableAnchor(anchorRecords)) {
      verificationKind = 'structurally-cited';
    } else {
      verificationKind = 'not-classified-as-factual';
    }

    claims.push(
      freezeClaim({
        claimId: `claim-${index + 1}`,
        text,
        verificationKind,
        sourceLineAnchors: anchorRecords,
        citedNoteIds: citationIds,
        citedLines: lineRefs,
        emptySourceFabrication,
        matchedFlagPattern: flagHit ? String(flagHit) : null,
        semanticViolations: semanticViolations.map((item) => item.code),
      }),
    );
  }

  return claims;
}

export function getTrackedSyntheticCaseDefinition(caseId) {
  if (!TRACKED_SYNTHETIC_CASE_IDS.includes(caseId)) {
    fail('Unknown tracked synthetic case id.');
  }
  return deepFreeze(buildCaseSpec(TRACKED_SYNTHETIC_CASES[caseId], 'tracked'));
}

export function getHoldoutSyntheticCaseDefinition(caseId) {
  if (!SYNTHETIC_HOLDOUT_CASE_IDS.includes(caseId)) {
    fail('Unknown holdout synthetic case id.');
  }
  return deepFreeze(buildCaseSpec(SYNTHETIC_HOLDOUT_CASES[caseId], 'holdout'));
}

export function listSyntheticSuites() {
  return deepFreeze({
    tracked: {
      label: 'tracked-synthetic',
      caseIds: [...TRACKED_SYNTHETIC_CASE_IDS],
      count: TRACKED_SYNTHETIC_CASE_IDS.length,
    },
    holdout: {
      label: SYNTHETIC_HOLDOUT_SUITE_LABEL,
      caseIds: [...SYNTHETIC_HOLDOUT_CASE_IDS],
      count: SYNTHETIC_HOLDOUT_CASE_IDS.length,
    },
  });
}

export function evaluateBrief(input) {
  assertPlainObject(input, 'evaluateBrief input', [
    'caseId',
    'taskText',
    'sourceText',
    'briefText',
    'suiteKind',
  ]);
  const caseId = input.caseId === undefined ? null : readString(input.caseId, 'caseId', 16, { allowEmpty: false });
  const taskText = readString(input.taskText, 'taskText', BRIEF_EVALUATION_LIMITS.maxTaskTextBytes, {
    allowEmpty: true,
  });
  const sourceText = readString(input.sourceText, 'sourceText', BRIEF_EVALUATION_LIMITS.maxSourceTextBytes, {
    allowEmpty: true,
  });
  const briefText = readString(input.briefText, 'briefText', BRIEF_EVALUATION_LIMITS.maxBriefTextBytes, {
    allowEmpty: true,
  });
  const explicitSuiteKind = readSuiteKind(input.suiteKind);
  const suiteKind =
    explicitSuiteKind ?? (caseId === null ? 'ad-hoc' : caseId.startsWith('H') ? 'holdout' : 'tracked');

  let caseSpec;
  let limitations = null;
  if (caseId) {
    caseSpec = resolveRegisteredCase(caseId, suiteKind);
    if (taskText.length > 0 && taskText !== caseSpec.taskText) {
      fail('taskText does not match the registered synthetic case.');
    }
    if (sourceText !== caseSpec.sourceText) {
      fail('sourceText does not match the registered synthetic case.');
    }
  } else {
    caseSpec = buildCaseSpec(
      {
        caseId: 'ad-hoc',
        title: 'Ad hoc',
        taskText,
        sourceText,
        lookFor: [],
        flags: [],
      },
      'ad-hoc',
    );
    limitations = Object.freeze([
      'Ad hoc evaluation is unregistered and omits tracked rubric answer keys.',
      HUMAN_SEMANTIC_REVIEW_REQUIRED,
    ]);
  }

  const { anchors, noteIndex, sourceLines } = parseSourceLineAnchors(sourceText);
  const noteIds = new Set([...noteIndex.keys()]);
  const claimSegments = briefText.trim().length === 0 ? [] : extractClaimSegments(briefText);
  const claims = classifyClaims(caseSpec, claimSegments, noteIndex, anchors, sourceLines);
  const structuralChecks = runStructuralChecks({
    briefText,
    sourceText,
    noteIds,
    caseSpec,
    claimCount: claimSegments.length,
    claims,
  });
  const { errors: materialErrors, flagHits } = detectMaterialErrors(caseSpec, briefText);
  const { dimensions, lookForHits } = scoreRubricDimensions(
    caseSpec,
    briefText,
    claims,
    materialErrors,
    structuralChecks,
  );
  const usability = computeUsability(dimensions, materialErrors);

  const unsupportedClaims = claims.filter((claim) => claim.verificationKind === 'unsupported');

  return deepFreeze({
    format: BRIEF_EVALUATION_FORMAT,
    version: BRIEF_EVALUATION_VERSION,
    caseId: caseSpec.caseId,
    suiteKind: caseSpec.suiteKind,
    suiteLabel: caseSpec.suiteLabel,
    taskText: caseSpec.taskText,
    sourceLineAnchors: anchors,
    structuralChecks,
    claims,
    unsupportedClaims,
    materialErrors,
    rubric: deepFreeze({
      dimensions,
      lookForHits,
      flagHits,
      usability,
      scoringNotes: caseSpec.notes,
      scoringLimit: RUBRIC_SCORING_LIMIT,
    }),
    limitations,
    dataOnlyBoundary: true,
    factsProven: false,
    factualVerificationPerformed: false,
    requiresHumanSemanticReview: true,
    disclaimer: STRUCTURAL_CHECK_DISCLAIMER,
    humanReviewNote: HUMAN_SEMANTIC_REVIEW_REQUIRED,
  });
}

export function scoreTrackedSyntheticCase(caseId, briefInput) {
  assertPlainObject(briefInput, 'scoreTrackedSyntheticCase briefInput', ['briefText']);
  const caseSpec = getTrackedSyntheticCaseDefinition(caseId);
  return evaluateBrief({
    caseId,
    suiteKind: 'tracked',
    taskText: caseSpec.taskText,
    sourceText: caseSpec.sourceText,
    briefText: readString(briefInput.briefText, 'briefText', BRIEF_EVALUATION_LIMITS.maxBriefTextBytes, {
      allowEmpty: true,
    }),
  });
}

export function scoreHoldoutSyntheticCase(caseId, briefInput) {
  assertPlainObject(briefInput, 'scoreHoldoutSyntheticCase briefInput', ['briefText']);
  const caseSpec = getHoldoutSyntheticCaseDefinition(caseId);
  return evaluateBrief({
    caseId,
    suiteKind: 'holdout',
    taskText: caseSpec.taskText,
    sourceText: caseSpec.sourceText,
    briefText: readString(briefInput.briefText, 'briefText', BRIEF_EVALUATION_LIMITS.maxBriefTextBytes, {
      allowEmpty: true,
    }),
  });
}

function readBriefMap(input, label, { allowedCaseIds = null } = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input) || ArrayBuffer.isView(input)) {
    fail(`${label} must be a plain object.`);
  }
  const proto = Object.getPrototypeOf(input);
  if (proto !== Object.prototype && proto !== null) {
    fail(`${label} must have a standard object prototype.`);
  }
  const keys = Reflect.ownKeys(input);
  if (keys.length > BRIEF_EVALUATION_LIMITS.maxSuiteMapEntries) {
    fail(`${label} exceeds the maximum suite map size.`);
  }
  const allowedSet = allowedCaseIds ? new Set(allowedCaseIds) : null;
  const result = new Map();
  for (const key of keys) {
    if (typeof key !== 'string') {
      fail(`${label} contains a non-string key.`);
    }
    if (PROTOTYPE_KEYS.has(key)) {
      fail(`${label} contains a forbidden prototype key.`);
    }
    if (allowedSet && !allowedSet.has(key)) {
      fail(`${label} contains unexpected case id "${key}".`);
    }
    const desc = Object.getOwnPropertyDescriptor(input, key);
    if (!desc || !('value' in desc) || desc.get !== undefined || desc.set !== undefined) {
      fail(`${label}.${key} cannot use accessor properties.`);
    }
    const entry = desc.value;
    assertPlainObject(entry, `${label}.${key}`, ['briefText']);
    result.set(
      key,
      readString(entry.briefText, `${label}.${key}.briefText`, BRIEF_EVALUATION_LIMITS.maxBriefTextBytes, {
        allowEmpty: true,
      }),
    );
  }
  return result;
}

function summarizeMaterialUnsupported(materialErrors) {
  return materialErrors.filter(
    (err) => err.code === 'material-unsupported-claim' || err.code === 'semantic-inference-limit' || err.code === 'semantic-pilot-boundary',
  ).length;
}

export function runTrackedSyntheticSuite(briefsByCaseId) {
  const briefs = readBriefMap(briefsByCaseId, 'briefsByCaseId', { allowedCaseIds: TRACKED_SYNTHETIC_CASE_IDS });
  const cases = [];
  const missing = [];
  for (const caseId of TRACKED_SYNTHETIC_CASE_IDS) {
    if (!briefs.has(caseId)) {
      missing.push(caseId);
      continue;
    }
    cases.push(scoreTrackedSyntheticCase(caseId, { briefText: briefs.get(caseId) }));
  }
  if (missing.length > 0) {
    fail(`Tracked synthetic suite missing explicit case briefs: ${missing.join(', ')}`);
  }

  const materialUnsupportedClaimCount = cases.reduce(
    (acc, item) => acc + summarizeMaterialUnsupported(item.materialErrors),
    0,
  );
  const usableCount = cases.filter((item) => item.rubric.usability.usableWithMinorEdits).length;

  return deepFreeze({
    suiteKind: 'tracked',
    suiteLabel: 'tracked-synthetic',
    cases,
    summary: deepFreeze({
      count: cases.length,
      expectedCount: TRACKED_SYNTHETIC_CASE_IDS.length,
      materialUnsupportedClaimCount,
      usableWithMinorEditsCount: usableCount,
      zeroMaterialUnsupportedClaims: materialUnsupportedClaimCount === 0,
      factsProven: false,
      factualVerificationPerformed: false,
    }),
    gates: deepFreeze({
      proposedUsableThreshold: 16,
      usableWithMinorEditsCount: usableCount,
      meetsProposedUsableGate: usableCount >= 16,
      zeroMaterialUnsupportedClaimsAcrossTracked: materialUnsupportedClaimCount === 0,
      factsProven: false,
      factualVerificationPerformed: false,
    }),
    disclaimer: STRUCTURAL_CHECK_DISCLAIMER,
    humanReviewNote: HUMAN_SEMANTIC_REVIEW_REQUIRED,
  });
}

export function runHoldoutSyntheticSuite(briefsByCaseId) {
  const briefs = readBriefMap(briefsByCaseId, 'briefsByCaseId', { allowedCaseIds: SYNTHETIC_HOLDOUT_CASE_IDS });
  const cases = [];
  const missing = [];
  for (const caseId of SYNTHETIC_HOLDOUT_CASE_IDS) {
    if (!briefs.has(caseId)) {
      missing.push(caseId);
      continue;
    }
    cases.push(scoreHoldoutSyntheticCase(caseId, { briefText: briefs.get(caseId) }));
  }
  if (missing.length > 0) {
    fail(`Holdout synthetic suite missing explicit case briefs: ${missing.join(', ')}`);
  }

  const materialUnsupportedClaimCount = cases.reduce(
    (acc, item) => acc + summarizeMaterialUnsupported(item.materialErrors),
    0,
  );

  return deepFreeze({
    suiteKind: 'holdout',
    suiteLabel: SYNTHETIC_HOLDOUT_SUITE_LABEL,
    cases,
    summary: deepFreeze({
      count: cases.length,
      expectedCount: SYNTHETIC_HOLDOUT_CASE_IDS.length,
      notDrawnFromTrackedSuite: true,
      materialUnsupportedClaimCount,
      factsProven: false,
      factualVerificationPerformed: false,
    }),
    disclaimer: STRUCTURAL_CHECK_DISCLAIMER,
    humanReviewNote: HUMAN_SEMANTIC_REVIEW_REQUIRED,
  });
}

export function runTwentyPlusFiveEvaluation(input) {
  assertPlainObject(input, 'runTwentyPlusFiveEvaluation input', ['tracked', 'holdout']);
  const tracked = runTrackedSyntheticSuite(input.tracked);
  const holdout = runHoldoutSyntheticSuite(input.holdout);
  return deepFreeze({
    format: BRIEF_EVALUATION_FORMAT,
    version: BRIEF_EVALUATION_VERSION,
    tracked,
    holdout,
    disclaimer: STRUCTURAL_CHECK_DISCLAIMER,
    humanReviewNote: HUMAN_SEMANTIC_REVIEW_REQUIRED,
  });
}

export class BriefEvaluationLibrary {
  evaluateBrief(input) {
    return evaluateBrief(input);
  }

  parseSourceLineAnchors(sourceText) {
    return parseSourceLineAnchors(
      readString(sourceText, 'sourceText', BRIEF_EVALUATION_LIMITS.maxSourceTextBytes, {
        allowEmpty: true,
      }),
    );
  }

  getTrackedSyntheticCaseDefinition(caseId) {
    return getTrackedSyntheticCaseDefinition(caseId);
  }

  getHoldoutSyntheticCaseDefinition(caseId) {
    return getHoldoutSyntheticCaseDefinition(caseId);
  }

  listSyntheticSuites() {
    return listSyntheticSuites();
  }

  scoreTrackedSyntheticCase(caseId, briefInput) {
    return scoreTrackedSyntheticCase(caseId, briefInput);
  }

  scoreHoldoutSyntheticCase(caseId, briefInput) {
    return scoreHoldoutSyntheticCase(caseId, briefInput);
  }

  runTrackedSyntheticSuite(briefsByCaseId) {
    return runTrackedSyntheticSuite(briefsByCaseId);
  }

  runHoldoutSyntheticSuite(briefsByCaseId) {
    return runHoldoutSyntheticSuite(briefsByCaseId);
  }

  runTwentyPlusFiveEvaluation(input) {
    return runTwentyPlusFiveEvaluation(input);
  }
}

export function createBriefEvaluationLibrary() {
  return new BriefEvaluationLibrary();
}