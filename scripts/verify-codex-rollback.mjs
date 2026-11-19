import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { connect } from "../src/db.ts";

const [, , sourcePath, previousPath] = process.argv;
if (!sourcePath || !previousPath) {
  throw new Error("Usage: node scripts/verify-codex-rollback.mjs /path/to/development.db /path/to/previous/build");
}
const previous = resolve(previousPath);
const candidate = new URL("../", import.meta.url);
const root = mkdtempSync(join(tmpdir(), "autocraft-rollback-"));
const snapshot = join(root, "backup.db");
const working = join(root, "working.db");
const settings = (db) => db.prepare(
  "SELECT key, value FROM settings WHERE key IN ('model_provider_settings', 'codex_model_settings') ORDER BY key",
).all();

async function boot(base) {
  const load = (path) => import(new URL(path, base));
  const [{ connect: open }, { loadConfig }, { startServer }, { addLogin, getAccess }] = await Promise.all([
    load("src/db.ts"), load("src/dash/server/config.ts"), load("src/dash/server/index.ts"), load("src/access.ts"),
  ]);
  const web = new URL("web/dist/", base);
  const asset = readFileSync(new URL("index.html", web), "utf8").match(/<script[^>]+src="([^"]+)"/)?.[1];
  assert.ok(asset, "Dashboard build has no entry asset");
  const db = open(working);
  try {
    assert.equal(db.prepare("PRAGMA quick_check").get().quick_check, "ok");
    if (!getAccess(db, "rollback-operator")) addLogin(db, "cli", "rollback-operator", "operator", null);
    const config = loadConfig({ AUTOCRAFT_DEV_AUTH: "1", AUTOCRAFT_LISTEN: "127.0.0.1:0", AUTOCRAFT_DB: working });
    const server = await startServer({ config, db });
    try {
      const cookies = new Map();
      const get = async (url) => {
        const response = await fetch(new URL(url, server.url), {
          redirect: "manual", headers: { cookie: [...cookies.values()].join("; ") },
        });
        for (const header of response.headers.getSetCookie()) {
          const pair = header.split(";")[0];
          cookies.set(pair.split("=")[0], pair);
        }
        return response;
      };
      const signin = await get("/auth/signin?return_to=/");
      const authorize = await get(signin.headers.get("location") + "&login=rollback-operator");
      const signedIn = await get(authorize.headers.get("location"));
      assert.equal(signedIn.status, 303);
      const page = await get("/");
      assert.equal(page.status, 200);
      assert.ok((await page.text()).includes(asset), "Dashboard served a different build entry");
      const response = await get(asset);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /javascript/);
      return settings(db);
    } finally {
      await server.close();
    }
  } finally {
    db.close();
  }
}

try {
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    await backup(source, snapshot);
  } finally {
    source.close();
  }
  copyFileSync(snapshot, working);
  const previousBuild = pathToFileURL(previous + "/");
  const baseline = await boot(previousBuild);
  assert.deepEqual(await boot(candidate), baseline);

  const changed = connect(working);
  try {
    changed.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('rollback_acceptance_marker', 'candidate')").run();
  } finally {
    changed.close();
  }
  for (const suffix of ["-wal", "-shm"]) rmSync(working + suffix, { force: true });
  copyFileSync(snapshot, working);
  const restored = new DatabaseSync(working, { readOnly: true });
  try {
    assert.equal(restored.prepare("SELECT value FROM settings WHERE key = 'rollback_acceptance_marker'").get(), undefined);
  } finally {
    restored.close();
  }
  assert.deepEqual(await boot(previousBuild), baseline);
  console.log("The candidate and restored dashboard builds started. Rollback restored the database settings.");
} finally {
  rmSync(root, { recursive: true, force: true });
}
