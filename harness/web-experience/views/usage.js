import {h, swap, stableKey} from '../core/dom.js';
import {button, chip, notice, kv, panel, emptyState, simulated} from '../ui/primitives.js';
import {formatCount, formatDuration, formatMicros, formatSignedMicros} from '../core/format.js';
import {mode} from '../core/mode.js';
import {usageRow, coverageNotice, receiptCoverage, coverageSummary} from '../logic/usage-rows.js';
import {comparisonView, costDifferenceInput, receiptView} from '../adapters/slots.js';
import {STATUS_LABEL} from '../logic/situation.js';
import {openReceiptDialog} from './dialogs.js';

const pick = {baseline: null, candidate: null};

// The cost sentence comes from the reviewed formatter behind POST /api/cost-presentation (Qwen's
// describeCostDifference), shown as plain text exactly as returned. Until it answers, or if it
// cannot be reached, only the exact micros figure is shown and no sentence is improvised.
const presented = new Map();
function costPresentation(ctx, input, rerender) {
  const key = JSON.stringify(input);
  const entry = presented.get(key);
  if (entry) return entry;
  presented.set(key, {pending: true});
  ctx.adapter.presentCost(input).then(result => presented.set(key, {result}), () => presented.set(key, {failed: true})).then(rerender);
  return presented.get(key);
}
function costRows(entry, input) {
  const exact = input.available ? ['Exact difference', formatSignedMicros(input.deltaMicros) + ' ' + input.currency + ' = ' + input.deltaMicros.toLocaleString('en-US') + ' micros (baseline minus candidate)'] : null;
  if (entry.pending) return [['Cost', 'Formatting the recorded difference.'], exact];
  if (entry.failed || !entry.result?.presentation) return [['Cost', 'The cost formatter did not respond. Only the exact figure is shown.'], exact];
  const view = entry.result.presentation;
  return [['Cost', h('span', {dataset: {fid: 'cost-headline'}}, String(view.headline))], ['Cost detail', String(view.detail)], ['Cost caveat', String(view.caveat)], exact,
    ['Formatter', 'Formats the supplied figure only. It does not authenticate a bill or establish savings.']];
}

function comparison(ctx, data, usable, rerender) {
  if (!usable.some(item => item.key === pick.baseline)) pick.baseline = usable[0]?.key ?? null;
  if (!usable.some(item => item.key === pick.candidate)) pick.candidate = usable.find(item => item.key !== pick.baseline)?.key ?? null;
  const select = (role, label) => h('label', {for: 'compare-' + role}, label,
    h('select', {id: 'compare-' + role, dataset: {fid: 'compare-' + role}, onchange: event => { pick[role] = event.target.value; rerender(); }},
      usable.map(item => h('option', {value: item.key, selected: item.key === pick[role] ? '' : undefined}, item.title))));
  const a = usable.find(item => item.key === pick.baseline), b = usable.find(item => item.key === pick.candidate);
  // The HTTP adapter compares any pair with the pinned Run Inspector; the demo holds one precomputed pair.
  const compared = a && b && a.key !== b.key ? (data.compare ? data.compare(a.key, b.key)
    : data.comparisons.find(item => item.baseline === pick.baseline && item.candidate === pick.candidate)?.result ?? null) : null;
  const view = compared ? comparisonView(compared) : null;
  let result;
  if (!a || !b) result = h('p', {class: 'muted'}, 'Two accepted runs on the same input are needed.');
  else if (a.key === b.key) result = notice('warn', h('p', null, 'Choose two different runs. A run is not compared with itself.'));
  else if (!view) result = notice('info', h('p', null, 'This demonstration holds one precomputed pair in this order. On the workspace service the Run Inspector compares any pair and refuses runs with different inputs or without acceptance.'));
  else if (!view.comparable) result = notice('warn', h('p', null, 'Not comparable. ' + view.reasons.join(' ')));
  else {
    const input = costDifferenceInput(view);
    result = h('div', {class: 'stack'},
      h('p', {class: 'faint mono'}, 'Baseline ' + receiptView(a.envelope).runId + ' · candidate ' + receiptView(b.envelope).runId + ' · same input ' + receiptView(a.envelope).inputRevision),
      h('h3', null, 'Observed difference in these two samples'),
      kv([
        ['Time', !view.time.available ? 'Unavailable. ' + view.time.reasons.join(' ')
          : Math.abs(view.time.deltaMs) < 50 ? 'Both windows were the same to within 0.1 s.'
          : 'The candidate window was ' + formatDuration(Math.abs(view.time.deltaMs)) + (view.time.deltaMs > 0 ? ' shorter.' : ' longer.')],
        ...costRows(costPresentation(ctx, input, rerender), input)]),
      h('p', {class: 'faint'}, 'One run each. Both were accepted, but equal quality was not measured. This says nothing about other tasks.'),
      h('h3', null, 'Estimated counterfactual savings'),
      h('p', null, 'Not calculated. CydeWorks AI does not estimate what a different route would have cost for work it did not run, and it does not report a money saved figure.'));
  }
  return panel([h('h2', null, 'Compare accepted work on the same input'), simulated()],
    h('div', {class: 'compare'}, select('baseline', 'Baseline run'), select('candidate', 'Candidate run')), result);
}

function workspaceTotals(report) {
  if (mode.synthetic) return null;
  if (!report) return panel(h('h2', null, 'Workspace totals'), h('p', null, 'Workspace totals are unavailable. Use the individual receipts below.'));
  const {coverage, summary} = report;
  const attempts = summary.attempts.totalAttemptCount;
  const elapsed = summary.timing.recordedElapsedMs;
  const unavailable = summary.envelopeCounts.unavailable + summary.envelopeCounts.malformed;
  const partial = unavailable > 0 || coverage.omittedTasks > 0 || !summary.tokens.historyComplete;
  const evidenceLabels = {'OpenCode reported': 'OpenCode', 'provider reported': 'Provider'};
  const observations = [
    ['Input', 'input'], ['Output', 'output'], ['Cache read', 'cached'], ['Cache write', 'cacheWrite'], ['Reasoning', 'reasoning'],
  ];
  const tokenRows = summary.tokens.byProvenance.flatMap(group => observations
    .filter(([, key]) => group.byCategory[key].knownSum !== null)
    .map(([label, key]) => [label + ' tokens · ' + (evidenceLabels[group.evidence] ?? 'Recorded'),
      formatCount(group.byCategory[key].knownSum) + ' across ' + formatCount(group.byCategory[key].knownAttemptCount) + ' attempts']));
  const costRows = summary.costs.groups.filter(group => group.knownSumMicros !== null).map(group => [
    'Recorded cost subtotal · ' + (group.evidence === 'estimated' ? 'Estimated' : 'Provider billed claim'),
    formatMicros(group.knownSumMicros) + ' ' + group.currency,
  ]);
  return panel(h('h2', null, 'Workspace totals'), h('div', {class: 'stack', dataset: {fid: 'workspace-totals'}},
    h('p', null, 'Checked ' + formatCount(coverage.checkedTasks) + ' of ' + formatCount(coverage.workspaceTasks) +
      ' tasks. ' + formatCount(summary.reconciliation.resolvedRunCount) + ' have usable receipts, and ' + formatCount(coverage.unrunDrafts) + ' are unrun drafts.'),
    partial ? notice('warn', h('p', null, 'Coverage is partial. These figures include known observations from usable receipts.')) : null,
    kv([
      ['Recorded attempts', formatCount(attempts) + ', including ' + formatCount(summary.runs.retries.retryAttemptCount) +
        ' retries, ' + formatCount(summary.attempts.statusCounts.failed) + ' failures, and ' +
        formatCount(summary.attempts.recordedStatusCounts.cancelled) + ' stopped'],
      ['Recorded attempt time', formatDuration(elapsed.cumulativeKnownElapsedMs) + ' across ' + formatCount(elapsed.knownAttemptCount) +
        ' of ' + formatCount(attempts) + ' attempts'],
      ['Charge coverage', formatCount(summary.costs.knownCostAttemptCount) + ' recorded, ' + formatCount(summary.costs.unknownCostAttemptCount) + ' unknown'],
      ...costRows,
      ...(tokenRows.length ? tokenRows : [['Token usage', 'Unavailable']]),
    ]),
    h('p', {class: 'faint'}, 'Attempt durations include retries. Token categories may overlap and are listed separately.')));
}

export function renderUsage(main, ctx) {
  const {state} = ctx, data = state.cache.usage;
  const acceptedRuns = data?.receipts.filter(item => item.envelope.available && item.envelope.run?.accepted === true) ?? [];
  const coverageText = data ? coverageSummary(receiptCoverage(data.receipts)) : null;
  const rerender = () => { if (state.path[0] !== 'usage' || !state.session.unlocked) return; delete main.dataset.swapKey; renderUsage(main, ctx); };
  swap(main, stableKey(['usage', data, state.tasks, pick]), () => h('div', {class: 'page'},
    h('div', {class: 'page-head'}, h('h1', null, 'Usage'),
      h('p', null, 'What each task used, attempt by attempt. Every figure says whether it was measured, reported by a provider, estimated, or unknown. An unknown figure is never shown as zero.')),
    !data ? h('p', {class: 'loading', role: 'status'}, 'Reading usage records.') : [
      workspaceTotals(data.analytics),
      coverageNotice(data) ? notice('warn', h('p', {dataset: {fid: 'usage-partial'}}, coverageNotice(data))) : null,
      panel([h('h2', null, 'By task'), simulated()],
        coverageText ? h('p', {id: 'usage-receipt-coverage', dataset: {fid: 'usage-receipt-coverage'}}, coverageText) : null,
        state.tasks.length ? h('div', {class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Usage by task',
          'aria-describedby': coverageText ? 'usage-receipt-coverage' : undefined}, h('table', null,
          h('thead', null, h('tr', null, ['Task', 'State', 'Attempts', 'Execution window', 'Total cost', 'Evidence', 'Receipt'].map(name => h('th', {scope: 'col'}, name)))),
          h('tbody', null, state.tasks.map(task => {
            const entry = data.receipts.find(item => item.taskId === task.id);
            const missing = data.unavailable?.find(item => item.taskId === task.id) ?? (data.omitted?.some(item => item.taskId === task.id) ? {reason: 'omitted'} : null);
            const row = usageRow(task, entry, missing);
            const status = entry?.envelope?.evidence?.task?.status;
            const label = Object.hasOwn(STATUS_LABEL, status) ? STATUS_LABEL[status] : STATUS_LABEL[task.status];
            const showCharge = row.cost?.label && row.cost.state !== 'unknown';
            return h('tr', {dataset: {fid: 'usage-row-' + task.id}}, h('th', {scope: 'row'}, h('a', {href: '#/task/' + task.id}, task.title)), h('td', null, label),
              h('td', null, row.attempts === null ? 'Unknown' : String(row.attempts)),
              h('td', null, row.time?.text ?? row.text),
              h('td', null, row.cost?.text ?? row.text),
              h('td', null, chip(row.coverageLabel ?? row.chip, row.kind === 'unknown' || row.coverage === 'unavailable' ? 'warn' : 'neutral'),
                showCharge ? [' ', chip(row.cost.label, row.cost.kind === 'estimated' ? 'warn' : 'neutral')] : null,
                row.note ? h('p', {class: 'faint'}, row.note) : null),
              h('td', null, entry ? button('Inspect', {fid: 'receipt-' + entry.key, onClick: event => openReceiptDialog(ctx, {title: entry.title, envelope: entry.envelope}, event.currentTarget)})
                : h('span', {class: 'faint'}, mode.synthetic && !missing ? 'Not in demo' : 'Unavailable')));
          }))))
          : emptyState('No usage yet', 'Usage appears after a task has run at least one attempt.', h('a', {class: 'btn btn-primary', href: '#/new'}, 'Describe work')),
        h('p', {class: 'faint'}, 'The execution window runs from the first attempt start to the last attempt end, counting failures and gaps. Waiting and review time are shown per attempt on each task. ' +
          (mode.synthetic ? 'Receipts are real host exports of synthetic tasks.' : 'Receipts are read from the workspace, one per task, and summarized here by the pinned Run Inspector.'))),
      acceptedRuns.length >= 2 ? comparison(ctx, data, acceptedRuns, rerender) : null]));
}
