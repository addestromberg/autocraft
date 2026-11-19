import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setCallContext } from "../src/agents/call.ts";
import { setJevEnabled } from "../src/agents/jev.ts";
import { listRuns } from "../src/agents/runs.ts";
import { runModelStep, runTiered } from "../src/agents/step.ts";
import { CLASSIFY_HAIKU, PRIORITY } from "../src/agents/steps.ts";
import type { Item } from "../src/classify/parse.ts";
import { setRunner } from "../src/classify/run.ts";
import { connect } from "../src/db.ts";
import { checkPairs, defaultCheckDeps } from "../src/dupes/check.ts";
import { SCRATCH } from "./scratch.ts";

test("Codex text jobs reuse classification, priority, and duplicate validators without Claude", async () => {
  const db = connect(join(SCRATCH, "text.db"));
  const cli = join(SCRATCH, "codex-fixture");
  writeFileSync(cli, `#!/usr/bin/node
const { readFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args.slice(-2).join(" ") === "login status") process.exit(0);
if (args[0] !== "exec" || args[args.indexOf("--model") + 1] !== "fixture-model") process.exit(1);
const prompt = readFileSync(0, "utf8");
const text = prompt.startsWith("You classify")
  ? [{ref:"app#1",type_label:"bugfix",security:false,needs_decision:false,reason:"Broken view"}]
  : prompt.startsWith("You assign a priority")
    ? [{ref:"app#1",impact:"P3",reason:"Limited impact"}]
    : [{ref:"app#1~2",verdict:"distinct",reason:"Different symptoms"}];
console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:JSON.stringify(text)}}));
console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:6,cached_input_tokens:2,output_tokens:3}}));
`, { mode: 0o700 });
  process.env.AUTOCRAFT_CODEX_HOME = join(SCRATCH, "codex-home");
  process.env.AUTOCRAFT_CODEX_BIN = cli;
  setJevEnabled(db, false, "test");
  const context = (step: string) => setCallContext({
    jobId: 1, step, stage: 2, modelProvider: "codex", codexModel: "fixture-model", cancelled: () => false,
  });
  const item: Item = { repo: "app", number: 1, kind: "issue", title: "Broken view", body: "Accounts fails", lines_changed: null, files_changed: null, author_association: null };
  try {
    context("classify-new");
    const classified = await runModelStep(db, CLASSIFY_HAIKU, [item]);
    assert.equal(classified.ok && classified.value[0]?.type_label, "bugfix");
    context("prioritize");
    const priorities = await runTiered(db, PRIORITY, [item]);
    assert.equal(priorities.haiku.get("app#1")?.impact, "P3");
    assert.ok(priorities.alone.has("app#1"));
    context("dupes");
    db.exec(`INSERT INTO items (repo, number, kind, state, title) VALUES ('app', 1, 'issue', 'OPEN', 'Broken view'), ('app', 2, 'issue', 'OPEN', 'Other view');
      INSERT INTO duplicate_pairs (repo, a, b, a_hash, b_hash, similarity, created_at) VALUES ('app', 1, 2, 'first', 'second', 0.9, datetime('now'));`);
    const duplicates = await checkPairs(db, [{ repo: "app", a: 1, b: 2, a_hash: "first", b_hash: "second", similarity: 0.9 }], defaultCheckDeps(db));
    assert.equal(duplicates.verdicts.distinct, 1);
    const runs = listRuns(db, {}).runs;
    assert.equal(runs.length, 3);
    for (const run of runs) {
      assert.equal(run.provider, "codex");
      assert.equal(run.model, "fixture-model");
      assert.equal(run.inputTokens, 4);
      assert.equal(run.cacheReadTokens, 2);
    }
    context("prioritize");
    setJevEnabled(db, true, "test");
    let confidence = 0.99;
    const restore = setRunner(async (command) => {
      assert.equal(command, "jev");
      return { code: 0, stderr: "", stdout: JSON.stringify({
        answers: { impact: { choice: "P2", confidence } }, usage: { input_tokens: 6, output_tokens: 3 },
      }) };
    });
    try {
      const confident = await runTiered(db, PRIORITY, [item]);
      assert.equal(confident.jev.get("app#1")?.impact, "P2");
      assert.equal(confident.haiku.size, 0);
      confidence = 0.55;
      const uncertain = await runTiered(db, PRIORITY, [item]);
      assert.equal(uncertain.jev.get("app#1")?.p, 0.55);
      assert.equal(uncertain.haiku.get("app#1")?.impact, "P3");
      assert.equal(listRuns(db, {}).runs.filter((run) => run.provider === "codex").length, 4);
    } finally {
      restore();
    }
  } finally {
    setCallContext(null);
    db.close();
  }
});
