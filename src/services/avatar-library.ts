import { createHash } from "node:crypto";
import type { ActivityKey, AppState, AvatarAsset, AvatarDesign } from "../domain/types.ts";

/** The outfit text for one activity; "" means Twin picks a fitting default. */
export function activityOutfit(design: AvatarDesign, key: ActivityKey | undefined) {
  return key ? (design.outfits?.[key] ?? "").trim() : "";
}

/** Short stable tag for an outfit, used in idempotency keys. */
export function outfitTag(outfit: string) {
  return createHash("sha1").update(outfit).digest("hex").slice(0, 12);
}

/**
 * A saved activity image with the same face (approved baseline), activity, and outfit.
 * Design version is deliberately ignored: palette edits and switching back to an earlier
 * baseline should reuse images instead of paying for them again.
 */
export function libraryScene(
  state: AppState,
  userId: string,
  baselineId: string,
  key: ActivityKey,
  outfit: string,
): AvatarAsset | undefined {
  return state.avatar_assets
    .filter(
      (item) =>
        item.user_id === userId &&
        item.kind === "activity" &&
        item.activity_key === key &&
        item.status === "ready" &&
        item.storage_key &&
        item.parent_asset_ids[0] === baselineId &&
        (item.outfit ?? "").trim() === outfit,
    )
    .sort(
      (a, b) =>
        Number(Boolean(b.selected_at)) - Number(Boolean(a.selected_at)) ||
        String(b.selected_at ?? "").localeCompare(String(a.selected_at ?? "")) ||
        b.created_at.localeCompare(a.created_at),
    )[0];
}
