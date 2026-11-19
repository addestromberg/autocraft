import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runCodex } from "../src/agents/codex/adapter.ts";
import { codexModelSettings, listCodexModels, selectedCodexModel, setCodexModelSettings } from "../src/agents/codex/models.ts";
import { connect } from "../src/db.ts";
import { SCRATCH } from "./scratch.ts";

test("Codex adapter uses only its private environment and requires completed text", async () => {
  const cli = join(SCRATCH, "codex");
  writeFileSync(cli, `#!/bin/sh
if [ "$3 $4" = "login status" ]; then exit 0; fi
if [ -n "$GH_TOKEN" ] || [ -n "$OPENAI_API_KEY" ] || [ "$HOME" != "$CODEX_HOME" ] || [ "$PWD" = "$CODEX_HOME" ]; then exit 1; fi
case "$(cat)" in
  valid) printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"answer"}}' '{"type":"turn.completed"}' ;;
  tools) printf '%s\\n' '{"type":"item.completed","item":{"type":"command_execution"}}' '{"type":"turn.completed"}' ;;
  incomplete) printf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"answer"}}' ;;
  error) echo 'CLI error with private details' >&2; exit 1 ;;
esac
`, { mode: 0o700 });
  process.env.AUTOCRAFT_CODEX_HOME = join(SCRATCH, "codex-home");
  process.env.AUTOCRAFT_CODEX_BIN = cli;
  process.env.GH_TOKEN = "not-visible";
  process.env.OPENAI_API_KEY = "not-visible";
  assert.deepEqual(await runCodex({ prompt: "valid" }), { text: "answer" });
  await assert.rejects(runCodex({ prompt: "tools" }), /invalid or tool-using response/);
  await assert.rejects(runCodex({ prompt: "incomplete" }), /invalid or tool-using response/);
  await assert.rejects(runCodex({ prompt: "error" }), { message: "Codex execution failed" });
  await assert.rejects(runCodex({ prompt: "error", model: "subscription-model" }), /could not run model subscription-model/);
  delete process.env.AUTOCRAFT_CODEX_HOME;
  await assert.rejects(runCodex({ prompt: "valid" }), /Connect a Codex account/);
});

test("Codex model settings inherit the instance default and list models through the connected runtime", async () => {
  const db = connect(join(SCRATCH, "models.db"));
  try {
    assert.deepEqual(codexModelSettings(db), { defaultModel: null, workflows: {} });
    assert.equal(selectedCodexModel(db, "prioritize"), undefined);
    setCodexModelSettings(db, { defaultModel: "subscription-default", workflows: { prioritize: "subscription-choice" } });
    assert.equal(selectedCodexModel(db, "classify-new"), "subscription-default");
    assert.equal(selectedCodexModel(db, "prioritize"), "subscription-choice");
  } finally {
    db.close();
  }
  const cli = join(SCRATCH, "catalog-codex");
  writeFileSync(cli, `#!/bin/sh
if [ "$3 $4" = "login status" ]; then exit 0; fi
if [ "$1" != "app-server" ]; then exit 1; fi
while IFS= read -r line; do
  case "$line" in
    *'"initialize"'*) echo '{"id":1,"result":{}}' ;;
    *'"cursor":"next"'*) echo '{"id":2,"result":{"data":[{"model":"second"},{"model":"hidden","hidden":true}],"nextCursor":null}}' ;;
    *'"model/list"'*) echo '{"id":2,"result":{"data":[{"model":"first"}],"nextCursor":"next"}}' ;;
  esac
done
`, { mode: 0o700 });
  process.env.AUTOCRAFT_CODEX_HOME = join(SCRATCH, "codex-home");
  process.env.AUTOCRAFT_CODEX_BIN = cli;
  assert.deepEqual(await listCodexModels(), ["first", "second"]);
  delete process.env.AUTOCRAFT_CODEX_HOME;
  assert.equal(await listCodexModels(), null);
});
