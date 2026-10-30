# Repository organization cleanup

Status: Done

Owner: Main coordinating agent

## Goal

Make the Twin project folder easier to understand by grouping product direction, visual references, onboarding references, and screenshots under `docs/`, while preserving every runtime path and adding a comprehensive root project map.

## Context and evidence

- Runtime code lives under `src/`, `public/`, `db/`, `config/`, and `data/`; these paths should not move.
- Product direction currently has an unclear root filename: `twin plan 2.md`.
- Visual references and onboarding references currently occupy two root folders.
- Development screenshots currently occupy the root `artifacts/` folder and are not runtime inputs.
- Repository guidance and several historical plans refer to the old names.

## Constraints

- Do not move or rename runtime code, PostgreSQL migrations, `.env`, private data, avatar assets, package files, tests, or configuration.
- Preserve all existing user changes and binary files exactly.
- Update every repository reference to a moved path.
- Run the full verification gate after moving. If a failure is caused by a move, restore the affected old path and report it rather than leaving a broken layout.
- Do not inspect or alter live PostgreSQL data.

## In scope

- Rename `twin plan 2.md` to `docs/product-direction.md`.
- Move `reference-ui/` to `docs/references/ui/`.
- Move `reference-onboarding/` to `docs/references/onboarding/`.
- Move `artifacts/` to `docs/screenshots/`.
- Remove disposable `.DS_Store` metadata from the repository workspace.
- Add `PROJECT_MAP.md` at the root and link it immediately near the beginning of `README.md`.
- Update instructions, ignore rules, and documentation references.

## Non-goals

- Moving application source or changing runtime behavior.
- Renaming files inside the reference packages.
- Reorganizing `data/`, changing PostgreSQL, or moving the whole repository out of Downloads.
- Changing product behavior or UI.

## Decisions and assumptions

- `docs/` is the single home for product documentation, implementation plans, references, and screenshots.
- Root operational files remain visible because tools expect their conventional names.
- The project map explains every maintained file individually and groups generated/private/reference collections where listing each asset would add noise.
- No delegation: the moves and reference edits are tightly coupled and must be verified as one atomic change.

## Discoveries

- Only repository guidance, three historical plans, and ESLint ignore rules directly reference the paths being moved.
- The reference packages are not runtime dependencies.
- Screenshot artifacts are not referenced by runtime code.

## Delegation map

- Decision: Keep work in the main thread because path moves and reference updates share one integration boundary and rollback must be coordinated.

## Implementation slices

1. **Create destination layout and move documentation assets — Done**
   - Owner: Main thread.
   - Dependencies: Inventory complete.
   - Write scope: `docs/`, old reference/artifact paths, root product-direction file.
   - Change: Perform exact path moves without modifying file contents.
   - Data or interface impact: Documentation paths only.
   - Verification: Compare file counts and search for stale old paths.

2. **Update references and add project map — Done**
   - Owner: Main thread.
   - Dependencies: Slice 1.
   - Write scope: `AGENTS.md`, `README.md`, `eslint.config.js`, affected plans, `PROJECT_MAP.md`.
   - Change: Update all moved-path references and document repository structure and information flow.
   - Data or interface impact: Documentation/tooling paths only.
   - Verification: Search for stale references and validate Markdown/formatting.

3. **Verify and recover if necessary — Done**
   - Owner: Main thread.
   - Dependencies: Slices 1–2.
   - Write scope: Narrow repairs or restoration of affected paths only.
   - Change: Run focused path checks and `npm run verify`; restore any moved path that causes a product failure.
   - Data or interface impact: None expected.
   - Verification: Full repository gate and file inventory.

## Final verification

- Confirm old paths no longer exist and every destination file exists.
- Search the repository for stale moved-path references.
- `npm run verify`
- Confirm private/runtime paths are unchanged.

## Verification results

- Exact destination check passed: all four old paths are absent and all four new destinations exist.
- File counts remained intact: 14 UI-reference files, 5 onboarding-reference files, and 13 screenshots.
- Repository-wide search found no operational stale-path references; old names remain only where the cleanup history is intentionally documented.
- Markdown and configuration formatting passed after adding the moved documentation paths to `.prettierignore`; the long product-direction reference was not mechanically rewritten.
- `npm run verify` passed syntax, typecheck, lint, formatting, and 77 runnable tests. The opt-in PostgreSQL integration test was skipped because no confirmed disposable `TEST_DATABASE_URL` was provided.
- Five ignored `.DS_Store` metadata files were removed after exact path confirmation. macOS may recreate them automatically; they contained no application data.

## Progress

- 2026-10-27: Inventoried root folders, all files being moved, and every known textual reference.
- 2026-10-27: Moved product direction, UI/onboarding references, and screenshots under `docs/`; updated all operational references; added `PROJECT_MAP.md`; removed disposable macOS metadata; and completed the full verification gate without a move-caused failure.

## Risks and recovery

- Risk: Tooling or guidance continues to point at an old path.
  - Safeguard: repository-wide search before and after moves.
- Risk: A reference package contains an unexpected runtime dependency.
  - Safeguard: full verification; restore that package to its original path if a move-caused failure occurs.
- Recovery: Move only the failing destination back to its original path, revert its reference edits, rerun verification, and report the exact failure.

## Done when

- Root project files are concise and runtime paths are unchanged.
- Product direction, references, and screenshots are grouped under `docs/`.
- `PROJECT_MAP.md` explains maintained files and the full information flow with arrow diagrams.
- No stale old-path references remain.
- Verification passes, or every move-caused failure has been restored and reported.
