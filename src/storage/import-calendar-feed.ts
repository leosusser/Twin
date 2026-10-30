import { PostgresStore } from "./store.ts";
import { loadPrototypeCalendarConfig } from "../config/prototype-calendar.ts";
import { importSharedPrototypeCalendarForAllUsers } from "../services/prototype-calendar.ts";

const config = await loadPrototypeCalendarConfig();
if (!config) {
  console.error(
    "Prototype Calendar is disabled or config/prototype-calendar.local.json is missing.",
  );
  process.exitCode = 1;
} else {
  let store: PostgresStore | undefined;
  try {
    store = await new PostgresStore().init();
    const results = await importSharedPrototypeCalendarForAllUsers(store, config.sourceUrl);
    for (const result of results)
      console.log(
        result.status === "skipped_live"
          ? `Prototype Calendar skipped a user with live Google Calendar.`
          : `Prototype Calendar ${result.status}: ${result.event_count} events covering ${result.window_start} through ${result.window_end}.`,
      );
    console.log(`Prototype Calendar applied to ${results.length} user profile(s).`);
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : error instanceof Error
          ? error.message
          : "PROTOTYPE_CALENDAR_IMPORT_FAILED";
    console.error(`Prototype Calendar import failed: ${code}.`);
    process.exitCode = 1;
  } finally {
    await store?.close();
  }
}
