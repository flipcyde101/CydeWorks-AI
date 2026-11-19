// DEMO APPROXIMATION of the acceptance panel view model for tasks created in this demonstration.
// At integration this file is deleted: the host calls Antigravity's assessAcceptance(...) and maps
// the result with adapters/slots.js acceptancePanel(...). Nothing here decides acceptance.

export function demoAcceptance(task) {
  const attempt = task.attempts.at(-1);
  if (!attempt?.artifact) return null;
  const revision = attempt.operatorEdits?.length ?? 0;
  const structural = attempt.checks.map((check, index) => ({id: 'structural-' + index, title: check.name,
    state: check.pass ? 'satisfied' : 'failed', label: check.pass ? 'Satisfied' : 'Failed', category: check.pass ? 'satisfied' : 'failing',
    symbol: check.pass ? '✓' : '✕', origin: 'host-inspection', nextSteps: [],
    explanation: 'A current host inspection record reports ' + (check.pass ? 'passed' : 'failed') + ' for revision ' + revision + '.'}));
  const reviewed = task.status === 'accepted';
  const human = [{id: 'operator-review', title: 'Operator reviewed accuracy and behavior', origin: 'operator', nextSteps: [],
    state: reviewed ? 'satisfied' : 'missing', label: reviewed ? 'Satisfied' : 'Missing', category: reviewed ? 'satisfied' : 'unavailable', symbol: reviewed ? '✓' : '○',
    explanation: reviewed ? 'An operator decision is recorded for revision ' + revision + '.' : 'No operator review is recorded for revision ' + revision + '.'}];
  const all = [...structural, ...human];
  const count = category => all.filter(check => check.category === category).length;
  const satisfied = count('satisfied');
  return {advisory: true, grantsAuthorization: false, checklistSatisfied: satisfied === all.length, revision,
    summary: {required: all.length, satisfied, failing: count('failing'), unresolved: 0, unavailable: count('unavailable')},
    groups: {structural, executed: [], human},
    explanation: satisfied === all.length ? 'All ' + all.length + ' required checks have current records for revision ' + revision + '.'
      : satisfied + ' of ' + all.length + ' required checks have current records for revision ' + revision + '.',
    reminder: 'Passing checks do not replace reading the change.',
    limitations: ['This assessment is advisory. It does not accept a task or grant any permission.',
      'Shown from a demo approximation, not from the Acceptance Evidence engine.']};
}
