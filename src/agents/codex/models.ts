import { spawn } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import type { CodexModelSettings } from "../../../web/src/api/types.ts";
import { account, codexCommand } from "./account.ts";

const key = "codex_model_settings";

export function codexModelSettings(db: DatabaseSync): CodexModelSettings {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row ? JSON.parse(row.value) as CodexModelSettings : { defaultModel: null, workflows: {} };
}

export function setCodexModelSettings(db: DatabaseSync, settings: CodexModelSettings): void {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .run(key, JSON.stringify(settings));
}

export function selectedCodexModel(db: DatabaseSync, workflow: string): string | undefined {
  const settings = codexModelSettings(db);
  return (Object.hasOwn(settings.workflows, workflow) ? settings.workflows[workflow] : settings.defaultModel) ?? undefined;
}

/** Suggestions from the connected account's local Codex runtime. An unavailable list never blocks manual entry. */
export async function listCodexModels(): Promise<string[] | null> {
  if ((await account("")).state !== "connected") return null;
  const { bin, options } = codexCommand();
  return new Promise((resolve) => {
    const child = spawn(bin, [
      "app-server", "--listen", "stdio://", "--disable", "apps", "--disable", "plugins", "--disable", "hooks",
      "-c", 'cli_auth_credentials_store="file"',
    ], { ...options, stdio: ["pipe", "pipe", "ignore"] });
    const models = new Set<string>();
    let buffer = "";
    let done = false;
    const finish = (value: string[] | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 8_000);
    const send = (message: object) => child.stdin.write(JSON.stringify(message) + "\n");
    const list = (cursor?: string) => send({ id: 2, method: "model/list", params: { cursor, limit: 100 } });
    child.on("error", () => finish(null));
    child.on("close", () => finish(null));
    child.stdin.on("error", () => finish(null));
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 1024 * 1024) return finish(null);
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      for (const line of lines) {
        try {
          const message = JSON.parse(line);
          if (message.id === 1 && message.result) {
            send({ method: "initialized" });
            list();
          } else if (message.id === 2 && Array.isArray(message.result?.data)) {
            for (const model of message.result.data) {
              if (typeof model?.model === "string" && !model.hidden) models.add(model.model);
            }
            if (typeof message.result.nextCursor === "string" && models.size < 500) list(message.result.nextCursor);
            else finish([...models]);
          } else if (message.id === 1 || message.id === 2) finish(null);
        } catch {
          finish(null);
        }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "autocraft", version: "0.1.0" } } });
  });
}
