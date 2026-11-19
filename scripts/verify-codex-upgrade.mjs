import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { syncAccounts } from "../src/agents/accounts.ts";
import { withWorkflowProvider } from "../src/agents/call.ts";
import { providerSettings, setProviderSettings } from "../src/agents/provider.ts";
import { runModelStep } from "../src/agents/step.ts";
import { CLASSIFY_HAIKU } from "../src/agents/steps.ts";
import { setRunner } from "../src/classify/run.ts";
import { connect } from "../src/db.ts";

const [, , sourcePath] = process.argv;
if (!sourcePath) throw new Error("Usage: node scripts/verify-codex-upgrade.mjs /path/to/development.db");

const root = mkdtempSync(join(tmpdir(), "autocraft-upgrade-"));
const path = join(root, "mirror.db");
const settings = (db) => db.prepare(
  "SELECT key, value FROM settings WHERE key IN ('model_provider_settings', 'codex_model_settings') ORDER BY key",
).all();
const item = {
  repo: "acceptance-fixture", number: 1, kind: "issue", title: "Status label is incorrect",
  body: "The completed status incorrectly says Pending instead of Done.",
  lines_changed: null, files_changed: null, author_association: null,
};

try {
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    await backup(source, path);
  } finally {
    source.close();
  }
  const snapshot = new DatabaseSync(path, { readOnly: true });
  const before = settings(snapshot);
  snapshot.close();
  const db = connect(path);
  try {
    assert.deepEqual(settings(db), before);
    assert.equal(db.prepare("PRAGMA quick_check").get().quick_check, "ok");
    const saved = providerSettings(db);
    const modelSettings = before.find((row) => row.key === "codex_model_settings");
    const classify = () => withWorkflowProvider(db, "classify-new", () => runModelStep(db, CLASSIFY_HAIKU, [item]));
    const mark = db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM agent_runs").get().id;

    delete process.env.AUTOCRAFT_ACCOUNTS;
    process.env.AUTOCRAFT_ACCOUNTS_ROOT = join(root, "no-claude-accounts");
    setProviderSettings(db, { defaultProvider: "codex", workflows: {} });
    const codex = await classify();
    assert.ok(codex.ok && codex.value[0]?.type_label === "bugfix", "Live Codex classification failed");

    const accounts = join(root, "accounts.json");
    const usage = join(root, "usage");
    mkdirSync(usage);
    writeFileSync(accounts, JSON.stringify([{ id: "upgrade-fixture", configDir: join(root, "fake-claude") }]));
    process.env.AUTOCRAFT_ACCOUNTS = accounts;
    process.env.AUTOCRAFT_USAGE_DIR = usage;
    delete process.env.AUTOCRAFT_ACCOUNTS_ROOT;
    syncAccounts(db);
    db.prepare("UPDATE claude_accounts SET enabled = 1 WHERE id = 'upgrade-fixture'").run();

    setProviderSettings(db, { defaultProvider: "claude", workflows: {} });
    let called = false;
    const restore = setRunner(async (command) => {
      assert.equal(command, "claude");
      called = true;
      return { code: 0, stderr: "", stdout: JSON.stringify({
        type: "result", subtype: "success",
        result: JSON.stringify([{ ref: "acceptance-fixture#1", type_label: "bugfix", security: false, needs_decision: false, reason: "Incorrect label" }]),
        usage: { input_tokens: 5, output_tokens: 2 },
      }) };
    });
    try {
      const claude = await classify();
      assert.ok(called && claude.ok && claude.value[0]?.type_label === "bugfix", "Simulated Claude classification failed");
    } finally {
      restore();
    }
    const runs = db.prepare("SELECT provider, state FROM agent_runs WHERE id > ? ORDER BY id").all(mark);
    assert.deepEqual(runs.map((row) => [row.provider, row.state]), [["codex", "done"], ["claude", "done"]]);

    setProviderSettings(db, saved);
    assert.deepEqual(providerSettings(db), saved);
    assert.deepEqual(settings(db).find((row) => row.key === "codex_model_settings"), modelSettings);
    console.log("Upgrade preserved settings. Live Codex and simulated Claude completed the same workflow on the copy.");
  } finally {
    db.close();
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
