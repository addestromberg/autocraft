import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TextAgentAdapter } from "../types.ts";
import { account, codexCommand } from "./account.ts";

type CodexRequest = { prompt: string; model?: string; signal?: AbortSignal };
type CodexReply = { text: string };

function readReply(stdout: string): CodexReply {
  let text: string | undefined;
  let completed = false;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    if (event.type === "turn.completed") completed = true;
    if (event.type === "turn.failed" || event.type === "error") throw new Error();
    if (event.type !== "item.completed") continue;
    if (event.item?.type === "agent_message" && typeof event.item.text === "string") text = event.item.text;
    else if (event.item?.type !== "reasoning") throw new Error();
  }
  if (!completed || !text?.trim()) throw new Error();
  return { text };
}

/** The first adapter supports prompt-only calls with no repository or tools. */
export const runCodex: TextAgentAdapter<CodexRequest, CodexReply> = async ({ prompt, model, signal }) => {
  if ((await account("")).state !== "connected") throw new Error("Connect a Codex account in Accounts before running Codex");
  const { bin, options } = codexCommand();
  const cwd = await mkdtemp(join(tmpdir(), "autocraft-codex-"));
  try {
    const args = [
      "exec", "--json", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules",
      "--sandbox", "read-only", "--disable", "shell_tool", "--disable", "unified_exec",
      "--disable", "apps", "--disable", "plugins", "--disable", "hooks",
      "--disable", "skill_search", "--enable", "skip_host_skill_discovery",
      "-c", "suppress_unstable_features_warning=true",
      "-c", 'approval_policy="never"', "-c", 'web_search="disabled"',
      "-c", 'cli_auth_credentials_store="file"',
      ...(model ? ["--model", model] : []), "-",
    ];
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile(bin, args, { cwd, env: options.env, signal, timeout: 120_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 }, (error, output) => {
        if (error) reject(new Error(signal?.aborted ? "Codex execution cancelled" : model ? `Codex could not run model ${model}; check that the connected account can use it` : "Codex execution failed"));
        else resolve(output);
      });
      child.stdin?.on("error", () => {});
      child.stdin?.end(prompt);
    });
    try {
      return readReply(stdout);
    } catch {
      throw new Error("Codex returned an invalid or tool-using response");
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
};
