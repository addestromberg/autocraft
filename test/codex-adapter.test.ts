import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runCodex } from "../src/agents/codex/adapter.ts";
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
  delete process.env.AUTOCRAFT_CODEX_HOME;
  await assert.rejects(runCodex({ prompt: "valid" }), /Connect a Codex account/);
});
