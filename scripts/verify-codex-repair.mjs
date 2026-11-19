import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withWorkflowProvider } from "../src/agents/call.ts";
import { setProviderSettings } from "../src/agents/provider.ts";
import { connect } from "../src/db.ts";
import { defaultDeps, tasksFor } from "../src/fixissue/index.ts";
import { validateFixPatch } from "../src/fixissue/parse.ts";
import { regressionName } from "../src/verify/types.ts";
import { parseWorkerConfig } from "../src/worker/config.ts";
import { executeTask } from "../src/worker/executor.ts";
import { downloadAndExtract } from "../src/worker/tarball.ts";

const sha = "26e56aeea440ae1c3167a50e2245ae3c21e4c119";
const repo = "autocraft-rust-fixture";
const sourceUrl = `https://codeload.github.com/addestromberg/${repo}/tar.gz/${sha}`;
const root = mkdtempSync(join(tmpdir(), "autocraft-repair-"));
const db = connect(":memory:");

try {
  const checkout = join(root, "checkout");
  mkdirSync(checkout);
  assert.ok(await downloadAndExtract(sourceUrl, checkout, 1024 * 1024));
  setProviderSettings(db, { defaultProvider: "claude", workflows: { fixissue: "codex" } });
  const test = regressionName(1);
  const testPath = `tests/${test}.rs`;
  const file = "src/lib.rs";
  const input = {
    ref: `${repo}#1`, title: "Correct the completed status label",
    body: 'completed_status() must return "Done" instead of "Pending".',
    comments: [], crate: { name: "status-fixture", dir: "." },
    test_path: testPath, files: [{ path: file }], repo_dir: "/repo",
  };
  const patch = await withWorkflowProvider(db, "fixissue", () =>
    defaultDeps().ask(db, "fixissue.patch", input, "repair-acceptance", checkout));
  assert.ok(patch, "Codex produced no patch");
  const valid = validateFixPatch(patch, [file], testPath, ".", test);
  assert.ok(valid.ok, valid.reason);

  const [fixed, baseline] = tasksFor(
    { repo, number: 1, main_sha: sha, crate: "status-fixture", test }, valid.patch, valid.testPatch,
  );
  const cfg = parseWorkerConfig({
    coordinatorUrl: "http://127.0.0.1:8981", keyFile: join(root, "unused"),
    workDir: join(root, "work"), userns: process.env.AUTOCRAFT_FIXTURE_USERNS,
  });
  async function run(id, task) {
    let testOutput = "";
    const result = await executeTask(cfg, { ...task, id, sourceUrl }, {
      async log(step, chunk) {
        if (step === "test") testOutput += chunk;
        process.stdout.write(`[${id}/${step}] ${chunk}`);
      },
      async artifact() {},
    }, AbortSignal.timeout(15 * 60_000));
    return { result, testOutput };
  }

  const before = await run(1, baseline);
  assert.deepEqual(before.result.results.map((s) => s.exitCode), [0, 0, 101], before.result.summary);
  assert.match(before.testOutput, /assertion.*failed/);
  assert.match(before.testOutput, /Pending/);
  assert.match(before.testOutput, /Done/);
  const after = await run(2, fixed);
  assert.equal(after.result.results.length, fixed.plan.length, after.result.summary);
  assert.ok(after.result.results.every((s) => s.exitCode === 0 && !s.timedOut), after.result.summary);
  console.log("Baseline reproduced the bug. All patched worker steps passed.");
} finally {
  db.close();
  rmSync(root, { recursive: true, force: true });
}
