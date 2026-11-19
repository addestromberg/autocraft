import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { allocation } from "../src/agents/call.ts";
import { codexFailure } from "../src/agents/codex/errors.ts";
import { takeCodexSlot } from "../src/agents/codex/queue.ts";
import { connect } from "../src/db.ts";
import { SCRATCH } from "./scratch.ts";

test("Codex calls share a slot across database connections and remove cancelled waiters", async () => {
  const path = join(SCRATCH, "codex-queue.db");
  const first = connect(path);
  const second = connect(path);
  const poll = allocation.pollMs;
  allocation.pollMs = 10;
  try {
    const endFirst = await takeCodexSlot(first, "classify.haiku", new AbortController());
    try {
      const waiting = new AbortController();
      const messages: string[] = [];
      const cancelled = takeCodexSlot(second, "classify.haiku", waiting, { onProgress: (line) => messages.push(line) });
      assert.deepEqual(messages, ["Waiting for the Codex account"]);
      waiting.abort();
      await assert.rejects(cancelled, /cancelled while waiting/);
      await assert.rejects(
        takeCodexSlot(second, "classify.haiku", new AbortController(), { maxWaitMs: 0 }),
        /no Codex account slot/,
      );
      assert.equal(second.prepare("SELECT COUNT(*) AS n FROM model_waits").get()?.n, 0);
    } finally {
      endFirst();
    }

    const endSecond = await takeCodexSlot(second, "classify.haiku", new AbortController());
    endSecond();
    assert.equal(first.prepare("SELECT value FROM settings WHERE key = 'codex_model_slot'").get(), undefined);
  } finally {
    allocation.pollMs = poll;
    second.close();
    first.close();
  }
});

test("Codex failure messages identify sign-in and quota without returning runtime details", () => {
  assert.match(codexFailure({ code: "usage_limit_reached", detail: "private string" }) ?? "", /quota/);
  assert.match(codexFailure({ code: "token_expired" }) ?? "", /Reconnect Codex/);
  assert.equal(codexFailure({ detail: "private string" }), undefined);
});
