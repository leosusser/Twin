import assert from "node:assert/strict";
import test from "node:test";
import type { IntegrationConnection } from "../src/domain/types.ts";
import { syncGmail } from "../src/integrations/google.ts";
import { encryptSecret } from "../src/integrations/secrets.ts";

test("Gmail full sync ignores malformed IDs and fetches each valid message once", async () => {
  const previousKey = process.env.TWIN_ENCRYPTION_KEY;
  const previousFetch = globalThis.fetch;
  const fetchedMessageIds: string[] = [];

  try {
    process.env.TWIN_ENCRYPTION_KEY = "test-only-encryption-key-not-a-real-secret";
    const connection: IntegrationConnection = {
      id: "gmail-test",
      user_id: "user-test",
      provider: "gmail",
      mode: "live",
      status: "connected",
      scopes: ["gmail.metadata"],
      encrypted_token: encryptSecret("refresh-token"),
    };

    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "oauth2.googleapis.com") {
        return Response.json({ access_token: "access-token" });
      }
      if (url.pathname.endsWith("/messages")) {
        return Response.json({
          messages: [{ id: "dup" }, { id: "dup" }, {}, { id: 42 }, null],
        });
      }
      const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
      fetchedMessageIds.push(id);
      return Response.json({
        historyId: "next-history",
        internalDate: "1710000000000",
        payload: { headers: [{ name: "Subject", value: "Meeting changed" }] },
      });
    };

    const result = await syncGmail(connection, "user-test");
    assert.deepEqual(fetchedMessageIds, ["dup"]);
    assert.equal(result.cues.length, 1);
    assert.equal(result.cues[0].source_message_id, "dup");
    assert.equal(result.cursor, "next-history");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.TWIN_ENCRYPTION_KEY;
    else process.env.TWIN_ENCRYPTION_KEY = previousKey;
  }
});

test("Gmail history sync validates nested IDs with the same deduplication", async () => {
  const previousKey = process.env.TWIN_ENCRYPTION_KEY;
  const previousFetch = globalThis.fetch;
  const fetchedMessageIds: string[] = [];

  try {
    process.env.TWIN_ENCRYPTION_KEY = "test-only-encryption-key-not-a-real-secret";
    const connection: IntegrationConnection = {
      id: "gmail-history-test",
      user_id: "user-test",
      provider: "gmail",
      mode: "live",
      status: "connected",
      scopes: ["gmail.metadata"],
      encrypted_token: encryptSecret("refresh-token"),
      cursor: "start-history",
    };

    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "oauth2.googleapis.com") {
        return Response.json({ access_token: "access-token" });
      }
      if (url.pathname.endsWith("/history")) {
        return Response.json({
          historyId: "next-history",
          history: [
            {
              messagesAdded: [
                { message: { id: "nested" } },
                { message: { id: "nested" } },
                { message: {} },
                {},
              ],
            },
            { messagesAdded: "invalid" },
          ],
        });
      }
      const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
      fetchedMessageIds.push(id);
      return Response.json({
        historyId: "detail-history",
        internalDate: "1710000000000",
        payload: { headers: [{ name: "Subject", value: "Class schedule" }] },
      });
    };

    const result = await syncGmail(connection, "user-test");
    assert.deepEqual(fetchedMessageIds, ["nested"]);
    assert.equal(result.cues.length, 1);
    assert.equal(result.cues[0].source_message_id, "nested");
    assert.equal(result.cursor, "detail-history");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.TWIN_ENCRYPTION_KEY;
    else process.env.TWIN_ENCRYPTION_KEY = previousKey;
  }
});
