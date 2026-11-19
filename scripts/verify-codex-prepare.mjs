import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connect } from "../src/db.ts";
import { ask } from "../src/decisions.ts";
import { setCallContext } from "../src/agents/call.ts";
import { prepare } from "../src/decide/prepare.ts";
import { listCodexModels } from "../src/agents/codex/models.ts";
const models = await listCodexModels();
assert.ok(models?.length);
const dir = mkdtempSync(join(tmpdir(), "autocraft-prepare-live-"));
const db = connect(join(dir, "mirror.db"));
try {
  db.exec("INSERT INTO repos (name, visibility) VALUES ('fixture', 'private'); INSERT INTO tracked_repos (name, pipeline) VALUES ('fixture', 1); INSERT INTO items (repo, number, kind, state, title, body) VALUES ('fixture', 1, 'issue', 'OPEN', 'Improve the status pane', 'The status pane shows a misleading label.');");
  const id = "fixture#1:scope";
  ask(db, [{ id, kind: "scope", repo: "fixture", number: 1, question: "Is this in scope? Read status-policy.txt in the checkout before recommending an option.", options: [
    { key: "take", label: "Take" }, { key: "close", label: "Close" },
  ] }]);
  writeFileSync(join(dir, "status-policy.txt"), "Keeping the existing status pane labels accurate is in scope. A replacement dashboard is out of scope.");
  const checkout = join(dir, "checkout");
  const { mkdirSync, renameSync } = await import("node:fs");
  mkdirSync(checkout);
  renameSync(join(dir, "status-policy.txt"), join(checkout, "status-policy.txt"));
  setCallContext({ jobId: 1, step: "decide", stage: 3, modelProvider: "codex", codexModel: models[0], cancelled: () => false });
  const progress = [];
  const result = await prepare(db, [id], { checkout: async () => checkout, diff: async () => null, usageRun: "m3-prepare-live",
    log: console.log, onProgress: (line) => progress.push(line) });
  assert.equal(result.stored, 1);
  assert.ok(progress.includes("Reading scoped context"));
  const decision = db.prepare("SELECT answer, summary, recommended_by FROM decisions WHERE id=?").get(id);
  assert.equal(decision.answer, null);
  assert.ok(decision.summary);
  assert.equal(decision.recommended_by, models[0]);
  console.log("Live prepared decision stored with a scoped read and an unanswered operator decision.");
} finally {
  setCallContext(null);
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
