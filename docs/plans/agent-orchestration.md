# Project agent orchestration

Status: Done

Owner: Main coordinating agent

## Goal

Make the main Codex thread act as the project head: decide when delegation will improve speed or quality, assign bounded work to specialized subagents, integrate their reports and edits, and complete one evidence-based verification pass.

## Context and evidence

- `.codex/config.toml` already enables subagents and caps the session at three concurrent subagent threads, excluding the main thread.
- `AGENTS.md` now defines the delegation decision, parallel-write ownership, integration, and reporting protocol.
- `PLANS.md`, `code_review.md`, `$twin-plan`, and `$twin-verify` now share one orchestration contract.
- Project-scoped explorer, builder, and reviewer agents now exist under `.codex/agents/`.
- The supplied Codex Subagents guide recommends keeping the main context focused, delegating independent work, preferring parallel read-heavy work, and avoiding overlapping parallel edits.

## Constraints

- `AGENTS.md` remains canonical for product, trust, safety, and authorization boundaries.
- The main thread owns the goal, user decisions, plan, task boundaries, integration, final review, and handoff.
- Use delegation only when the expected speed, evidence, or quality gain exceeds coordination overhead; small or tightly coupled work remains single-agent.
- Parallel builders must receive explicit, non-overlapping path ownership. If ownership cannot be separated safely, use one writer.
- Subagents inherit the parent session's permissions. Custom agent instructions may narrow behavior but cannot expand access.
- Preserve the three-subagent concurrency cap. Do not pin models, add MCP servers, hooks, schedules, or infrastructure.
- Preserve unrelated and pre-existing worktree changes.

## In scope

- Define project-scoped explorer, builder, and reviewer agents in `.codex/agents/`.
- Add a shared delegation, ownership, reporting, integration, and verification protocol to the repository guidance.
- Add delegation mapping to complex plans and integration review to code review and verification.
- Validate TOML structure, required custom-agent fields, guidance consistency, and referenced paths.

## Non-goals

- Changing application behavior, database state, provider integrations, or UI.
- Creating an extra head subagent; the main thread is the coordinating head.
- Forcing subagents onto every task or allowing overlapping edits for the sake of parallelism.
- Granting broader filesystem, network, credential, deployment, commit, or push authority.

## Decisions and assumptions

- User selected **split ownership**: parallel implementation is allowed only for non-overlapping files or directories.
- Use `.codex/agents/*.toml`, as specified by the supplied current Codex guide, rather than Cursor-specific `.cursor/agents/*.md` files.
- Leave model and reasoning fields unset so custom agents inherit the parent session unless a future measured workflow justifies specialization.
- Use three reusable roles: `twin_explorer` for read-only evidence, `twin_builder` for an assigned implementation slice, and `twin_reviewer` for read-only review and verification evidence.
- A role may be spawned more than once when each thread has an independent assignment and the concurrency cap allows it.

## Discoveries

- `approval_policy` is now `on-request` with `workspace-write`, so routine repository work stays uninterrupted and necessary out-of-sandbox reads can request narrowly scoped user approval.
- The current session successfully read the supplied external guide after a read-only approval, confirming the intended approval behavior.

## Delegation map

- **Main coordinating agent:** frames Goal/Context/Constraints/Done, decides whether to delegate, assigns exact ownership and dependencies, resolves conflicting findings, integrates changes, and owns the final answer.
- **`twin_explorer`:** independently maps relevant code, tests, contracts, and trust boundaries; never edits.
- **`twin_builder`:** implements one assigned vertical slice inside named paths, preserves unrelated changes, runs focused checks, and returns changed paths plus evidence.
- **`twin_reviewer`:** reviews the combined result against `code_review.md`, runs or inspects proportional verification, and reports prioritized findings; never edits.

## Implementation slices

1. **Codify the orchestration contract — Done**
   - Change: update `AGENTS.md` and `PLANS.md` with the delegation decision, main-thread ownership, non-overlapping writer rule, subagent brief, result contract, and integration sequence.
   - Data or interface impact: repository workflow guidance only.
   - Verification: inspect guidance for one canonical, non-contradictory protocol and confirm every referenced file exists.
2. **Create project custom agents — Done**
   - Change: add explorer, builder, and reviewer TOML definitions under `.codex/agents/` with narrow descriptions and Personal Twin constraints.
   - Data or interface impact: Codex agent discovery only; no product runtime change.
   - Verification: structurally validate TOML, confirm required `name`, `description`, and `developer_instructions` fields, and confirm names are unique.
3. **Align planning, review, and verification — Done**
   - Change: update `code_review.md`, `$twin-plan`, and `$twin-verify` so planning assigns ownership, reviewers inspect the combined result, and only the main thread issues the final verification report.
   - Data or interface impact: repository workflow guidance only.
   - Verification: search for contradictory orchestration rules and validate both skills' frontmatter and referenced paths.
4. **Integrated verification and handoff — Done**
   - Change: review the complete workflow as one system, record observed checks, and update this plan to Done.
   - Data or interface impact: none.
   - Verification: perform the documentation/configuration checks required by `$twin-verify`; use a fresh session later to confirm custom-agent discovery because the current session cannot reload project configuration.

## Final verification

- Structurally validate `.codex/config.toml` and every `.codex/agents/*.toml` file in this session.
- Confirm all custom agents have unique names and required fields.
- Confirm `AGENTS.md`, `PLANS.md`, `code_review.md`, `$twin-plan`, and `$twin-verify` agree on delegation, write ownership, integration, approvals, and final responsibility.
- Confirm every referenced repository path exists.
- In a fresh Codex session, exercise Codex's real TOML parsing, confirm the three project agents are discovered, and run one read-only delegation smoke test.

## Verification results

- A local structural TOML check passed for `.codex/config.toml` and all three custom-agent files; required fields were present and the names `twin_explorer`, `twin_builder`, and `twin_reviewer` were unique.
- Both Twin skills passed a local frontmatter, name, description, and placeholder check. The bundled `quick_validate.py` could not run because the available Python environment lacks PyYAML; no dependency was installed solely for validation.
- The repository-local Prettier command passed for `AGENTS.md`, `PLANS.md`, `code_review.md`, `docs/**/*.md`, and `.agents/**/*.md`.
- Referenced repository paths exist, and a consistency search found no active instruction that still requires `approval_policy = "never"`; the remaining occurrence is explicitly historical.
- An independent read-only review found one stale-plan issue and two role-wording inconsistencies. The plan status, root-only delegation rule, builder trigger, and reviewer trigger were corrected, then the relevant static checks were rerun.
- `git status --short` succeeded with approval and showed that these workflow files are untracked among substantial pre-existing user changes. There was no tracked baseline diff for them, so review used their complete contents and did not modify unrelated files.
- Fresh-session Codex parsing, discovery, and a delegated-role smoke test remain unobserved because the current session cannot reload newly added custom-agent definitions. This is the only remaining workflow-specific verification item.

## Progress

- 2026-10-26: plan created after reading the supplied Codex Subagents guide and recording the user's split-ownership decision.
- 2026-10-26: added the shared orchestration contract and three project agents, aligned both Twin skills and code review, completed static validation, and reconciled an independent review.

## Risks and recovery

- Risk: parallel agents edit overlapping files or integrate incompatible assumptions.
- Safeguard or rollback: the main thread must assign disjoint ownership, serialize shared-file work, review the combined diff, and reject or repair conflicting changes.
- Risk: custom-agent files are structurally valid but have not been parsed or discovered by Codex in a fresh session.
- Safeguard or rollback: validate statically now and require a fresh-session discovery smoke test before claiming runtime discovery.
- Risk: delegation overhead makes small tasks slower.
- Safeguard or rollback: use the delegation threshold and keep small, sequential, or tightly coupled tasks in the main thread.

## Done when

- The main thread explicitly decides whether delegation is useful before non-trivial work.
- Delegated tasks have bounded goals, exact ownership, dependencies, constraints, done criteria, and a concise result contract.
- Parallel builders never share write ownership, and the main thread integrates and verifies their combined work.
- Explorer, builder, and reviewer agents are defined in project-scoped Codex TOML files without broader permissions.
- Planning, review, and verification guidance use one consistent orchestration model.
- Static checks pass, and fresh-session Codex parsing and discovery are either observed or reported as the only remaining verification item.
