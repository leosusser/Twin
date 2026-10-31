# Avatar outfits and library reuse

Status: built on branch `ui-redesign`. Not merged into main.

## Goal, context, constraints, done

- **Goal:** spend less on avatar images. Every activity has one outfit, so all runs look the same and all study sessions look the same, and Leo can describe each activity's outfit in a small text box. Before generating, Twin always looks in the library for an image with the same face, activity and outfit, and reuses it.
- **Context:**
  - Home calls `POST /api/character/scenes/ensure` for the current activity. That is the only automatic generation path, and it is already lazy.
  - The library lookup in `ensure`, `resolveScene()` and the worker's automatic-scene check required `design_version === design.version`.
  - Every baseline approval and every palette edit bumps the design version (Leo is on v32). So each bump orphaned every saved activity image, and the next visit paid for it again.
  - There is no outfit field today.
- **Constraints:**
  - Keep the image model, quality and face handling as they are. Leo said the face part is fine and declined the more expensive model.
  - No migration is needed, because records are JSONB payloads.
  - Keep user scoping, idempotency and cancellation.
  - Talk-requested variants are unchanged.
- **Done when:**
  - a saved activity image is reused whenever its baseline and outfit match, even after the design version changed;
  - a changed outfit generates a new image only when that activity is next shown, and switching back to an old outfit reuses the old image;
  - outfits are editable in Settings and saving them does not bump the design version;
  - the prompt uses the outfit text;
  - `npm run verify` passes, with regression tests for all of the above.

## Design

- **Data (no migration):**
  - `AvatarDesign.outfits?: Partial<Record<ActivityKey, string>>` sits on the active design. It is edited in place and carried forward by the existing `...current` spread when a new version is made.
  - `AvatarAsset.outfit?: string` records the outfit text the image was made with. Legacy images count as `""`, the default outfit.
  - `AvatarGenerationRequest.requested_outfit?: string`.
- **Library key:** owner + `kind: "activity"` + `activity_key` + identity (`parent_asset_ids[0]`, the approved baseline asset id) + `outfit`.
  - A new baseline (a new face) still generates new images.
  - A palette edit, or switching back to an earlier baseline, reuses the matching images.
  - The `selected_at` match is preferred, then the newest.
  - Shared helper: `src/services/avatar-library.ts` (`activityOutfit`, `libraryScene`), used by the router (`ensure`, `resolveScene`, regenerate) and the worker (automatic hit check).
- **Idempotency:** the automatic key becomes `auto:<baselineId>:<activity>:<sha1(outfit) prefix>`, so an outfit change is a new request and an unchanged one dedupes.
- **Worker:**
  - The prompt adds the outfit for activity images.
  - A previous-activity reference image is only sent when it has the same outfit, so an old outfit can't leak in.
  - Deselection on save covers the user's images for that activity.
- **API:** `PUT /api/character/outfits` with `{ outfits: { <activity_key>: string } }`.
  - Only known activity keys are accepted.
  - Values are trimmed, control characters are stripped, and each is capped at 160 characters.
  - An empty value means the default.
  - Returns `characterRead`.
- **UI:**
  - Settings › Avatar gets an "Outfits" card with one labeled text field per activity and a Save button. The placeholder reads "Twin picks".
  - Activity library cards show the outfit each image was made with.

## Verification

- `test/router.test.ts`:
  - reuse across design versions;
  - a new outfit queues a request with `requested_outfit`;
  - switching back reuses the old image;
  - the outfits route validates input and keeps the version.
- `test/domain.test.ts` or the worker tests: the prompt includes the outfit.
- `npm run verify`, plus a manual check in Settings (no image generation triggered).
