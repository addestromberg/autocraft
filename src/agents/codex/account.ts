import { execFile, spawn, type ChildProcess } from "node:child_process";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { CodexAccount } from "../../../web/src/api/types.ts";
import { AccountError } from "../accounts.ts";

const deviceUrl = "https://auth.openai.com/codex/device";
const commonArgs = ["-c", 'cli_auth_credentials_store="file"'];

interface Login {
  owner: string;
  child: ChildProcess;
  code: string | null;
  finished: Promise<void>;
}

let login: Login | undefined;
let failedOwner: string | undefined;
let signingOut = false;

export function codexCommand() {
  const home = process.env.AUTOCRAFT_CODEX_HOME;
  if (!home || !isAbsolute(home)) throw new AccountError(503, "Set AUTOCRAFT_CODEX_HOME to a private absolute directory");
  try {
    mkdirSync(home, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw new AccountError(503, "Codex account directory is unavailable");
  }
  try {
    const info = lstatSync(home);
    const path = realpathSync(home);
    if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0 ||
      path === join(realpathSync(homedir()), ".codex")) throw new Error();
    return {
      bin: process.env.AUTOCRAFT_CODEX_BIN || "codex",
      options: { cwd: path, env: { HOME: path, CODEX_HOME: path, PATH: process.env.PATH ?? "/usr/bin:/bin" } },
    };
  } catch {
    throw new AccountError(503, "Codex account directory must be private, service-owned, and separate from the interactive Codex home");
  }
}

function run(args: string[]): Promise<boolean> {
  const { bin, options } = codexCommand();
  return new Promise((resolve, reject) => {
    execFile(bin, [...commonArgs, ...args], { ...options, timeout: 5000, maxBuffer: 8192 }, (err, _stdout, stderr) => {
      if (!err) resolve(true);
      else if (err.code === 1 && args[0] === "login" && stderr.split("\n").includes("Not logged in")) resolve(false);
      else reject(new AccountError(503, "Could not run the Codex account command"));
    });
  });
}

export async function account(owner: string): Promise<CodexAccount> {
  if (!process.env.AUTOCRAFT_CODEX_HOME) return { state: "unconfigured" };
  if (signingOut) return { state: "disconnecting" };
  if (login) {
    if (login.owner !== owner) return { state: "busy" };
    return login.code ? { state: "waiting", url: deviceUrl, code: login.code } : { state: "starting" };
  }
  if (await run(["login", "status"])) return { state: "connected" };
  return { state: failedOwner === owner ? "failed" : "disconnected" };
}

export async function startLogin(owner: string): Promise<CodexAccount> {
  if (login || signingOut) throw new AccountError(409, "A Codex account operation is in progress");
  const connected = await run(["login", "status"]);
  if (connected || login || signingOut) {
    throw new AccountError(409, "Codex is already connected or an account operation is in progress");
  }
  const { bin, options } = codexCommand();
  const child = spawn(bin, [...commonArgs, "login", "--device-auth"], { ...options, stdio: ["ignore", "pipe", "ignore"] });
  const state: Login = { owner, child, code: null, finished: Promise.resolve() };
  failedOwner = undefined;
  login = state;
  let output = "";
  const timeout = setTimeout(() => child.kill("SIGKILL"), 16 * 60_000);
  const stop = () => child.kill("SIGKILL");
  process.once("exit", stop);
  state.finished = new Promise((resolve) => {
    child.on("error", () => {});
    child.once("close", (code) => {
      clearTimeout(timeout);
      process.off("exit", stop);
      login = undefined;
      if (code !== 0 && !signingOut) failedOwner = owner;
      resolve();
    });
  });
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    if (state.code) return;
    output += chunk;
    if (output.length > 8192) { stop(); return; }
    const clean = stripVTControlCharacters(output);
    if (clean.includes(deviceUrl)) state.code = /Enter this one-time code[^\n]*\n\s*([A-Z0-9]+-[A-Z0-9]+)\s/.exec(clean)?.[1] ?? null;
  });
  return { state: "starting" };
}

export async function disconnect(owner: string): Promise<CodexAccount> {
  if (signingOut || (login && login.owner !== owner)) throw new AccountError(409, "A Codex account operation is in progress");
  signingOut = true;
  try {
    if (login) {
      const { child, finished } = login;
      child.kill("SIGKILL");
      await finished;
    }
    await run(["logout"]);
    failedOwner = undefined;
    return { state: "disconnected" };
  } finally {
    signingOut = false;
  }
}
