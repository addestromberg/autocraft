import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { codexReadTools } from "../src/agents/codex/read-tools.ts";
import { openCodexReadSession, runCodexRead } from "../src/agents/codex/read-run.ts";
import { recordCodexCheckoutTurn } from "../src/agents/codex/checkout-turn.ts";
import { connect } from "../src/db.ts";
import { writeSnapshot } from "../src/itemtools/snapshot.ts";
import { SCRATCH } from "./scratch.ts";

test("Codex defensive verification stores only its static review fields", async () => {
  const db = connect(join(SCRATCH, "verification.db"));
  try {
    const session = {
      model: "fixture-model",
      async turn() {
        return { text: JSON.stringify({ verdict: "disproved", score: 1, result: "The guard rejects invalid values.", proposed_test: "SYNTHETIC-PROPOSAL" }) };
      },
      async close() {},
    };
    const result = await recordCodexCheckoutTurn(db, session, { promptId: "security.verify", prompt: "Review static evidence", items: [] });
    assert.deepEqual(JSON.parse(result.text), { verdict: "disproved", score: 1, result: "The guard rejects invalid values." });
  } finally {
    db.close();
  }
});

test("Codex checkout tools read pinned files and scoped item data only", () => {
  const checkout = join(SCRATCH, "checkout");
  mkdirSync(checkout);
  writeFileSync(join(checkout, "README.md"), "PINNED-SYNTHETIC-FILE");
  writeFileSync(join(checkout, "AGENTS.md"), "Instruction file");
  writeFileSync(join(SCRATCH, "outside.txt"), "SYNTHETIC-HOST-SECRET");
  symlinkSync(join(SCRATCH, "outside.txt"), join(checkout, "link.txt"));
  writeFileSync(join(checkout, "large.txt"), "a".repeat(32_001));
  const source = join(SCRATCH, "source.db");
  const snapshot = join(SCRATCH, "snapshot.db");
  const db = connect(source);
  db.exec(`INSERT INTO repos (name, visibility) VALUES ('fixture', 'public'), ('other', 'public');
    INSERT INTO items (repo, number, kind, state, title) VALUES ('fixture', 1, 'issue', 'OPEN', 'SYNTHETIC-ITEM-TITLE'),
      ('fixture', 2, 'issue', 'OPEN', 'UNRELATED-ITEM'), ('other', 1, 'issue', 'OPEN', 'OTHER-REPO-ITEM');`);
  db.close();
  writeSnapshot(source, snapshot);
  const tools = codexReadTools({ checkout, items: { snapshot, refs: [{ repo: "fixture", number: 1 }] } });
  try {
    assert.deepEqual(tools.definitions.map((tool) => tool.name), ["read_checkout_file", "list_checkout_directory", "item"]);
    assert.match(tools.call("read_checkout_file", { path: "README.md" }).text, /PINNED-SYNTHETIC-FILE/);
    assert.match(tools.call("read_checkout_file", { path: "large.txt" }).text, /continue at byte offset 32000/);
    assert.doesNotMatch(tools.call("list_checkout_directory", {}).text, /AGENTS\.md|link\.txt|outside\.txt/);
    for (const path of ["../outside.txt", join(SCRATCH, "outside.txt"), "link.txt", "AGENTS.md", ".git/config"]) {
      const result = tools.call("read_checkout_file", { path });
      assert.equal(result.isError, true);
      assert.doesNotMatch(result.text, /SYNTHETIC-HOST-SECRET/);
    }
    assert.match(tools.call("item", { repo: "fixture", number: 1 }).text, /SYNTHETIC-ITEM-TITLE/);
    assert.equal(tools.call("item", { repo: "fixture", number: 2 }).isError, true);
    assert.equal(tools.call("item", { repo: "other", number: 1 }).isError, true);
    assert.equal(tools.call("write_checkout_file", { path: "README.md", text: "changed" }).isError, true);
    assert.equal(tools.call("http_request", { url: "https://github.com" }).isError, true);
    assert.match(tools.call("read_checkout_file", { path: "README.md" }).text, /PINNED-SYNTHETIC-FILE/);
  } finally {
    tools.close();
  }
});

test("Codex checkout runtime refuses an unregistered server request", async () => {
  const cli = join(SCRATCH, "codex-runtime");
  writeFileSync(cli, `#!/usr/bin/node
const { createInterface } = require("node:readline");
if (process.argv.slice(-2).join(" ") === "login status") process.exit(0);
const output = (message) => console.log(JSON.stringify(message));
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") output({ id: message.id, result: {} });
  if (message.method === "thread/start") {
    if (message.params.environments.length || message.params.sandbox !== "read-only" || message.params.approvalPolicy !== "never") process.exit(1);
    output({ id: message.id, result: { thread: { id: "fixture-thread" } } });
  }
  if (message.method === "turn/start") {
    output({ id: message.id, result: { turn: { id: "fixture-turn" } } });
    output({ id: 99, method: "item/commandExecution/requestApproval", params: { threadId: "fixture-thread", turnId: "fixture-turn" } });
  }
});
`, { mode: 0o700 });
  process.env.AUTOCRAFT_CODEX_HOME = join(SCRATCH, "codex-home");
  process.env.AUTOCRAFT_CODEX_BIN = cli;
  await assert.rejects(runCodexRead({ prompt: "Read a checkout", scope: { checkout: join(SCRATCH, "checkout") } }),
    /outside scoped checkout access/);
});

test("checkout turns share a pinned thread, record progress, refuse follow-up tools, and cancel", async () => {
  const cli = join(SCRATCH, "codex-session");
  const pidFile = join(SCRATCH, "session-pid");
  writeFileSync(cli, `#!/usr/bin/node
const { createInterface } = require("node:readline");
const { writeFileSync } = require("node:fs");
if (process.argv.slice(-2).join(" ") === "login status") process.exit(0);
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
const output = (message) => console.log(JSON.stringify(message));
const threadId = "fixture-thread";
let count = 0;
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") output({ id: message.id, result: {} });
  if (message.method === "thread/start") {
    if (message.params.model !== "fixture-model") process.exit(1);
    output({ id: message.id, result: { thread: { id: threadId } } });
  }
  if (message.method === "turn/start") {
    if (message.params.threadId !== threadId) process.exit(1);
    count++;
    const turnId = "turn-" + count;
    output({ id: message.id, result: { turn: { id: turnId } } });
    if (count < 3) output({ id: 100, method: "item/tool/call", params: { threadId, turnId, tool: "read_checkout_file", arguments: { path: "README.md" } } });
  }
  if (message.id === 100) {
    const turnId = "turn-" + count;
    if (message.result.success !== (count === 1)) process.exit(1);
    output({ method: "item/agentMessage/delta", params: { threadId, turnId, delta: "text" } });
    output({ method: "item/completed", params: { threadId, turnId, item: { type: "agentMessage", text: count === 1 ? "first" : "follow-up" } } });
    output({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
  }
});
`, { mode: 0o700 });
  process.env.AUTOCRAFT_CODEX_HOME = join(SCRATCH, "codex-home");
  process.env.AUTOCRAFT_CODEX_BIN = cli;
  const signal = new AbortController();
  const db = connect(join(SCRATCH, "session-runs.db"));
  const session = await openCodexReadSession({ model: "fixture-model", signal: signal.signal, scope: { checkout: join(SCRATCH, "checkout") } });
  const seen: string[] = [];
  const input = {
    promptId: "decide.prepare" as const, prompt: "First turn", items: [],
    onProgress(line: string) {
      const row = db.prepare("SELECT progress FROM agent_runs WHERE state = 'running'").get();
      if (row?.progress === line) seen.push(line);
    },
  };
  try {
    assert.deepEqual(await recordCodexCheckoutTurn(db, session, input), { text: "first" });
    assert.deepEqual(seen, ["Starting Codex turn", "Reading scoped context", "Writing reply"]);
    seen.length = 0;
    assert.deepEqual(await recordCodexCheckoutTurn(db, session, { ...input, prompt: "Follow up", followUp: true }), { text: "follow-up" });
    assert.deepEqual(seen, ["Starting Codex turn", "Writing reply"]);
    const pending = recordCodexCheckoutTurn(db, session, { ...input, prompt: "Cancel this turn" });
    signal.abort();
    await assert.rejects(pending, /cancelled/);
    const states = db.prepare("SELECT provider, model, state FROM agent_runs ORDER BY id").all();
    assert.deepEqual(states.map((row) => [row.provider, row.model, row.state]), [
      ["codex", "fixture-model", "done"], ["codex", "fixture-model", "done"], ["codex", "fixture-model", "failed"],
    ]);
    assert.throws(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0), { code: "ESRCH" });
  } finally {
    await session.close();
    db.close();
  }
});
