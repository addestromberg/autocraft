import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withWorkflowProvider } from "../src/agents/call.ts";
import { setProviderSettings } from "../src/agents/provider.ts";
import { createEnv, hello } from "../src/build/envs.ts";
import { appendLog, claim, createTask, finishTask, getTaskDetail, startTask } from "../src/build/tasks.ts";
import { loadOwners, splitSlug } from "../src/owners.ts";
import { connect } from "../src/db.ts";
import { defaultDeps, tasksFor } from "../src/fixissue/index.ts";
import { validateFixPatch } from "../src/fixissue/parse.ts";
import { regressionName } from "../src/verify/types.ts";
import { detectCapabilities, parseWorkerConfig } from "../src/worker/config.ts";
import { executeTask } from "../src/worker/executor.ts";
import { downloadAndExtract } from "../src/worker/tarball.ts";

const sha = "26e56aeea440ae1c3167a50e2245ae3c21e4c119";
const fixture = "addestromberg/autocraft-rust-fixture";
const { owner, name: repo } = splitSlug(fixture);
const sourceUrl = `https://codeload.github.com/${fixture}/tar.gz/${sha}`;
const root = mkdtempSync(join(tmpdir(), "autocraft-repair-"));
const db = connect(":memory:");

try {
  db.prepare("INSERT INTO repos (name, owner, visibility) VALUES (?, ?, 'public')").run(repo, owner);
  db.prepare("INSERT INTO tracked_repos (name, pipeline) VALUES (?, 1)").run(repo);
  loadOwners(db);
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
  mkdirSync(cfg.workDir);
  const worker = "fixture-worker";
  createEnv(db, { id: worker, label: "Fixture worker", kind: "local-sandbox", slots: 1 }, "acceptance");
  hello(db, worker, { version: "acceptance", capabilities: detectCapabilities(cfg), slots: 1 });
  async function run(task) {
    const id = createTask(db, task);
    const [claimed] = claim(db, worker, 1).tasks;
    assert.equal(claimed?.id, id);
    assert.equal(claimed.sourceUrl, sourceUrl);
    startTask(db, worker, id);
    const result = await executeTask(cfg, claimed, {
      async log(step, chunk) {
        appendLog(db, worker, id, step, chunk);
        process.stdout.write(`[${id}/${step}] ${chunk}`);
      },
      async artifact() {},
    }, AbortSignal.timeout(15 * 60_000));
    finishTask(db, worker, id, result);
    const detail = getTaskDetail(db, id);
    assert.ok(detail);
    return detail;
  }

  const before = await run(baseline);
  assert.equal(before.state, "failed", before.summary);
  assert.deepEqual(before.results.map((s) => s.exitCode), [0, 0, 101], before.summary);
  assert.match(before.logTail, /assertion.*failed/);
  assert.match(before.logTail, /Pending/);
  assert.match(before.logTail, /Done/);
  const after = await run(fixed);
  assert.equal(after.state, "done", after.summary);
  assert.equal(after.results.length, fixed.plan.length, after.summary);
  assert.ok(after.results.every((s) => s.exitCode === 0 && !s.timedOut), after.summary);
  console.log("Baseline reproduced the bug. All patched worker steps passed.");
} finally {
  db.close();
  rmSync(root, { recursive: true, force: true });
}
