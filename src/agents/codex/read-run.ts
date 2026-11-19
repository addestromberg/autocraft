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
const TIMEOUT_MS = 120_000;
const unavailable = "The Codex checkout runtime is unavailable";

type ReadRequest = { model?: string; scope: CodexReadScope; signal?: AbortSignal; retained?: { home: string; threadId?: string } };
type TurnOptions = { tools?: boolean; onProgress?: (line: string) => void };
type Reply = { text: string };
type ActiveTurn = {
  requestId: number; turnId?: string; text?: string; announcedReply: boolean; calls: number;
  options: TurnOptions; timer: ReturnType<typeof setTimeout>;
  resolve: (reply: Reply) => void; reject: (error: Error) => void;
};

/** A job-owned ephemeral thread. The checkout and model are fixed at session startup. */
export async function openCodexReadSession({ model, scope, signal, retained }: ReadRequest) {
  if ((await account("")).state !== "connected") throw new Error("Connect a Codex account in Accounts before running Codex");
  const { bin, options } = codexCommand();
  if (existsSync(join(options.cwd, "config.toml"))) throw new Error("The Codex account directory must not contain a CLI config for scoped checkout access");
  const cwd = await mkdtemp(join(tmpdir(), "autocraft-codex-read-"));
  const release = holdCheckouts([scope.checkout]);
  let tools: ReturnType<typeof codexReadTools>;
  try {
    tools = codexReadTools(scope);
  } catch {
    release();
    await rm(cwd, { recursive: true, force: true });
    throw new Error("Codex scoped checkout access could not start");
  }
  const child = spawn(bin, [
    "app-server", "--listen", "stdio://", "--disable", "shell_tool", "--disable", "unified_exec",
    "--disable", "apps", "--disable", "plugins", "--disable", "hooks", "--disable", "skill_search",
    "--enable", "skip_host_skill_discovery", "-c", "suppress_unstable_features_warning=true",
    "-c", 'web_search="disabled"', "-c", 'cli_auth_credentials_store="file"',
  ], { cwd, env: retained ? { ...options.env, HOME: retained.home, CODEX_HOME: retained.home } : options.env, stdio: ["pipe", "pipe", "ignore"] });
  const ready = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  let threadId: string | undefined;
  let active: ActiveTurn | undefined;
  let failure: Error | undefined;
  let nextId = 3;
  let buffer = "";
  const kill = () => child.kill("SIGKILL");
  const stop = (reason: string) => {
    failure ??= new Error(reason);
    kill();
  };
  const abort = () => stop("Codex checkout execution cancelled");
  const startupTimer = setTimeout(() => stop("Codex checkout startup timed out"), TIMEOUT_MS);
  const send = (message: object) => child.stdin.write(JSON.stringify(message) + "\n");
  const progress = (line: string) => {
    try { active?.options.onProgress?.(line); } catch { /* progress is best effort */ }
  };
  process.once("exit", kill);
  signal?.addEventListener("abort", abort, { once: true });
  child.on("error", () => stop(unavailable));
  child.stdin.on("error", () => stop(unavailable));
  child.once("close", () => {
    clearTimeout(startupTimer);
    process.removeListener("exit", kill);
    signal?.removeEventListener("abort", abort);
    failure ??= new Error("The Codex checkout runtime closed");
    ready.reject(failure);
    if (active) {
      clearTimeout(active.timer);
      active.reject(failure);
      active = undefined;
    }
    tools.close();
    release();
    void rm(cwd, { recursive: true, force: true }).then(closed.resolve, closed.reject);
  });
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    if (failure) return;
    buffer += chunk;
    if (buffer.length > MAX_FRAME) return stop("Codex exceeded the checkout response limit");
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line);
        const p = message.params;
        if (message.method && message.id !== undefined) {
          if (message.method !== "item/tool/call" || !active || p?.threadId !== threadId ||
            (active.turnId !== undefined && p.turnId !== active.turnId) || typeof p.tool !== "string") {
            return stop("Codex requested an operation outside scoped checkout access");
          }
          if (++active.calls > MAX_CALLS) return stop("Codex exceeded the checkout tool limit");
          const reply = active.options.tools === false
            ? { isError: true, text: "Checkout tools are disabled for this follow-up." }
            : tools.call(p.tool, p.arguments);
          if (active.options.tools !== false && !reply.isError) progress("Reading scoped context");
          send({ id: message.id, result: { success: !reply.isError, contentItems: [{ type: "inputText", text: reply.text }] } });
        } else if (message.id === 1 && message.result) {
          send({ method: "initialized" });
          const common = { cwd, model, sandbox: "read-only", approvalPolicy: "never" };
          if (retained?.threadId) {
            send({ id: 2, method: "thread/resume", params: { ...common, threadId: retained.threadId, excludeTurns: true } });
          } else {
            send({ id: 2, method: "thread/start", params: {
              ...common, ephemeral: !retained, environments: [],
              dynamicTools: tools.definitions.map((tool) => ({ ...tool, type: "function", deferLoading: false })),
            } });
          }
        } else if (message.id === 2 && typeof message.result?.thread?.id === "string") {
          if (retained?.threadId && retained.threadId !== message.result.thread.id) return stop("Codex resumed a different thread");
          threadId = message.result.thread.id;
          model = typeof message.result.model === "string" ? message.result.model : model;
          clearTimeout(startupTimer);
          ready.resolve();
        } else if (active && message.id === active.requestId && typeof message.result?.turn?.id === "string") {
          active.turnId = message.result.turn.id;
        } else if (message.id !== undefined) {
          return stop("The Codex runtime could not start scoped checkout access");
        } else if (active && threadId && p?.threadId === threadId) {
          if (active.turnId && p.turnId && active.turnId !== p.turnId) continue;
          if ((message.method === "item/started" || message.method === "item/completed") &&
            ["commandExecution", "fileChange", "mcpToolCall", "webSearch"].includes(p.item?.type)) {
            return stop("Codex reported an operation outside scoped checkout access");
          }
          if (message.method === "item/agentMessage/delta" && !active.announcedReply) {
            active.announcedReply = true;
            progress("Writing reply");
          }
          if (message.method === "item/completed" && p.item?.type === "agentMessage") active.text = p.item.text;
          if (message.method === "turn/completed") {
            if (active.turnId && p.turn?.id !== active.turnId) continue;
            const { text, timer, resolve, reject } = active;
            clearTimeout(timer);
            active = undefined;
            if (p.turn?.status !== "completed" || typeof text !== "string" || !text.trim() || text.length > MAX_REPLY) {
              reject(new Error("Codex checkout execution did not return a valid reply"));
            } else {
              resolve({ text });
            }
          }
        }
      } catch {
        return stop("Codex returned an invalid checkout protocol message");
      }
    }
  });
  if (signal?.aborted) abort();
  else send({ id: 1, method: "initialize", params: {
    clientInfo: { name: "autocraft", version: "0.1.0" }, capabilities: { experimentalApi: true },
  } });
  try {
    await ready.promise;
  } catch (error) {
    await closed.promise;
    throw error;
  }
  return {
    model, threadId: threadId!,
    async turn(prompt: string, options: TurnOptions = {}): Promise<Reply> {
      if (failure) throw failure;
      if (active) throw new Error("A Codex turn is already running in this session");
      const result = Promise.withResolvers<Reply>();
      const requestId = nextId++;
      const timer = setTimeout(() => stop("Codex checkout execution timed out"), TIMEOUT_MS);
      active = { requestId, options, announcedReply: false, calls: 0, timer, resolve: result.resolve, reject: result.reject };
      progress("Starting Codex turn");
      send({ id: requestId, method: "turn/start", params: { threadId, input: [{ type: "text", text: prompt, text_elements: [] }] } });
      return result.promise;
    },
    async close(): Promise<void> {
      stop("The Codex checkout session was closed");
      await closed.promise;
    },
  };
}

export async function runCodexRead({ prompt, onProgress, ...request }: ReadRequest & { prompt: string; onProgress?: TurnOptions["onProgress"] }): Promise<Reply> {
  const session = await openCodexReadSession(request);
  try {
    return await session.turn(prompt, { onProgress });
  } finally {
    await session.close();
  }
}
