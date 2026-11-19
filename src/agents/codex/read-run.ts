import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { holdCheckouts } from "../../sandbox/checkout.ts";
import { account, codexCommand } from "./account.ts";
import { codexReadTools, type CodexReadScope } from "./read-tools.ts";

const MAX_CALLS = 32;
const MAX_FRAME = 1024 * 1024;
const MAX_REPLY = 100_000;

/** A single repository-aware turn. AutoCraft dispatches the only model-accessible tools. */
export async function runCodexRead({ prompt, model, scope, signal }: {
  prompt: string; model?: string; scope: CodexReadScope; signal?: AbortSignal;
}): Promise<{ text: string }> {
  if ((await account("")).state !== "connected") throw new Error("Connect a Codex account in Accounts before running Codex");
  const { bin, options } = codexCommand();
  if (existsSync(join(options.cwd, "config.toml"))) throw new Error("The Codex account directory must not contain a CLI config for scoped checkout access");
  const cwd = await mkdtemp(join(tmpdir(), "autocraft-codex-read-"));
  const release = holdCheckouts([scope.checkout]);
  let tools: ReturnType<typeof codexReadTools> | undefined;
  try {
    try {
      tools = codexReadTools(scope);
    } catch {
      throw new Error("Codex scoped checkout access could not start");
    }
    const { definitions, call } = tools;
    return await new Promise((resolve, reject) => {
      const child = spawn(bin, [
        "app-server", "--listen", "stdio://", "--disable", "shell_tool", "--disable", "unified_exec",
        "--disable", "apps", "--disable", "plugins", "--disable", "hooks", "--disable", "skill_search",
        "--enable", "skip_host_skill_discovery", "-c", "suppress_unstable_features_warning=true",
        "-c", 'web_search="disabled"', "-c", 'cli_auth_credentials_store="file"',
      ], { cwd, env: options.env, stdio: ["pipe", "pipe", "ignore"] });
      let threadId: string | undefined;
      let turnId: string | undefined;
      let text: string | undefined;
      let failure: Error | undefined;
      let calls = 0;
      let buffer = "";
      let complete = false;
      const stop = (reason: string) => {
        failure ??= new Error(reason);
        child.kill("SIGKILL");
      };
      const abort = () => stop("Codex checkout execution cancelled");
      const timer = setTimeout(() => stop("Codex checkout execution timed out"), 120_000);
      const send = (value: object) => child.stdin.write(JSON.stringify(value) + "\n");
      child.on("error", () => stop("The Codex checkout runtime is unavailable"));
      child.stdin.on("error", () => { if (!complete) stop("The Codex checkout runtime stopped responding"); });
      child.once("close", () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (complete && text && !failure) resolve({ text });
        else reject(failure ?? new Error("The Codex checkout runtime closed without a completed reply"));
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) return abort();
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        if (failure || complete) return;
        buffer += chunk;
        if (buffer.length > MAX_FRAME) return stop("Codex exceeded the checkout response limit");
        const lines = buffer.split("\n");
        buffer = lines.pop()!;
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const message = JSON.parse(line);
            if (message.method && message.id !== undefined) {
              const p = message.params;
              if (message.method !== "item/tool/call" || !threadId || p?.threadId !== threadId ||
                (turnId !== undefined && p.turnId !== turnId) || typeof p.tool !== "string") {
                return stop("Codex requested an operation outside scoped checkout access");
              }
              if (++calls > MAX_CALLS) return stop("Codex exceeded the checkout tool limit");
              const reply = call(p.tool, p.arguments);
              send({ id: message.id, result: { success: !reply.isError, contentItems: [{ type: "inputText", text: reply.text }] } });
            } else if (message.id === 1 && message.result) {
              send({ method: "initialized" });
              send({ id: 2, method: "thread/start", params: {
                cwd, model, sandbox: "read-only", approvalPolicy: "never", ephemeral: true, environments: [],
                dynamicTools: definitions.map((tool) => ({ ...tool, type: "function", deferLoading: false })),
              } });
            } else if (message.id === 2 && typeof message.result?.thread?.id === "string") {
              threadId = message.result.thread.id;
              send({ id: 3, method: "turn/start", params: { threadId, input: [{ type: "text", text: prompt, text_elements: [] }] } });
            } else if (message.id === 3 && typeof message.result?.turn?.id === "string") {
              turnId = message.result.turn.id;
            } else if (message.id !== undefined) {
              return stop("The Codex runtime could not start scoped checkout access");
            } else if (message.params?.threadId === threadId && threadId) {
              const p = message.params;
              if ((message.method === "item/started" || message.method === "item/completed") &&
                ["commandExecution", "fileChange", "mcpToolCall", "webSearch"].includes(p.item?.type)) {
                return stop("Codex reported an operation outside scoped checkout access");
              }
              if (message.method === "item/completed" && p.item?.type === "agentMessage") text = p.item.text;
              if (message.method === "turn/completed") {
                if (p.turn?.status !== "completed" || typeof text !== "string" || !text.trim() || text.length > MAX_REPLY) {
                  return stop("Codex checkout execution did not return a valid reply");
                }
                complete = true;
                child.kill("SIGKILL");
                return;
              }
            }
          } catch {
            return stop("Codex returned an invalid checkout protocol message");
          }
        }
      });
      send({ id: 1, method: "initialize", params: {
        clientInfo: { name: "autocraft", version: "0.1.0" }, capabilities: { experimentalApi: true },
      } });
    });
  } finally {
    tools?.close();
    release();
    await rm(cwd, { recursive: true, force: true });
  }
}
