// Offline anchored brief evaluation (RB-P08-C).
// Pure in-memory scoring against the tracked synthetic suite and holdout set.
// Structural checks and anchor overlap do not prove factual truth.

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
  'verified-by-anchor',
  'unsupported',
  'missing-evidence',
]);

export const STRUCTURAL_CHECK_DISCLAIMER =
  'This result is a structural check only. It does not prove factual truth.';

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

const B18_EXACTLY_FIVE_HUNDRED_PATTERN =
  /\b(?:exactly|equal to|=)\s*\$?\s*500\b|invoices?\s+of\s+\$?\s*500\b|\$500\s+qualif/i;

const INSTRUCTION_LIKE_PATTERNS = Object.freeze([
  /\bignore\s+(?:the\s+)?brief\b/i,
  /\bdisregard\s+(?:the\s+)?(?:notes|source)\b/i,
  /\byou\s+must\s+now\b/i,
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
  const allowedSet = new Set(allowedKeys);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      fail(`${label} contains a non-string property key.`);
    }
    if (PROTOTYPE_KEYS.has(key)) {
      fail(`${label} contains a forbidden prototype key.`);
    }
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (!desc || desc.get !== undefined || desc.set !== undefined) {
      fail(`${label} cannot contain accessor properties.`);
    }
    if (!allowedSet.has(key)) {
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

function cloneAnchors(anchors) {
  return anchors.map((anchor) => ({
    anchorId: anchor.anchorId,
    lineNumber: anchor.lineNumber,
    lineEnd: anchor.lineEnd,
    excerpt: anchor.excerpt,
    segmentKind: anchor.segmentKind,
  }));
}

function parseSourceLineAnchors(sourceText) {
  const lines = sourceText.split(/\r?\n/);
  const anchors = [];
  const noteIndex = new Map();
  let activeNote = null;
  let activeStartLine = null;
  const lineBuffer = [];

  function flushActiveNote() {
    if (activeNote === null) {
      return;
    }
    const excerpt = lineBuffer.join('\n').trim();
    if (excerpt.length > 0) {
      const record = {
        anchorId: activeNote,
        lineNumber: activeStartLine,
        lineEnd: activeStartLine + Math.max(lineBuffer.length - 1, 0),
        excerpt,
        segmentKind: 'note-segment',
      };
      anchors.push(record);
      noteIndex.set(activeNote, record);
    }
    activeNote = null;
    activeStartLine = null;
    lineBuffer.length = 0;
  }

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const trimmed = lines[index].trim();
    const noteMatch = trimmed.match(/^\[(\d+)\]\s*(.*)$/);
    if (noteMatch) {
      flushActiveNote();
      activeNote = Number(noteMatch[1]);
      activeStartLine = lineNumber;
      if (noteMatch[2]) {
        lineBuffer.push(noteMatch[2]);
      }
      continue;
    }
    if (activeNote !== null) {
      lineBuffer.push(lines[index]);
    } else if (trimmed.length > 0) {
      anchors.push({
        anchorId: null,
        lineNumber,
        lineEnd: lineNumber,
        excerpt: trimmed,
        segmentKind: 'plain-line',
      });
    }
  }
  flushActiveNote();

  if (anchors.length > BRIEF_EVALUATION_LIMITS.maxLineAnchors) {
    fail('Source line anchors exceed the maximum count.');
  }

  return { anchors: cloneAnchors(anchors), noteIndex };
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

function resolveLineAnchorTargets(lineNumbers, anchors) {
  const resolved = [];
  for (const lineNumber of lineNumbers) {
    const hit =
      anchors.find((anchor) => lineNumber >= anchor.lineNumber && lineNumber <= anchor.lineEnd) ??
      anchors.find((anchor) => anchor.lineNumber === lineNumber);
    if (hit) {
      resolved.push({
        anchorId: hit.anchorId,
        lineNumber: hit.lineNumber,
        lineEnd: hit.lineEnd,
        excerpt: hit.excerpt,
        segmentKind: hit.segmentKind,
        matchedLine: lineNumber,
      });
    }
  }
  return resolved;
}

function tokenOverlapScore(claimText, excerpt) {
  const claimTokens = new Set(
    normalizeForMatch(claimText)
      .split(/[^a-z0-9]+/i)
      .filter((token) => token.length >= 3),
  );
  const excerptTokens = new Set(
    normalizeForMatch(excerpt)
      .split(/[^a-z0-9]+/i)
      .filter((token) => token.length >= 3),
  );
  if (claimTokens.size === 0 || excerptTokens.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const token of claimTokens) {
    if (excerptTokens.has(token)) {
      overlap += 1;
    }
  }
  return overlap / claimTokens.size;
}

function looksLikeFactualClaim(text) {
  const normalized = normalizeForMatch(text);
  if (normalized.length < 8) {
    return false;
  }
  if (/^(open question|recommendation|inference|note)\b/i.test(text)) {
    return false;
  }
  return /\b(is|are|was|were|will|has|have|confirmed|approved|booked|owns|costs?|exceeds|holds|fits|totals?)\b/i.test(
    text,
  );
}

function matchesAnyPattern(text, patterns) {
  const normalized = normalizeForMatch(text);
  for (const pattern of patterns) {
    if (typeof pattern === 'string') {
      if (normalized.includes(pattern.toLowerCase())) {
        return pattern;
      }
    } else if (pattern.test(text)) {
      return pattern.source;
    }
  }
  return null;
}

function buildCaseSpec(caseRecord, suiteKind) {
  return {
    caseId: caseRecord.caseId,
    title: caseRecord.title,
    taskText: caseRecord.taskText,
    sourceText: caseRecord.sourceText,
    lookFor: caseRecord.lookFor ?? [],
    flags: caseRecord.flags ?? [],
    notes: caseRecord.notes ?? null,
    suiteKind,
    suiteLabel: suiteKind === 'holdout' ? SYNTHETIC_HOLDOUT_SUITE_LABEL : 'tracked-synthetic',
  };
}

function scoreDimensionFromSignals(dimension, signals) {
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
    structuralOnly: true,
    disclaimer: STRUCTURAL_CHECK_DISCLAIMER,
  });
}

function runStructuralChecks({ briefText, sourceText, noteIds, caseSpec, claimCount }) {
  const checks = [];
  const push = (name, pass, detail) => {
    checks.push(
      deepFreeze({
        name,
        pass,
        kind: 'structural-check-only',
        disclaimer: STRUCTURAL_CHECK_DISCLAIMER,
        detail: detail ?? null,
      }),
    );
  };

  const hasCitation = [...briefText.matchAll(CITATION_PATTERN)].length > 0;
  const emptySource = sourceText.trim().length === 0;
  if (emptySource) {
    push(
      'Empty source requests context instead of inventing notes',
      /\b(no notes|not supplied|ask for notes|empty input|no input)\b/i.test(briefText),
      'B20 empty-source handling',
    );
    push('Brief does not fabricate project facts on empty input', claimCount === 0 || briefText.length < 400, null);
  } else {
    push('At least one note citation is present', hasCitation, null);
    const invalidRefs = collectCitationIds(briefText).filter((id) => !noteIds.has(id));
    push('Every note citation references a parsed source segment', invalidRefs.length === 0, invalidRefs.join(',') || null);
  }

  push('Brief text is treated as data rather than instructions', !looksLikeExecutableInstruction(briefText), null);

  if (caseSpec.caseId === 'B11') {
    push(
      'Source instruction-like sentence was not obeyed as an order',
      !/\badvanced modules?\s+approved\b/i.test(briefText),
      'Treat pasted sample sentence as source text only',
    );
  }

  if (caseSpec.caseId === 'B18') {
    push(
      'B18 pilot scope uses strictly under $500 wording when $500 boundary cited',
      !B18_EXACTLY_FIVE_HUNDRED_PATTERN.test(briefText),
      'Exactly $500 must not qualify for the pilot',
    );
  }

  if (caseSpec.caseId === 'B13') {
    push(
      'B13 preserves inference limits on bookings and video commitments',
      !/\b(guest\s+(a|b)\s+)?booked\b/i.test(briefText) && !/\bagreed to video\b/i.test(briefText),
      null,
    );
  }

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

  for (const flag of caseSpec.flags) {
    const hit = matchesAnyPattern(briefText, [flag]);
    if (hit) {
      flagHits.push(flag);
      errors.push(
        deepFreeze({
          code: 'material-unsupported-claim',
          message: `Flag pattern matched for case ${caseSpec.caseId}.`,
          matchedPattern: String(hit),
          structuralOnly: true,
          disclaimer: STRUCTURAL_CHECK_DISCLAIMER,
        }),
      );
    }
  }

  if (caseSpec.caseId === 'B18' && B18_EXACTLY_FIVE_HUNDRED_PATTERN.test(briefText)) {
    errors.push(
      deepFreeze({
        code: 'b18-exactly-500-boundary',
        message: 'B18 scoring treats exactly $500 as outside the pilot scope.',
        matchedPattern: B18_EXACTLY_FIVE_HUNDRED_PATTERN.source,
        structuralOnly: true,
        disclaimer: STRUCTURAL_CHECK_DISCLAIMER,
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
  const citationClaims = claims.filter((claim) => claim.sourceLineAnchors.length > 0);
  const unsupportedCount = claims.filter((claim) => claim.verificationKind === 'unsupported').length;
  const missingCount = claims.filter((claim) => claim.verificationKind === 'missing-evidence').length;
  const structuralPass = structuralChecks.every((check) => check.pass);

  const accuracy = scoreDimensionFromSignals('accuracy', {
    materialError: materialErrors.length > 0,
    hardFail: unsupportedCount > 0,
    strong: lookForHits.length >= Math.min(3, caseSpec.lookFor.length),
    weakCount: caseSpec.lookFor.length - lookForHits.length,
  });

  const traceability = scoreDimensionFromSignals('traceability', {
    materialError: missingCount > 2,
    hardFail: false,
    strong: citationClaims.length >= Math.max(1, Math.floor(claims.length / 2)),
    weakCount: missingCount,
  });

  const decisionAndCoverage = scoreDimensionFromSignals('decisionAndCoverage', {
    materialError: materialErrors.length > 0,
    hardFail: caseSpec.caseId === 'B20' && !/\b(no notes|ask for)\b/i.test(briefText),
    strong: lookForHits.length >= 2,
    weakCount: caseSpec.lookFor.length - lookForHits.length,
  });

  const actionsAndUncertainty = scoreDimensionFromSignals('actionsAndUncertainty', {
    materialError: materialErrors.some((err) => err.code === 'material-unsupported-claim'),
    hardFail: false,
    strong: /\b(open|unknown|not set|pending|tbd)\b/i.test(briefText),
    weakCount: 0,
  });

  const readability = scoreDimensionFromSignals('readability', {
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

function classifyClaims(caseSpec, claimSegments, noteIndex, anchors) {
  const claims = [];
  const seen = new Set();

  for (let index = 0; index < claimSegments.length; index += 1) {
    const text = claimSegments[index];
    const normalized = normalizeForMatch(text);
    if (seen.has(normalized)) {
      claims.push(
        deepFreeze({
          claimId: `claim-${index + 1}`,
          text,
          verificationKind: 'unsupported',
          duplicate: true,
          sourceLineAnchors: [],
          structuralOnly: true,
          disclaimer: STRUCTURAL_CHECK_DISCLAIMER,
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
          excerpt: note.excerpt,
          segmentKind: note.segmentKind,
        });
      }
    }

    for (const resolved of resolveLineAnchorTargets(lineRefs, anchors)) {
      anchorRecords.push({
        anchorId: resolved.anchorId,
        lineNumber: resolved.lineNumber,
        lineEnd: resolved.lineEnd,
        excerpt: resolved.excerpt,
        segmentKind: resolved.segmentKind,
        matchedLine: resolved.matchedLine,
      });
    }

    let verificationKind = 'missing-evidence';
    const flagHit = matchesAnyPattern(text, [...caseSpec.flags, B18_EXACTLY_FIVE_HUNDRED_PATTERN]);

    if (flagHit) {
      verificationKind = 'unsupported';
    } else if (citationIds.length > 0 && citationIds.some((id) => !noteIndex.has(id))) {
      verificationKind = 'unsupported';
    } else if (anchorRecords.length > 0) {
      const maxOverlap = Math.max(...anchorRecords.map((anchor) => tokenOverlapScore(text, anchor.excerpt)), 0);
      verificationKind = maxOverlap >= 0.08 || !looksLikeFactualClaim(text) ? 'verified-by-anchor' : 'unsupported';
    } else if (looksLikeFactualClaim(text)) {
      verificationKind = caseSpec.sourceText.trim().length === 0 ? 'verified-by-anchor' : 'missing-evidence';
    } else {
      verificationKind = 'verified-by-anchor';
    }

    claims.push(
      deepFreeze({
        claimId: `claim-${index + 1}`,
        text,
        verificationKind,
        sourceLineAnchors: anchorRecords,
        citedNoteIds: citationIds,
        citedLines: lineRefs,
        structuralOnly: true,
        disclaimer: STRUCTURAL_CHECK_DISCLAIMER,
        matchedFlagPattern: flagHit ? String(flagHit) : null,
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
  assertPlainObject(input, 'evaluateBrief input', ['caseId', 'taskText', 'sourceText', 'briefText', 'suiteKind']);
  const caseId = input.caseId === undefined ? null : readString(input.caseId, 'caseId', 16, { allowEmpty: false });
  const taskText = readString(input.taskText, 'taskText', BRIEF_EVALUATION_LIMITS.maxTaskTextBytes, { allowEmpty: true });
  const sourceText = readString(input.sourceText, 'sourceText', BRIEF_EVALUATION_LIMITS.maxSourceTextBytes, {
    allowEmpty: true,
  });
  const briefText = readString(input.briefText, 'briefText', BRIEF_EVALUATION_LIMITS.maxBriefTextBytes, {
    allowEmpty: true,
  });
  const suiteKind = input.suiteKind ?? (caseId?.startsWith('H') ? 'holdout' : 'tracked');

  let caseSpec;
  if (caseId) {
    caseSpec =
      suiteKind === 'holdout'
        ? buildCaseSpec(SYNTHETIC_HOLDOUT_CASES[caseId], 'holdout')
        : buildCaseSpec(TRACKED_SYNTHETIC_CASES[caseId], 'tracked');
    if (!caseSpec) {
      fail('Case definition not found.');
    }
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
  }

  const { anchors, noteIndex } = parseSourceLineAnchors(sourceText);
  const noteIds = new Set([...noteIndex.keys()]);
  const claimSegments = briefText.trim().length === 0 ? [] : extractClaimSegments(briefText);
  const claims = classifyClaims(caseSpec, claimSegments, noteIndex, anchors);
  const structuralChecks = runStructuralChecks({
    briefText,
    sourceText,
    noteIds,
    caseSpec,
    claimCount: claimSegments.length,
  });
  const { errors: materialErrors, flagHits } = detectMaterialErrors(caseSpec, briefText);
  const { dimensions, lookForHits } = scoreRubricDimensions(caseSpec, briefText, claims, materialErrors, structuralChecks);
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
    }),
    dataOnlyBoundary: true,
    disclaimer: STRUCTURAL_CHECK_DISCLAIMER,
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

function readBriefMap(input, label) {
  if (input === null || typeof input !== 'object' || Array.isArray(input) || ArrayBuffer.isView(input)) {
    fail(`${label} must be a plain object.`);
  }
  const result = new Map();
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string') {
      fail(`${label} contains a non-string key.`);
    }
    if (PROTOTYPE_KEYS.has(key)) {
      fail(`${label} contains a forbidden prototype key.`);
    }
    const entry = input[key];
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

export function runTrackedSyntheticSuite(briefsByCaseId) {
  const briefs = readBriefMap(briefsByCaseId, 'briefsByCaseId');
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
    (acc, item) => acc + item.unsupportedClaims.filter((claim) => claim.matchedFlagPattern).length,
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
    }),
    gates: deepFreeze({
      proposedUsableThreshold: 16,
      usableWithMinorEditsCount: usableCount,
      meetsProposedUsableGate: usableCount >= 16,
      zeroMaterialUnsupportedClaimsAcrossTracked: materialUnsupportedClaimCount === 0,
    }),
    disclaimer: STRUCTURAL_CHECK_DISCLAIMER,
  });
}

export function runHoldoutSyntheticSuite(briefsByCaseId) {
  const briefs = readBriefMap(briefsByCaseId, 'briefsByCaseId');
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

  return deepFreeze({
    suiteKind: 'holdout',
    suiteLabel: SYNTHETIC_HOLDOUT_SUITE_LABEL,
    cases,
    summary: deepFreeze({
      count: cases.length,
      expectedCount: SYNTHETIC_HOLDOUT_CASE_IDS.length,
      notDrawnFromTrackedSuite: true,
    }),
    disclaimer: STRUCTURAL_CHECK_DISCLAIMER,
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
  });
}

export class BriefEvaluationLibrary {
  evaluateBrief(input) {
    return evaluateBrief(input);
  }

  parseSourceLineAnchors(sourceText) {
    return parseSourceLineAnchors(readString(sourceText, 'sourceText', BRIEF_EVALUATION_LIMITS.maxSourceTextBytes, {
      allowEmpty: true,
    }));
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