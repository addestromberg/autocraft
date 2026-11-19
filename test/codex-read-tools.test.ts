import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { codexReadTools } from "../src/agents/codex/read-tools.ts";
import { runCodexRead } from "../src/agents/codex/read-run.ts";
import { connect } from "../src/db.ts";
import { writeSnapshot } from "../src/itemtools/snapshot.ts";
import { SCRATCH } from "./scratch.ts";

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
