import { closeSync, constants, fstatSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { callTool, frame, openDb, TOOLS, type ToolResult } from "../../itemtools/server/tools.ts";
import { safePath } from "../../sandbox/checkout.ts";
import { isInstructionPath } from "../../sandbox/instruction-paths.ts";

const MAX_READ_BYTES = 32_000;
const MAX_ENTRIES = 200;
const filePath = { type: "string", description: "A path relative to the pinned checkout, or under an explicitly authorized /repo, /reference, or /repo-docs root." };
const itemTool = TOOLS.find((tool) => tool.name === "item")!;

export type CodexReadScope = {
  checkout: string;
  reference?: string;
  repoDocs?: string;
  items?: { snapshot: string; refs: readonly { repo: string; number: number }[] };
};

const unavailable = (): ToolResult => ({ text: "Path, item, or tool unavailable in this run.", isError: true });
const safe = (path: string): boolean => safePath(path) && !/[\r\n]/.test(path) && !isInstructionPath(path);

/** Model tools are dispatched here. The model receives data from these operations, with no shell or network operation. */
export function codexReadTools(scope: CodexReadScope) {
  const root = realpathSync(scope.checkout);
  if (root === sep) throw new Error("A pinned checkout is required");
  const roots = new Map([["repo", root]]);
  for (const [name, directory] of [["reference", scope.reference], ["repo-docs", scope.repoDocs]] as const) {
    if (!directory) continue;
    const resolved = realpathSync(directory);
    if (resolved === sep) throw new Error("A scoped reference directory is required");
    roots.set(name, resolved);
  }
  const scopedPath = (value: string, rootAllowed = false) => {
    let base = root;
    let path = value;
    if (value.startsWith("/")) {
      const [, name, ...parts] = value.split("/");
      const found = roots.get(name!);
      if (!found) throw new Error();
      base = found;
      path = parts.join("/");
    }
    if (rootAllowed && !path) return base;
    if (!safe(path)) throw new Error();
    const target = resolve(base, path);
    if (!target.startsWith(base + sep) || realpathSync(target) !== target) throw new Error();
    return target;
  };
  const definitions = [
    { name: "read_checkout_file", description: "Read UTF-8 text in the pinned checkout.", inputSchema: {
      type: "object", additionalProperties: false, required: ["path"],
      properties: { path: filePath, offset: { type: "integer", minimum: 0, description: "Byte offset, default zero." } },
    } },
    { name: "list_checkout_directory", description: "List files and directories in the pinned checkout.", inputSchema: {
      type: "object", additionalProperties: false, properties: { path: filePath },
    } },
    ...(scope.items ? [itemTool] : []),
  ];
  const db = scope.items ? openDb(scope.items.snapshot) : null;
  const allowedItems = new Set(scope.items?.refs.map(({ repo, number }) => `${repo}#${number}`));
  return {
    definitions,
    close: () => db?.close(),
    call(name: string, args: unknown): ToolResult {
      if (!args || typeof args !== "object" || Array.isArray(args)) return unavailable();
      const input = args as Record<string, unknown>;
      try {
        if (name === "item" && db && scope.items) {
          if (typeof input.repo !== "string" || !Number.isSafeInteger(input.number) || !allowedItems.has(`${input.repo}#${input.number}`)) return unavailable();
          const result = callTool(db, { db: scope.items.snapshot, diffs: null }, name, input);
          return result.isError ? unavailable() : result;
        }
        if (name === "list_checkout_directory" && (input.path === undefined || typeof input.path === "string") && Object.keys(input).every((key) => key === "path")) {
          const path = input.path ?? "";
          const entries = readdirSync(scopedPath(path, true), { withFileTypes: true })
            .filter((entry) => (entry.isFile() || entry.isDirectory()) && safe(entry.name))
            .sort((a, b) => a.name.localeCompare(b.name));
          return { text: frame("checkout directory", entries.slice(0, MAX_ENTRIES).map((entry) => entry.name + (entry.isDirectory() ? "/" : "")).join("\n") +
            (entries.length > MAX_ENTRIES ? "\n[additional entries omitted]" : "")) };
        }
        if (name !== "read_checkout_file" || typeof input.path !== "string" ||
          Object.keys(input).some((key) => key !== "path" && key !== "offset")) return unavailable();
        const offset = input.offset === undefined ? 0 : input.offset;
        if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) return unavailable();
        const fd = openSync(scopedPath(input.path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const info = fstatSync(fd);
          if (!info.isFile() || offset > info.size) return unavailable();
          const buf = Buffer.alloc(MAX_READ_BYTES);
          const count = readSync(fd, buf, 0, buf.length, offset);
          if (buf.subarray(0, count).includes(0)) return unavailable();
          const text = buf.toString("utf8", 0, count);
          const next = offset + count;
          return { text: frame("pinned checkout file", text + (next < info.size ? `\n[continue at byte offset ${next}]` : "")) };
        } finally {
          closeSync(fd);
        }
      } catch {
        return unavailable();
      }
    },
  };
}
