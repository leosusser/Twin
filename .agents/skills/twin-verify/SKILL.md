---
name: twin-verify
description: Run proportional, evidence-based verification for Personal Twin changes and report failures, skipped checks, and residual risk. Use after code or workflow changes, before handoff or a pull request, or when asked to test, check, or verify work.
---

# Verify a Personal Twin change

Verify what actually changed. Never claim an unavailable integration, skipped check, or unobserved behavior passed.

Follow `AGENTS.md` as canonical guidance. This workflow combines proportional verification with the diff review defined in `code_review.md` and returns one handoff report.

## Workflow

1. The main coordinating thread owns verification and the final report. Read the applicable `AGENTS.md` and `code_review.md`. After all implementation agents have finished, inspect the combined changed paths, diff, package scripts, and relevant tests while preserving unrelated work.
2. Identify affected behavior, trust boundaries, and the highest-risk failure modes.
3. Run the smallest relevant checks first, then broaden. Do not install tools, use credentials, or mutate external state solely to make verification pass without authorization.
4. Review the combined changed behavior against `code_review.md`, including cross-slice interfaces and undeclared ownership overlap, then apply the repository checks below. For secrets, migrations, persistence, multiple trust boundaries, or work produced by parallel builders, use at most one `twin_reviewer` subagent while automated checks run. Treat its report as evidence; reconcile it in the main thread.
5. If implementation is in scope, make only narrow repairs already authorized by the request and plan, then rerun failed and dependent checks. Route fixes that expand product scope or materially change schemas, security/privacy behavior, architecture, or authorization back to the plan and user. For verify-only requests, make no edits and report the defect with evidence.
6. Distinguish product failures from environment or credential limitations.
7. Respect the repository's `approval_policy = "on-request"`. Work inside the sandbox by default. If a required verification action is blocked and no safe permitted equivalent exists, request narrowly scoped approval; if approval is denied or unavailable, report the exact substitution or unavailable check. Never bypass a denied request.

## Repository checks

- Documentation, skills, or Codex configuration only: validate syntax, links, names, and referenced paths. Use a fresh trusted session when discovery behavior itself must be confirmed.
- JavaScript, TypeScript, browser, tests, or workflow configuration: run focused tests when available, then `npm run verify`.
- Database, migration, import, or storage: also run `npm run test:postgres` only when `TEST_DATABASE_URL` targets a dedicated disposable empty database. Never substitute the application database.
- UI behavior: exercise the changed flow at desktop and narrow-phone sizes; check keyboard focus and relevant loading, empty, error, and reduced-motion states.
- OpenAI or Google integration: verify mock/demo paths and failure mapping. Run live checks only with explicit credential availability and authorization.

## Report

Only the main coordinating thread returns one combined report, in this order:

- **Result:** pass, partial, or fail.
- **Findings:** location, impact, and evidence, or `None`.
- **Questions or assumptions:** unresolved material items, or `None`.
- **Checks run:** exact command or manual flow, result, and useful counts.
- **Skipped or unavailable:** reason and what is required.
- **Residual risk:** what remains unverified, or `None`.

Use `partial` when a material check is unavailable. Passing available checks does not erase a skipped critical check.
