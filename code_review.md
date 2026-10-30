# Code review guidance

Review correctness before style. Focus on defects, regressions, unsafe assumptions, and missing verification. Do not invent low-value style findings when automated tools already cover them.

`AGENTS.md` is canonical. Apply only the checklist items relevant to the changed behavior. `$twin-verify` incorporates this review and uses the combined report format below; review-only requests use the same format with unavailable checks called out.

## Review checklist

- When multiple agents contributed, review the combined repository state rather than trusting per-agent summaries. Confirm declared path ownership did not overlap, shared interfaces still agree, integration did not omit dependent changes, and combined tests cover cross-slice behavior.
- Validate request limits, external input, typed errors, retry behavior, idempotency, and concurrency.
- Confirm every record, asset, mutation, context query, and idempotency key remains owner-scoped.
- Preserve atomic imports, source provenance, direct-user-edit precedence, and removal tombstones.
- Keep real Calendar commitments, possible Gmail context, imagined twin activity, and user-reported actual activity visibly distinct.
- Ensure new evidence affects a future twin-day version without mutating today's displayed version.
- Keep secrets encrypted and out of logs, DTOs, exports, browser state, URLs, fixtures, screenshots, and error messages.
- Check OAuth state validation, provider failure mapping, stale cursors, deletions, suppression, reconnect paths, and bounded context.
- Check transaction boundaries, job claiming and recovery, duplicate paid effects, and retry safety.
- Keep browser/backend boundaries intact; provider calls and raw credentials belong on the server.
- Require tests for changed success, failure, retry, conflict, and deletion behavior as applicable.
- Check database migration compatibility, environment documentation, and deployment assumptions.
- Do not accidentally treat this local single-user prototype as production-ready or multi-user safe.

## Finding format

Each finding should include:

- Severity and a precise file/symbol location.
- The concrete behavior and why it is incorrect or risky.
- Evidence or a minimal reproduction path.
- A narrow recommended fix.

Use these severities:

- **Critical:** credible data loss, credential exposure, destructive behavior, or a release-blocking security failure.
- **High:** broken core behavior, ownership/privacy violations, integrity failures, or likely regressions without a safe workaround.
- **Medium:** bounded correctness, recovery, compatibility, or verification gaps with meaningful impact.
- **Low:** concrete maintainability or usability risk that does not currently break required behavior.

Order the report as:

1. Result: pass, partial, or fail.
2. Findings, highest severity first.
3. Questions or assumptions.
4. Checks observed.
5. Skipped or unavailable checks.
6. Residual risk.

If there are no findings, say so explicitly and still report checks and residual risk.

Subagent findings are evidence for the main coordinating agent. Only the main thread reconciles duplicates or conflicts, decides whether fixes are in scope, and issues the final review and verification result.
