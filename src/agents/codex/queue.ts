import type { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { allocation, currentClass, modelCallStopping, stepOf, StoppedError, WaitLimitError } from "../call.ts";

const slotKey = "codex_model_slot";
const leaseMs = 30_000;

/** A database-wide slot shared by the runner and standalone CLI in this instance. */
export async function takeCodexSlot(db: DatabaseSync, promptId: string, controller: AbortController, opts: {
  maxWaitMs?: number;
  onProgress?: (line: string) => void;
} = {}): Promise<() => void> {
  const began = Date.now();
  const context = stepOf(promptId);
  const id = Number(db.prepare(`INSERT INTO model_waits (provider, class, job_id, step, since, seen_at, eligible)
    VALUES ('codex', ?, ?, ?, ?, ?, 1)`)
    .run(currentClass(promptId), context.jobId, context.step, began, began).lastInsertRowid);
  const clearWait = db.prepare("DELETE FROM model_waits WHERE id = ?");
  const renew = db.prepare(`UPDATE settings SET value = json_set(value, '$.until', ?)
    WHERE key = ? AND json_extract(value, '$.id') = ?`);
  const release = db.prepare("DELETE FROM settings WHERE key = ? AND json_extract(value, '$.id') = ?");
  let reported = false;
  try {
    for (;;) {
      if (controller.signal.aborted || modelCallStopping()) throw new StoppedError("cancelled while waiting for Codex");
      const now = Date.now();
      db.prepare("INSERT INTO model_waits (id, provider, class, job_id, step, since, seen_at, eligible) VALUES (?, 'codex', ?, ?, ?, ?, ?, 1) ON CONFLICT (id) DO UPDATE SET seen_at = excluded.seen_at")
        .run(id, currentClass(promptId), context.jobId, context.step, began, now);
      const claimed = db.prepare(`INSERT INTO settings (key, value)
        SELECT ?, json_object('id', ?, 'until', ?)
        WHERE ? = (SELECT id FROM model_waits WHERE provider = 'codex' AND seen_at >= ? ORDER BY id LIMIT 1)
        ON CONFLICT (key) DO UPDATE SET value = excluded.value
        WHERE json_extract(settings.value, '$.until') <= ?`).run(slotKey, id, now + leaseMs, id, now - allocation.staleMs, now);
      if (Number(claimed.changes)) {
        if (reported && context.jobId !== null) db.prepare("UPDATE jobs SET progress = NULL WHERE id = ? AND progress = ?").run(context.jobId, "Waiting for the Codex account");
        const timer = setInterval(() => {
          try {
            if (!Number(renew.run(Date.now() + leaseMs, slotKey, id).changes)) controller.abort();
          } catch {
            controller.abort();
          }
        }, leaseMs / 3);
        timer.unref();
        return () => {
          clearInterval(timer);
          release.run(slotKey, id);
        };
      }
      if (opts.maxWaitMs !== undefined && now - began >= opts.maxWaitMs) throw new WaitLimitError("no Codex account slot became free in time");
      if (!reported) {
        reported = true;
        const message = "Waiting for the Codex account";
        if (context.jobId !== null) db.prepare("UPDATE jobs SET progress = ? WHERE id = ? AND state = 'running'").run(message, context.jobId);
        opts.onProgress?.(message);
      }
      const wait = opts.maxWaitMs === undefined ? allocation.pollMs : Math.min(allocation.pollMs, opts.maxWaitMs - (now - began));
      try {
        await delay(wait, undefined, { signal: controller.signal });
      } catch (error) {
        if (!controller.signal.aborted) throw error;
      }
    }
  } finally {
    clearWait.run(id);
  }
}
