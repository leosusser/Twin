# Execution plans

Use an execution plan before multi-module work, migrations or data-model changes, authentication or secret handling, privacy-sensitive changes, API contract changes, provider integrations, async jobs, or multi-screen flows. Skip a formal plan for isolated typos and other obvious, low-risk edits.

`AGENTS.md` is canonical. This file narrows how complex work is planned and tracked without expanding product scope or authorization.

## Modes and ownership

- **Plan-only:** when the user asks to plan, design, scope, or compare approaches, create or update the plan and stop before implementation.
- **Plan then build:** when the user explicitly asks to build, implement, or fix, create or update the plan first and continue once material decisions are resolved. Ask again only if the plan exposes a choice that changes scope, risk, or acceptance criteria.
- Store durable plans at `docs/plans/<slug>.md` using a short kebab-case slug. The main coordinating agent owns the plan through handoff and keeps its status, discoveries, decisions, integration notes, and verification results current.

## Planning workflow

1. Read the applicable `AGENTS.md` and inspect the relevant documentation, manifests, source, tests, and current diff.
2. Separate repository facts from assumptions. Ask only about decisions that materially change scope, behavior, risk, or acceptance criteria.
3. Trace the affected behavior end to end and identify data, ownership, trust, concurrency, retry, and compatibility boundaries.
4. Decide whether delegation materially improves the work. Record a delegation map only for independent tasks; keep small, tightly coupled, or shared-state work with the main agent.
5. Prefer ordered, independently verifiable vertical slices. Every implementation step must map to an observable Done criterion. A delegated slice must also name its agent role, dependencies, exact write ownership (or read-only scope), and return contract.
6. Keep the plan current while work proceeds. Use `Not started`, `In progress`, `Blocked`, and `Done`. Normally only one slice is `In progress`; multiple slices may be `In progress` only when the plan marks them as one parallel group with resolved interfaces and non-overlapping write ownership.
7. Record discoveries, subagent results, integration decisions, and decision changes. Treat reports as evidence to reconcile, not as automatic proof; never mark a check passed unless it was actually observed.
8. Keep credentials, paid calls, destructive data actions, deployments, commits, and pushes behind separate explicit authorization.
9. Stop at the plan's stated completion boundary instead of beginning unrelated phases.

## Plan template

```markdown
# [Change name]

Status: Not started

Owner: Main coordinating agent

## Goal

[The user-visible or operational outcome.]

## Context and evidence

[Current behavior, relevant files, tests, and observed constraints.]

## Constraints

[Security, compatibility, product, data, and authorization limits.]

## In scope

- [Required outcome]

## Non-goals

- [Explicitly deferred work]

## Decisions and assumptions

- [Decision, evidence, or stated assumption]

## Discoveries

- [New evidence and its effect on the plan, or `None`]

## Delegation map

- Decision: [Why delegation helps, or why the main agent will work alone]
- [Agent role/task]: [read scope; exclusive write scope or read-only; dependencies; done criteria; required report]

## Implementation slices

1. **[Slice] — Not started**
   - Owner:
   - Dependencies:
   - Write scope:
   - Change:
   - Data or interface impact:
   - Verification:

## Final verification

- `[exact command]`
- [Manual flow and expected result]

## Verification results

- [Observed command or manual result, including failures and skips; leave pending until run]

## Progress

- [Date or milestone: slice/status change and why]

## Risks and recovery

- Risk:
- Safeguard or rollback:

## Done when

- [Observable acceptance criterion]
```
