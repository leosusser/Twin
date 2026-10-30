# Organized adaptive memory

Status: Not started

Owner: Main coordinating agent

## Goal

Make Personal Twin memory easy to understand, inspect, edit, export, and retrieve without confusing raw history, current beliefs, recent lived experience, Calendar commitments, or generated schedules.

## Context and evidence

- PostgreSQL is the sole active record store. Personal text is not currently organized as editable files, and the application no longer reads or writes `data/twin.json`.
- `twin.facts` is the closest current equivalent to a “who I am” profile: normalized statements with kind, provenance, status, authority, certainty, and version.
- `twin.observations` and `twin.imports` preserve onboarding evidence and import provenance. `twin.memory_overrides` preserves direct edits and removal tombstones.
- `twin.conversations` and `twin.messages` preserve Talk history according to the configured retention period. `twin.activity_reports` separately records what the person says actually happened.
- `twin.calendar_events` contains real commitments. `twin.twin_days` contains derived, immutable schedule versions. Neither should be merged into identity memory.
- Planning context is computed in `src/storage/context.ts`; it is not currently a durable, human-readable “planning context file.” Selection is capped at 32 facts, 40 target-day Calendar events, 10 messages from the triggering conversation, 12 overrides, and 12 activity reports.
- Talk context is narrower: up to 8 relevant active facts, 6 recent messages in the current conversation, 5 reports from the prior 7 days, and 8 nearby Calendar events.
- These limits bound model input; they do not delete the remaining PostgreSQL records.

## Constraints

- Preserve PostgreSQL as the sole record store. Human-readable exports may be generated, but editable application truth must not be split across ad hoc local files.
- Preserve owner scoping, direct-user-edit precedence, removal tombstones, import provenance, and atomic writes.
- Keep imported/model text untrusted and distinguish user-stated facts from inference.
- Keep identity/profile facts, actual-activity reports, Calendar commitments, conversation history, and imagined Twin schedules semantically separate.
- Never rewrite immutable historical Twin-day versions when memory changes.
- Preserve complete source history according to explicit retention policy; context selection must be relevance- and budget-based rather than silently treating a small fixed count as the total memory.
- Do not inspect, migrate, delete, seed, or export live user data without separate authorization and a confirmed backup/recovery path.

## In scope

- Define one documented memory architecture with clear source-of-truth and derived layers.
- Expand memory categorization and temporal metadata.
- Create a categorized Memory/Profile API and Settings view.
- Add full, portable, human-readable memory export.
- Add recent-reality memory for the last three local days.
- Add durable conversation summaries while retaining full transcripts according to policy.
- Replace fixed fact/message counts with token-budgeted, category-aware, date-aware retrieval.
- Let the background agent derive an editable planning profile from onboarding evidence and later corrections without treating model inference as user truth.
- Reorganize memory code into focused domain, repository, retrieval, and API modules.

## Non-goals

- Moving PostgreSQL data into hand-edited Markdown or JSON files.
- Treating Calendar events, Gmail cues, inferred feelings, or generated schedules as confirmed identity facts.
- Deleting old conversations or schedules as part of the reorganization.
- Adding hosting, multi-user production infrastructure, vector databases, or an unbounded model prompt.
- Rewriting current-day displayed Twin history from new evidence.

## Decisions and assumptions

- Use five logical layers:
  1. **Evidence archive:** imports, observations, complete retained messages, and reports.
  2. **Canonical profile:** current editable facts about the person.
  3. **Recent reality:** the last three local days of reported actual activity and observed deviations.
  4. **Working context:** a generated, bounded snapshot for Talk or a specific planning run.
  5. **Derived history:** immutable Twin days and their cited source IDs.
- Organize canonical profile items by `category`, `subcategory`, `time_horizon`, `importance`, `stability`, `effective_from`, `effective_until`, `last_confirmed_at`, `authority`, `certainty`, and source references.
- Initial top-level categories: identity, routines, commitments, sleep, school/work, deadlines, habits, preferences, energy, feelings/wellbeing, relationships, places/logistics, goals, distractions, and boundaries. Categories are organizational metadata, not diagnostic labels.
- Store full retained conversations, plus source-linked summaries. Retrieval uses summaries and relevant excerpts; export includes both.
- A context snapshot may be persisted for audit/reproducibility, but it is derived and rebuildable. It never becomes the canonical profile merely because a model wrote it.
- Past Calendar and schedule history should be separated by tables/partitions or export sections, not a second unmanaged SQL file. PostgreSQL remains authoritative.
- The background-agent rules and selection policy must be editable through a versioned server-side configuration surface; browser code must not contain provider instructions or credentials.

## Discoveries

- Current fact kinds are eight hard-coded onboarding categories and do not cleanly express people, places, preferences, deadlines, academic terms, or time horizons.
- Talk retrieval is lexical and narrow, with no durable conversation summary.
- Ordinary Talk currently preserves messages and reports but does not promote a general stream of categorized identity facts.
- Generic JSONB record tables make early iteration simple but make category queries, audits, and targeted retrieval harder.
- Removal tombstones already provide the correct foundation for ensuring that re-import and background inference cannot restore a fact the user removed.

## Delegation map

- Decision: One read-only explorer was useful because storage and retrieval are independent evidence paths; implementation remains unassigned until the user approves this plan.
- `twin_explorer` / memory map: read `db/README.md`, storage, context, domain types, imports, API, planning service, and README; no writes; report tables, source/derived boundaries, selection limits, pain points, and recommendations. Completed and reconciled into this plan.
- Future builders: assign only after schema and API contracts are approved. Migrations/compatibility, retrieval, and UI may be separate non-overlapping slices; shared types and contracts must be serialized through the main thread.

## Implementation slices

1. **Memory contract and taxonomy — Not started**
   - Owner: Main thread.
   - Dependencies: User approval of the architecture and category vocabulary.
   - Write scope: `src/domain/types.ts`, new focused memory-domain module, API contract documentation, tests.
   - Change: Define evidence, canonical profile, recent reality, context snapshot, and derived-history types. Add temporal and organizational metadata with explicit authority/certainty rules.
   - Data or interface impact: Additive contract first; no live data mutation.
   - Verification: Type tests and fixtures prove every item has an owner, layer, category, source, authority, certainty, and time horizon.

2. **PostgreSQL migration and compatibility — Not started**
   - Owner: Future `twin_builder`, exclusive ownership of migration and storage compatibility paths.
   - Dependencies: Slice 1 contract.
   - Write scope: `db/migrations/`, `src/storage/`, PostgreSQL integration tests.
   - Change: Add queryable memory metadata and optional context-summary/snapshot records. Backfill existing facts without changing IDs, statements, versions, provenance, overrides, or user ownership.
   - Data or interface impact: Forward-only additive migration with compatibility reads during transition.
   - Verification: Run against a confirmed disposable `TEST_DATABASE_URL`; prove backfill equivalence, tombstone preservation, rollback on failure, repeat migration safety, and export parity.

3. **Canonical Memory/Profile service — Not started**
   - Owner: Main thread or one builder after storage contract is stable.
   - Dependencies: Slices 1–2.
   - Write scope: focused memory service/repository modules and memory API routes.
   - Change: Provide grouped list/search/detail/edit/remove/conflict operations with source links and optimistic versioning. Centralize precedence and deduplication currently split across imports and routes.
   - Data or interface impact: New versioned DTO; existing fact routes remain compatible until the UI migrates.
   - Verification: Tests cover direct edit precedence, re-import after removal, tentative inference, conflicting evidence, owner isolation, and stale-version conflicts.

4. **Recent reality for the last three days — Not started**
   - Owner: Main thread.
   - Dependencies: Canonical service and owner-local date utilities.
   - Write scope: activity-report reconciliation and context modules.
   - Change: Build a distinct three-local-day view from activity reports. Compare reported reality with prior plans, propose patterns conservatively, and promote only stable, source-linked patterns under explicit rules.
   - Data or interface impact: Reports remain immutable evidence; learned profile items cite report IDs and remain editable/removable.
   - Verification: DST/local-date tests, corrections, repeated versus one-off deviations, no retroactive Twin-day mutation, and tombstone precedence.

5. **Conversation archive and summaries — Not started**
   - Owner: Future builder with exclusive conversation-summary paths.
   - Dependencies: Memory contract.
   - Write scope: conversation summary storage/service and worker integration.
   - Change: Retain complete conversations according to policy, generate source-linked per-conversation summaries and rolling profile cues, and refresh summaries idempotently after completed turns.
   - Data or interface impact: Summary is derived; message rows remain authoritative. Retention/deletion must also remove or invalidate dependent summaries without resurrecting deleted content.
   - Verification: Full transcript round-trip, idempotent summarization, deletion/retention handling, provider failure/retry, and no cross-conversation or cross-user leakage.

6. **Token-budgeted retrieval — Not started**
   - Owner: Future builder with exclusive context-selection paths.
   - Dependencies: Slices 1, 3, 4, and 5.
   - Write scope: split `src/storage/context.ts` into Talk and planning selectors plus shared budget/ranking utilities.
   - Change: Replace fixed “top N equals memory” behavior with a configurable token budget. Guarantee coverage for critical categories and relevant time horizons, prioritize target-date deadlines/commitments, use summaries plus excerpts, and report truncation explicitly.
   - Data or interface impact: Provider input changes; stored source records do not.
   - Verification: Deterministic ranking, long-profile coverage, midterm/deadline relevance, far-future facts, category diversity, prompt-injection resistance, and exact budget tests.

7. **Editable background-memory policy — Not started**
   - Owner: Main thread; serialize shared config/API edits.
   - Dependencies: Retrieval contract.
   - Write scope: server-side settings/config, validation, safe Settings API/UI.
   - Change: Expose editable rules for what the background agent may summarize, infer, promote, retain, and include in planning. Keep protected trust rules non-editable.
   - Data or interface impact: Versioned policy with safe defaults and audit metadata; no arbitrary executable prompt or browser-to-provider instructions.
   - Verification: Validation, defaults, forbidden trust-boundary overrides, optimistic concurrency, and policy-version citation in generated context snapshots.

8. **Memory Center and portable export — Not started**
   - Owner: Future UI builder after API stability.
   - Dependencies: Slices 3–7.
   - Write scope: Settings Memory Center UI and export formatting.
   - Change: Show categories, current profile, sources, tentative/conflicting items, recent reality, conversation summaries, and what was included in the latest planning context. Export one organized package with a manifest and separate JSON sections for profile, evidence, recent reality, conversations, Calendar, and derived schedules.
   - Data or interface impact: Read/export plus existing edit/remove mutations; no direct database-file editing.
   - Verification: Desktop/mobile/keyboard review, empty/large/conflict states, round-trip export validation, secret redaction, and exact category counts.

9. **Cutover and cleanup — Not started**
   - Owner: Main coordinating thread.
   - Dependencies: All prior slices.
   - Write scope: integration, documentation, removal of superseded compatibility code only after parity.
   - Change: Switch Talk/planning to the new selectors, retain compatibility endpoints for one transition, document backup/restore and memory layers, then remove duplicated logic.
   - Data or interface impact: No destructive cleanup until export and migration parity are proven.
   - Verification: Full repository gate, disposable PostgreSQL suite, import → profile → Talk/report → next plan flow, account export/delete, and recovery drill.

## Final verification

- `npm run typecheck`
- `npm run lint`
- `npm run format:check`
- `npm test`
- `npm run test:postgres` only with a confirmed disposable empty `TEST_DATABASE_URL`
- `npm run verify`
- Manual Settings Memory Center review at desktop and narrow-phone widths.
- Export inspection confirming no API keys, refresh tokens, encrypted credential blobs, private asset paths, or unrelated users.
- End-to-end owner-scoped flow: onboarding import → categorized canonical profile → edit/remove → repeat import → Talk report → three-day recent reality → future planning context → immutable schedule history.

## Verification results

- Pending; this is a plan-only task and no implementation or live-data operation was performed.

## Progress

- 2026-10-27: Mapped current PostgreSQL tables, domain records, edit/delete precedence, Talk/planning selection, transcript retention, export boundary, and source-versus-derived data.
- 2026-10-27: Created the plan and stopped before implementation as requested.

## Risks and recovery

- Risk: A migration could lose provenance or weaken removal precedence.
  - Safeguard: additive migration, stable IDs, parity export, tombstone-specific tests, and disposable-database rehearsal before any authorized live migration.
- Risk: Larger context could become costly, noisy, or less accurate.
  - Safeguard: retain everything in storage but send a deterministic token-budgeted selection with explicit truncation and source citations.
- Risk: Model summaries could be mistaken for user truth.
  - Safeguard: summaries remain derived; only validated source-linked items enter the canonical profile with visible authority and certainty.
- Risk: Conversation retention and derived summaries could diverge.
  - Safeguard: summaries track source message IDs and are invalidated when source messages expire or are deleted.
- Recovery: Keep existing tables/routes/selectors operational during transition; cut over only after parity tests and a private export/backup are confirmed.

## Done when

- The user can open one Memory Center and understand what Twin knows, why it knows it, how certain it is, when it applies, and whether it influenced planning.
- Full retained evidence remains available according to policy without being confused with the smaller model context.
- Memory is grouped into useful categories and time horizons, including academic deadlines and long-range commitments.
- The last three local days of reported reality are separately visible and can inform conservative future learning.
- Full retained conversations and their summaries are exportable, searchable, and governed by explicit retention.
- Talk and planning use configurable token budgets with category/date coverage rather than small fixed record counts.
- Direct edits/removals always outrank imports and inference; removal tombstones survive repeat imports and background runs.
- Calendar, Gmail, actual reports, identity facts, and imagined schedules remain visibly and structurally distinct.
- A portable organized export is easy to inspect and contains no credentials or private filesystem paths.
