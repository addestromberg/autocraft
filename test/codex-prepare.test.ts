import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setCallContext } from "../src/agents/call.ts";
import { prepare } from "../src/decide/prepare.ts";
import { ask } from "../src/decisions.ts";
import { SCRATCH } from "./scratch.ts";
import { world } from "./world-db.ts";

test("Codex prepares a decision from scoped checkout data and refuses a stale PR head", async () => {
  const checkout = join(SCRATCH, "checkout");
  mkdirSync(checkout);
  writeFileSync(join(checkout, "status.txt"), "Status is a read-only view");
  const cli = join(SCRATCH, "codex-prepare");
  const code = [
    "#!/usr/bin/node",
    'const { createInterface } = require("node:readline");',
    'if (process.argv.slice(-2).join(" ") === "login status") process.exit(0);',
    'const reply = (message) => console.log(JSON.stringify(message));',
    'const threadId = "thread", turnId = "turn";',
    'createInterface({input: process.stdin}).on("line", (line) => {',
    '  const message = JSON.parse(line);',
    '  if (message.method === "initialize") reply({id: message.id, result: {}});',
    '  if (message.method === "thread/start") reply({id: message.id, result: {thread: {id: threadId}}});',
    '  if (message.method === "turn/start") {',
    '    reply({id: message.id, result: {turn: {id: turnId}}});',
    '    reply({id: 99, method: "item/tool/call", params: {threadId, turnId, tool: "read_checkout_file", arguments: {path: "/repo/status.txt"}}});',
    '  }',
    '  if (message.id === 99) {',
    '    if (!message.result.success || !message.result.contentItems[0].text.includes("Status is a read-only view")) process.exit(1);',
    "    const text = " + JSON.stringify([
      "The checkout says the status pane is read-only. The operator should decide whether to proceed.", "",
      "```choices", JSON.stringify({ pick: { core: null, reason: null }, cores: [] }), "```",
    ].join("\n")) + ";",
    '    reply({method: "item/completed", params: {threadId, turnId, item: {type: "agentMessage", text}}});',
    '    reply({method: "turn/completed", params: {threadId, turn: {id: turnId, status: "completed"}}});',
    '  }',
    '});',
  ].join("\n");
  writeFileSync(cli, code, { mode: 0o700 });
  process.env.AUTOCRAFT_CODEX_HOME = join(SCRATCH, "codex-home");
  process.env.AUTOCRAFT_CODEX_BIN = cli;
  process.env.AUTOCRAFT_SNAPSHOT_DIR = join(SCRATCH, "empty-snapshot");
  const w = world().repo().issue(1).pr(7);
  const head = String(w.db.prepare("SELECT head_oid FROM items WHERE number = 7").get()?.head_oid);
  const scope = "app#1:scope";
  const merge = `app#7:merge@${head}`;
  ask(w.db, [
    { id: scope, kind: "scope", repo: "app", number: 1, question: "In scope?", options: [{ key: "take", label: "Take" }, { key: "close", label: "Close" }] },
    { id: merge, kind: "merge", repo: "app", number: 7, question: "Merge?", options: [{ key: "merge", label: "Merge" }, { key: "no", label: "No" }] },
  ]);
  setCallContext({ jobId: 2, step: "decide", stage: 3, modelProvider: "codex", codexModel: "fixture-model", cancelled: () => false });
  const setup = { usageRun: "codex-prepare", checkout: async () => checkout, diff: async () => null, log() {} };
  try {
    assert.deepEqual(await prepare(w.db, [scope], setup), { stored: 1, failed: 0 });
    const decision = w.db.prepare("SELECT summary, recommended_by, answer FROM decisions WHERE id = ?").get(scope);
    assert.match(String(decision?.summary), /status pane is read-only/);
    assert.equal(decision?.recommended_by, "fixture-model");
    assert.equal(decision?.answer, null);
    const result = await prepare(w.db, [merge], {
      ...setup,
      onProgress: (line) => {
        if (line === "Starting Codex turn") w.db.prepare("UPDATE items SET head_oid = 'moved' WHERE repo = 'app' AND number = 7").run();
      },
    });
    assert.deepEqual(result, { stored: 0, failed: 0 });
    assert.equal(w.db.prepare("SELECT prepared_at FROM decisions WHERE id = ?").get(merge)?.prepared_at, null);
    assert.deepEqual(w.gh.writes, []);
  } finally {
    setCallContext(null);
    w.db.close();
  }
});
