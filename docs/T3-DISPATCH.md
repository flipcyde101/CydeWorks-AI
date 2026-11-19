# CydeWorks T3 dispatch

The coordinator owns each work item from assignment through handoff. Record the package, worktree, owner, exact provider instance and model, requested effort, current run ID, and next action in each dispatch report. Use one writer per scope. The queue receipt confirms only that T3 accepted the request.

## Before submitting

1. Identify the exact included subscription route. Confirm that the provider instance uses the intended subscription and that the model and requested effort are available for that role. A catalog entry or an authenticated provider alone cannot establish usable quota.
2. Check the most recent outcome for that route and any known shared quota bucket. Prefer explicit current allowance evidence. If T3 cannot expose allowance, useful output from the exact route in the last 15 minutes is a weaker signal. Use it for at most one real work item while quota is uncertain and observe the first provider outcome before queuing more. Elapsed time alone cannot clear a known failure.
3. Skip any route with a later quota, sign-in or billing failure. For a quota failure, record the timestamp, reported reset or unknown reset, affected model and established shared bucket, and source run. Any possibly shared pool with conflicting evidence stays unverified. Do not retry before the reported reset. After reset, recheck readiness and allow at most one supervised attempt on real work before sending more. Auth and billing failures clear only with evidence that their cause was resolved.
4. Record T3's run ID. Mark a job running for capacity reports only after real work output or tool activity from the requested model. Report a T3 queue receipt as submitted. Recheck submitted jobs for actual provider failures. Check the outcome of each known live run before counting it as capacity for the next wave.

## Recovery after a failed dispatch

The coordinator handles recovery. The worker reports the exact error and preserves its worktree. It does not retry itself or launch another worker.

1. Mark the route held as soon as the actual run reports a quota, authentication, or billing failure. Stop submitting new work to it. Check for already queued work using that route. Use supported controls to withdraw an unstarted assignment when available and authorized. Otherwise flag it as held and avoid waking that thread. Let unrelated active work finish.
2. Confirm that the failed run is terminal. Inspect the previous worktree's status and head. Transfer ownership only after the original writer has stopped. Preserve all partial work and pass it explicitly to the successor. For a clean abandoned attempt, use a fresh worktree rooted at the same base.
3. Pick another verified included builder route with a free slot and submit the same scoped assignment once. Grok, Cursor, and any verified Antigravity or Claude model are eligible for builds where suited to the task. If the next route is also held or no route can be verified, keep this item ready with the blocker and owner. Continue other work with usable capacity. There is no automatic paid fallback.
4. Independent reviews use Codex GPT-6.2 Sol High only. Hold the review when that route is unavailable. Build authorization does not permit a reviewer substitution. Preserve any scope, safety, approval and integration gates on the task.

This workflow controls the coordinator's dispatches. T3's manual model picker and other users' queues are outside its scope. The coordinator must apply the checks before every supervised submission.

## During a workwave

Keep a bounded supervision pass open until every assigned writer is terminal, its stated time limit is reached, or an actual blocker requires the owner. A single completed writer is a handoff to inspect, not a reason to stop monitoring the other writers. Record the outcome and preserve each worktree's owner while work remains active.

When an actual provider error establishes a quota or billing hold, inspect already submitted and queued work for that route. Use T3's supported queue cancellation only for messages that have not started; do not interrupt an active writer merely to change models. Once the failed writer is terminal, preserve its worktree and assign at most one successor on a verified included route. If the reported reset has passed, that is a reason for one supervised real-work attempt, not proof that quota has returned.

Cursor documents its included weekly pool as shared with Grok for the applicable plans. Treat matching Cursor and Grok balances as a possible shared reserve, not independent capacity, and check actual route outcomes. Cursor's third-party models can require prepaid usage even when the model appears in T3's catalog. Do not select such a route as included without account-specific evidence. See [Cursor models and pricing](https://cursor.com/docs/models-and-pricing).

These are coordinator operating rules, not a verified automatic quota watcher or a guarantee that T3 exposes real-time allowance for every model. Record actual provider outcomes and use supported queue controls; do not report instruction-based monitoring as automatic failover.
