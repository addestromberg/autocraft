import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openCodexReadSession } from "../src/agents/codex/read-run.ts";
import { buildCheckout } from "../src/sandbox/checkout.ts";
import { connect } from "../src/db.ts";
import { writeSnapshot } from "../src/itemtools/snapshot.ts";
const dir = mkdtempSync(join(tmpdir(), "autocraft-m3-scope-"));
try {
  const work = join(dir, "repo");
  mkdirSync(work);
  const git = (...args) => execFileSync("git", args, { cwd: work, encoding: "utf8" }).trim();
  git("init", "-q");
  writeFileSync(join(work, "pinned.txt"), "M3_PINNED_COMMIT_42K");
  git("add", "pinned.txt");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Seed pinned text");
  const sha = git("rev-parse", "HEAD");
  writeFileSync(join(work, "pinned.txt"), "UNCOMMITTED_CONTENT");
  const checkout = join(dir, "checkout");
  assert.equal((await buildCheckout(join(work, ".git"), sha, checkout)).ok, true);
  const src = join(dir, "source.db"), snapshot = join(dir, "snapshot.db");
  const db = connect(src);
  db.exec("INSERT INTO repos (name,visibility) VALUES ('fixture','public'); INSERT INTO items (repo,number,kind,state,title) VALUES ('fixture',1,'issue','OPEN','M3_SCOPED_ITEM_79L'),('fixture',2,'issue','OPEN','UNAUTHORIZED_ITEM');");
  db.close();
  writeSnapshot(src, snapshot);
  const session = await openCodexReadSession({
    scope: { checkout, items: { snapshot, refs: [{ repo: "fixture", number: 1 }] } },
  });
  const progress = [];
  try {
    const { text } = await session.turn("Use read_checkout_file to read pinned.txt and item to read fixture issue 1. Reply with the contents of the file, then a vertical bar, then the issue title. Return only that single line.", { onProgress: (line) => progress.push(line) });
    assert.equal(text.trim(), "M3_PINNED_COMMIT_42K|M3_SCOPED_ITEM_79L");
    assert.ok(progress.includes("Reading scoped context"));
    const next = await session.turn("Repeat the exact one-line answer from the previous turn. Use no tools.", { tools: false });
    assert.equal(next.text.trim(), text.trim());
  } finally {
    await session.close();
  }
  assert.equal(readFileSync(join(checkout, "pinned.txt"), "utf8"), "M3_PINNED_COMMIT_42K");
  console.log("Live Incus checkout access, progress, and same-thread follow-up passed.");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
