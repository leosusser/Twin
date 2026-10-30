# Repository workflow foundation

Status: Done

## Goal

Make project context durable, give Codex repeatable planning and verification workflows, and establish a practical local and GitHub quality gate without intended user-visible behavior changes.

## Context and evidence

- Product and operational context previously lived across `README.md`, `db/README.md`, the former root product-direction file, and UI reference notes; no root `AGENTS.md` existed.
- The repository had runtime syntax checks and tests, but no TypeScript compiler check, linter, formatter, EditorConfig, or CI workflow.
- The declared Node 22.6 minimum was lower than the runtime required by unflagged native TypeScript and `--env-file-if-exists`.
- PostgreSQL verification is intentionally opt-in and needs a dedicated empty database.

## Constraints

- Preserve intended user-visible application behavior and unrelated worktree changes. Defensive validation may reject malformed provider payload entries that were never valid inputs.
- Keep routine work inside the workspace sandbox. Network access stays disabled; necessary access outside the sandbox must use a narrowly scoped approval request, while credentials, destructive data work, deployment, commits, and pushes still require explicit user authorization.
- Do not add Git hooks, coverage thresholds, MCP servers, or scheduled tasks in this baseline.
- Do not call live OpenAI or Google services during verification.

## Implementation slices

1. **Durable context — Done**
   - Add root agent, planning, and review guidance.
   - Add repository-local planning and verification skills.
   - Add safe project-local Codex defaults without pinning a model.
2. **Quality command surface — Done**
   - Raise the real Node floor to the current patched Node 22 release, 22.23.4.
   - Add strict TypeScript checking for Node-native erasable syntax, pragmatic ESLint, Prettier, and EditorConfig.
   - Preserve the syntax check and add one `npm run verify` gate.
3. **GitHub CI — Done**
   - Run reproducible install and `npm run verify` on pull requests and pushes to `main` with read-only token permissions.
4. **Verification and handoff — Done**
   - Run all checks, validate TOML and skills, inspect the diff, and record exact results and skips.
   - Validate provider JSON at its trust boundary, deduplicate Gmail message IDs, and make the PostgreSQL test independent of a repository-local `data/` directory.

## Next improvements

1. Add an ephemeral PostgreSQL 16 CI job once the repository owner is ready to maintain the service-backed test separately from the fast gate.
2. Measure native Node test coverage over several changes, then adopt evidence-based thresholds instead of inventing a number.
3. Replace remaining broad `any` values at provider and database boundaries with validated response and client types.
4. Split the legacy browser bundle into modules, then remove its temporary ESLint compatibility overrides and include maintained UI files in formatting.
5. Add focused browser interaction tests for onboarding, navigation, Talk focus management, and narrow-phone layouts.
6. Before any deployment, add authentication, tenant isolation, row-level security, durable worker recovery, backup/restore drills, and deletion guarantees.
7. Revisit MCPs or scheduled maintenance only after a repeated manual workflow is proven and stable.

## Final verification

- Historical verification under the former non-escalating policy: `npm run verify` passed with 13 tests before that policy change. After review hardening, its direct local equivalents passed: syntax, Node-only strict type-checking, lint, formatting, and 15 passing tests.
- The PostgreSQL integration test was reported as skipped because no dedicated `TEST_DATABASE_URL` was supplied.
- Under the former `approval_policy = "never"`, the managed sandbox blocked the npm wrapper; no escalation was requested, and the already-installed local tools plus Node test runner were invoked directly.
- Both repository skills passed the installed skill validator.
- JSON, TOML, and GitHub Actions YAML configuration parsed successfully.

## Done when

- A new agent can orient from `AGENTS.md` without rediscovering the repository.
- `$twin-plan` produces repository-grounded Goal/Context/Constraints/Done plans without editing.
- `$twin-verify` reports exact passes, failures, skips, and residual risk.
- `npm run verify` passes locally and the GitHub workflow runs the same gate.
- No intended user-visible application behavior or existing user changes are altered; malformed provider entries are ignored safely.
