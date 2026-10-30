---
name: twin-plan
description: Create and maintain an implementation-ready, repository-grounded plan, ask focused questions, and hand authorized build requests into implementation. Use when planning, designing, scoping, or de-risking a complex Personal Twin feature, refactor, migration, integration, or other cross-cutting change.
---

# Plan a Personal Twin change

Follow `AGENTS.md` as canonical guidance. Use one of two modes:

- **Plan-only:** if the user asks to plan, design, scope, or compare approaches, create or update the plan and stop before implementation.
- **Plan then build:** if the user explicitly asks to build, implement, or fix, create or update the plan first, then continue into the authorized implementation once material decisions are resolved.

Use this workflow when work spans the UI, API, storage, worker, or providers; changes data, security, or privacy behavior; or has unclear boundaries or acceptance criteria. Skip it for a small obvious edit unless the user explicitly requests a plan.

## Workflow

1. The main thread is the coordinating head and plan owner. Read the applicable `AGENTS.md` and `PLANS.md`, then inspect relevant documentation, manifests, source, tests, and the current git status or diff. Preserve existing user changes.
2. Frame the request as:
   - **Goal:** the outcome to produce.
   - **Context:** relevant current behavior and architecture.
   - **Constraints:** product, security, compatibility, data, and authorization limits.
   - **Done:** observable acceptance criteria.
3. Ask one concise batch of one to three questions only when the answers materially change scope, architecture, risk, or acceptance criteria. Do not ask for facts available in the repository; state safe assumptions for non-blocking gaps.
4. Trace the behavior end to end, including ownership, trust, transaction, concurrency, retry, and UI-label boundaries.
5. Decide whether delegation will materially improve speed, evidence, or quality. Keep small, tightly coupled, or shared-state work in the main thread. During planning, use at most two independent `twin_explorer` investigations and reconcile their findings. In plan-then-build mode, use `twin_builder` only after material decisions and interfaces are resolved, with exact non-overlapping write ownership and acceptance criteria; never assign concurrent writers to the same path.
6. Produce or update an execution plan using `PLANS.md`. Default to `docs/plans/<slug>.md`; the main coordinating agent owns status, discoveries, decisions, integration, and verification results through handoff. Include a delegation map naming each delegated task's role, read scope, exclusive write scope or read-only status, dependencies, done criteria, and required report. Prefer independently testable vertical slices over speculative infrastructure.
7. Map every Done criterion to an implementation step and an exact automated or manual verification check. Distinguish repository facts from assumptions. Subagent reports are evidence to reconcile, not automatic proof of completion.
8. In plan-only mode, stop after the plan. In plan-then-build mode, wait for required subagent results, inspect and integrate the combined repository state, and continue without asking for a second approval unless a newly discovered choice materially changes scope, risk, or acceptance criteria. Keep the plan current and run `$twin-verify` in the main thread before handoff.

The result must be detailed enough that another agent can implement it without repeating the investigation.
