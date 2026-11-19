// The MCP endpoint (`POST /mcp`): a read-only window on the caller's Markdown
// vault for AI clients. index.ts has already verified the access token and
// turned its subject into a tenant; everything here works from that tenant
// alone, exactly like the REST handlers. No tool takes a tenant, a user or a
// device as an argument, and no tool writes.
//
// The protocol is small enough to speak directly: JSON-RPC over one POST per
// request, no sessions, no streaming.

import type { TenantDO } from "./tenant-do";

const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

interface Rpc {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface McpContext {
  tenant: string;
  stub: DurableObjectStub<TenantDO>;
  files: R2Bucket;
}

const TOOLS = [
  {
    name: "get_outline",
    description: "The user's current Deskpad outline: the notes and open tasks in their sidebar right now, as nested Markdown bullets. Start here for what they are working on.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_files",
    description:
      "List the Markdown files in the user's Deskpad notes: outline.md, index.md, daily/YYYY-MM-DD.md (one per day: calendar events, notes written and tasks completed that day), topics/<name>.md (notes mentioning [[name]]) and tags/<tag>.md.",
    inputSchema: { type: "object", properties: { prefix: { type: "string", description: 'Only paths starting with this, e.g. "daily/2026-11".' } }, additionalProperties: false },
  },
  {
    name: "read_file",
    description: "Read one file from the user's Deskpad notes by the path list_files returned.",
    inputSchema: { type: "object", properties: { path: { type: "string", description: 'e.g. "daily/2026-11-19.md"' } }, required: ["path"], additionalProperties: false },
  },
  {
    name: "search_notes",
    description: "Find notes, tasks and calendar events containing every word of the query (case-insensitive). Returns matching lines with the file they are in.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100, description: "Default 30." } },
      required: ["query"],
      additionalProperties: false,
    },
  },
].map((t) => ({ ...t, annotations: { readOnlyHint: true, openWorldHint: false } }));

const FILE = /^(?:[^/]+\/)?[^/]+\.md$/;
const validPath = (p: unknown): p is string => typeof p === "string" && p.length <= 200 && !p.includes("..") && !p.includes("\\") && FILE.test(p);

const text = (s: string, isError = false) => ({ content: [{ type: "text", text: s }], isError });

async function readFile(ctx: McpContext, path: string): Promise<string | null> {
  // Brings the stored files up to date first.
  await ctx.stub.vaultList(ctx.tenant);
  const obj = await ctx.files.get(`t/${ctx.tenant}/md/${path}`);
  return obj ? obj.text() : null;
}

async function callTool(ctx: McpContext, name: unknown, args: Record<string, unknown>) {
  switch (name) {
    case "get_outline":
      return text((await readFile(ctx, "outline.md")) ?? "The outline is empty.");
    case "list_files": {
      const prefix = typeof args.prefix === "string" ? args.prefix : "";
      const files = (await ctx.stub.vaultList(ctx.tenant)).filter((f) => f.path.startsWith(prefix));
      return text(files.length ? files.map((f) => `${f.path} (${f.size} bytes)`).join("\n") : "No files.");
    }
    case "read_file": {
      if (!validPath(args.path)) return text("That is not a file path from list_files.", true);
      const body = await readFile(ctx, args.path);
      return body === null ? text("No such file.", true) : text(body);
    }
    case "search_notes": {
      const query = typeof args.query === "string" ? args.query.trim().slice(0, 200) : "";
      if (!query) return text("Give a query.", true);
      const limit = Math.max(1, Math.min(100, typeof args.limit === "number" ? Math.floor(args.limit) : 30));
      const hits = await ctx.stub.vaultSearch(ctx.tenant, query, limit);
      return text(hits.length ? hits.map((h) => `${h.path}: ${h.line}`).join("\n") : "Nothing matched.");
    }
    default:
      return null;
  }
}

async function answer(ctx: McpContext, msg: Rpc): Promise<object | null> {
  const id = msg.id ?? null;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const err = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return err(-32600, "Invalid request");
  // Notifications get no reply.
  if (msg.id === undefined) return null;
  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      return ok({
        protocolVersion: typeof asked === "string" && PROTOCOLS.includes(asked) ? asked : PROTOCOLS[1],
        capabilities: { tools: {} },
        serverInfo: { name: "deskpad", title: "Deskpad notes", version: "1.0.0" },
        instructions:
          "Read-only access to the user's Deskpad notes, tasks and recorded calendar days as Markdown. Use get_outline for current work, search_notes to find something, and daily/YYYY-MM-DD.md files for what happened on a day. Nothing can be changed through this server.",
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "tools/call": {
      const args = msg.params?.arguments && typeof msg.params.arguments === "object" ? (msg.params.arguments as Record<string, unknown>) : {};
      const result = await callTool(ctx, msg.params?.name, args);
      return result ? ok(result) : err(-32602, "Unknown tool");
    }
    default:
      return err(-32601, "Method not found");
  }
}

const reply = (body: unknown, status = 200) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: body === null ? { "cache-control": "private, no-store" } : { "content-type": "application/json", "cache-control": "private, no-store" },
  });

/** One MCP request for an already-authorized tenant. */
export async function handleMcp(req: Request, ctx: McpContext): Promise<Response> {
  let body: unknown;
  try {
    const raw = await req.text();
    if (raw.length > 100_000) return reply({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large" } }, 413);
    body = JSON.parse(raw);
  } catch {
    return reply({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.slice(0, 20).map((m) => answer(ctx, m as Rpc)))).filter((r) => r !== null);
    return out.length ? reply(out) : reply(null, 202);
  }
  const out = await answer(ctx, body as Rpc);
  return out ? reply(out) : reply(null, 202);
}
