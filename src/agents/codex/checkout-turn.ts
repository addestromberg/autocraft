import type { DatabaseSync } from "node:sqlite";
import { promptVersion } from "../../classify/run.ts";
import type { ItemRef } from "../../../web/src/api/types.ts";
import type { ClaudePromptId } from "../../prompts/index.ts";
import { stepOf } from "../call.ts";
import { finishRun, insertRun, setRunProgress } from "../runs.ts";
import { scrub } from "../../runner/scrub.ts";
import { jsonObject } from "../../security/rules.ts";
import type { openCodexReadSession } from "./read-run.ts";

type Session = Pick<Awaited<ReturnType<typeof openCodexReadSession>>, "model" | "turn">;

/** Records an initial or follow-up checkout turn in the existing run history and forwards job progress. */
export async function recordCodexCheckoutTurn(db: DatabaseSync, session: Session, input: {
  promptId: ClaudePromptId; prompt: string; items: ItemRef[]; followUp?: boolean;
  onProgress?: (line: string) => void;
}): Promise<{ text: string }> {
  const { promptId, prompt, items, followUp, onProgress } = input;
  const run = insertRun(db, { ...stepOf(promptId), promptId, promptVersion: promptVersion(promptId),
    provider: "codex", model: session.model ?? "codex", accountId: null, items, prompt });
  try {
    const reply = await session.turn(prompt, {
      tools: !followUp,
      onProgress(line) {
        setRunProgress(db, run, line);
        onProgress?.(line);
      },
    });
    const output = promptId === "security.verify" ? jsonObject(reply.text) : null;
    const text = scrub(promptId === "security.verify" ? output ? JSON.stringify({
      verdict: output.verdict, score: output.score, result: output.result, notes: output.notes,
    }) : "" : reply.text);
    finishRun(db, run, { state: "done", output: text });
    return { text };
  } catch (error) {
    finishRun(db, run, { state: "failed", error: error instanceof Error ? error.message : "Codex checkout turn failed" });
    throw error;
  }
}
