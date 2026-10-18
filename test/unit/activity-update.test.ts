import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseUpdates, rowFromFlags } from "../../src/commands/activity-update";
import { json, mockFetch, run, text, useTempConfig, type Recorded } from "../helpers";

const config = useTempConfig();

const encoder = new TextEncoder();
const PROFILE = "p-1";

/** An SSE reply as rmcp sends it: a priming event, then the JSON-RPC message. */
function rpcReply(id: number, result: unknown): Response {
  const body = `data: \nid: 0\nretry: 3000\n\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`;
  return new Response(encoder.encode(body), {
    headers: { "content-type": "text/event-stream", "mcp-session-id": "s-1" },
  });
}

const toolResult = (value: unknown) => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  structuredContent: value,
  isError: false,
});

const preview = {
  rows: [
    {
      index: 0,
      activityId: "a1",
      status: "ready",
      changes: [
        { field: "unitPrice", current: "100", proposed: "110" },
        { field: "amount", current: "1001", proposed: "1101" },
      ],
    },
  ],
  summary: { total: 1, ready: 1, invalid: 0 },
};

function storeToken(): void {
  writeFileSync(
    join(config.dir(), "agent-token.json"),
    JSON.stringify({
      url: "http://wf.test",
      profileId: PROFILE,
      id: "t-1",
      name: "wf CLI",
      token: "wfp_secret",
      scopes: ["activities:read"],
    }),
  );
}

/** A server whose /mcp answers tools/call with `tools[name]`. */
function mcpServer(
  tools: Record<string, unknown>,
  extra?: (req: Recorded) => Response | undefined,
) {
  return mockFetch((req) => {
    const handled = extra?.(req);
    if (handled) return handled;
    if (req.path === "/mcp") {
      if (req.method === "DELETE") return new Response(null, { status: 202 });
      const msg = req.body as { id?: number; method: string; params?: { name: string } };
      if (msg.id === undefined) return new Response(null, { status: 202 });
      if (msg.method === "initialize") return rpcReply(msg.id, { protocolVersion: "2025-06-18" });
      return rpcReply(msg.id, toolResult(tools[msg.params!.name]));
    }
    return json(null);
  });
}

const mcpCalls = (seen: Recorded[]) =>
  seen
    .filter((r) => r.path === "/mcp" && r.method === "POST")
    .map(
      (r) =>
        (r.body as { method: string; params?: { name?: string } }).params?.name ??
        (r.body as { method: string }).method,
    );

describe("rows", () => {
  it("builds a row from flags; --clear sets null; camel and kebab names both work", () => {
    const row = rowFromFlags(" a1 ", {
      unitPrice: "110",
      fee: undefined,
      notes: "fix",
      clear: ["unit-price", "asset"].slice(1),
      approve: true,
      waitTimeout: 300,
    });
    expect(row).toEqual({
      activityId: "a1",
      unitPrice: "110",
      notes: "fix",
      assetId: null,
      approve: true,
    });
  });

  it("refuses an empty change, a required field in --clear, and set-and-clear", () => {
    expect(() => rowFromFlags("a1", { clear: [], waitTimeout: 1 })).toThrow("at least one field");
    expect(() => rowFromFlags("a1", { clear: ["currency"], waitTimeout: 1 })).toThrow(
      "Cannot clear currency",
    );
    expect(() => rowFromFlags("a1", { fee: "1", clear: ["fee"], waitTimeout: 1 })).toThrow(
      "both set and cleared",
    );
  });

  it("takes an array or { updates: [...] }", () => {
    expect(parseUpdates('[{"activityId":"a"}]', "x")).toEqual([{ activityId: "a" }]);
    expect(parseUpdates('{"updates":[{"activityId":"a"}]}', "x")).toEqual([{ activityId: "a" }]);
    expect(() => parseUpdates('{"activityId":"a"}', "x")).toThrow("array of update objects");
    expect(() => parseUpdates("[1]", "x")).toThrow("array of update objects");
    expect(() => parseUpdates("{", "x")).toThrow("not valid JSON");
  });
});

describe("wf activity update", () => {
  it("--dry-run calls the server's prepare tool with the token and profile, and prints its preview", async () => {
    storeToken();
    const seen = mcpServer({ prepare_activity_updates: preview });
    const res = await run("activity", "update", "a1", "--unit-price", "110", "--dry-run");
    expect(res.code).toBe(0);
    expect(res.json()).toEqual({ dryRun: true, ...preview });
    expect(mcpCalls(seen)).toEqual([
      "initialize",
      "notifications/initialized",
      "prepare_activity_updates",
    ]);
    const call = seen.find((r) => (r.body as { method?: string })?.method === "tools/call")!;
    expect(call.body).toMatchObject({
      params: { arguments: { updates: [{ activityId: "a1", unitPrice: "110" }] } },
    });
    expect(call.headers).toMatchObject({
      authorization: "Bearer wfp_secret",
      "x-wf-profile-id": PROFILE,
      "mcp-session-id": "s-1",
    });
    // The MCP session is closed.
    expect(seen.at(-1)).toMatchObject({ path: "/mcp", method: "DELETE" });
  });

  it("exits 1 when a previewed row is invalid", async () => {
    storeToken();
    mcpServer({
      prepare_activity_updates: {
        rows: [{ index: 0, activityId: "a1", status: "invalid", error: "Nothing to change" }],
        summary: { total: 1, ready: 0, invalid: 1 },
      },
    });
    const res = await run("activity", "update", "a1", "--fee", "1", "--dry-run");
    expect(res.code).toBe(1);
    expect(res.stdout).toContain("Nothing to change");
  });

  it("--table lists one line per changed field", async () => {
    storeToken();
    mcpServer({ prepare_activity_updates: preview });
    const res = await run(
      "--table",
      "activity",
      "update",
      "a1",
      "--unit-price",
      "110",
      "--dry-run",
    );
    expect(res.stdout).toMatch(/a1\s+unitPrice\s+100\s+110/);
    expect(res.stdout).toMatch(/a1\s+amount\s+1001\s+1101/);
  });

  it("applies with the commit tool; a batch comes from --updates", async () => {
    storeToken();
    const commit = {
      updated: [
        { index: 0, activityId: "a1", changes: [{ field: "fee", before: "1", after: null }] },
      ],
      errors: [{ index: 1, activityId: "a2", message: "Activity a2 not found" }],
    };
    const seen = mcpServer({ commit_activity_updates: commit });
    const res = await run(
      "activity",
      "update",
      "--updates",
      '[{"activityId":"a1","fee":null},{"activityId":"a2","fee":1}]',
    );
    expect(res.json()).toEqual({ dryRun: false, ...commit });
    // One row failed.
    expect(res.code).toBe(1);
    expect(mcpCalls(seen)).toContain("commit_activity_updates");
  });

  it("--wait waits only when a row was applied", async () => {
    storeToken();
    const events = vi.fn(() => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(encoder.encode("event: portfolio:update-start\ndata: null\n\n"));
          c.enqueue(encoder.encode("event: portfolio:update-complete\ndata: null\n\n"));
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    });
    const server = (updated: unknown[]) =>
      mcpServer({ commit_activity_updates: { updated, errors: [] } }, (req) =>
        req.path === "/api/v1/events/stream" ? events() : undefined,
      );
    server([{ index: 0, activityId: "a1", changes: [] }]);
    const done = await run("activity", "update", "a1", "--fee", "2", "--wait");
    expect(done.code).toBe(0);
    expect(done.json()).toMatchObject({ wait: { status: "complete" } });

    server([]);
    const none = await run(
      "activity",
      "update",
      "a1",
      "--fee",
      "2",
      "--wait",
      "--wait-timeout",
      "1",
    );
    expect(none.json()).not.toHaveProperty("wait");
  });

  it("explains a missing token, a rejected one, and a server without /mcp", async () => {
    mockFetch(() => json(null));
    const missing = await run("activity", "update", "a1", "--fee", "1");
    expect(missing.code).toBe(3);
    expect(missing.stderr).toContain("wf agent-token create");

    storeToken();
    mockFetch(() => json({ jsonrpc: "2.0", error: { code: -32000 } }, { status: 401 }));
    const rejected = await run("activity", "update", "a1", "--fee", "1");
    expect(rejected.code).toBe(3);
    expect(rejected.stderr).toContain("rejected the agent access token");

    mockFetch(() => text("", 405));
    const off = await run("activity", "update", "a1", "--fee", "1");
    expect(off.code).toBe(1);
    expect(off.stderr).toContain("WF_MCP_ENABLED=true");
  });

  it("WF_AGENT_TOKEN wins over the stored token", async () => {
    storeToken();
    vi.stubEnv("WF_AGENT_TOKEN", "wfp_env");
    const seen = mcpServer({ prepare_activity_updates: preview });
    await run("activity", "update", "a1", "--fee", "1", "--dry-run");
    expect(seen.find((r) => r.path === "/mcp")!.headers.authorization).toBe("Bearer wfp_env");
  });

  it("refuses ids with flags mixed with --updates", async () => {
    const res = await run("activity", "update", "a1", "--fee", "1", "--updates", "[]");
    expect(res.code).toBe(2);
  });
});

describe("wf agent-token", () => {
  const profileState = () =>
    json({
      profiles: [{ id: PROFILE, name: "Personal", lockEnabled: false }],
      session: { profileId: PROFILE, scopeId: "scope-1" },
    });

  it("creates a token with the activity scopes, stores it 0600, checks /mcp, and hides the secret", async () => {
    const seen = mcpServer({}, (req) => {
      if (req.path === "/api/v1/profiles/get_profile_state") return profileState();
      if (req.path === "/api/v1/agent-access/tokens" && req.method === "POST") {
        return json({
          token: "wfp_new",
          id: "t-2",
          name: "wf CLI (h)",
          scopes: (req.body as { scopes: string[] }).scopes,
          expiresAt: null,
        });
      }
      return undefined;
    });
    const res = await run("agent-token", "create", "--expires-days", "0");
    expect(res.code).toBe(0);
    const create = seen.find((r) => r.path === "/api/v1/agent-access/tokens")!;
    expect(create.body).toEqual({
      name: expect.stringMatching(/^wf CLI \(/),
      scopes: ["activities:read", "activities:draft", "activities:write"],
    });
    expect(create.headers["x-wf-profile-scope"]).toBe("scope-1");
    expect(res.stdout).not.toContain("wfp_new");
    expect(res.json()).toMatchObject({ id: "t-2", profileId: PROFILE, mcp: { ok: true } });
    const path = join(config.dir(), "agent-token.json");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      token: "wfp_new",
      profileId: PROFILE,
    });
  });

  it("sets an expiry by default and reports a server without /mcp", async () => {
    const seen = mockFetch((req) => {
      if (req.path === "/api/v1/profiles/get_profile_state") return profileState();
      if (req.path === "/api/v1/agent-access/tokens") {
        return json({ token: "wfp_new", id: "t-2", name: "n", scopes: [], expiresAt: "x" });
      }
      return text("", 405);
    });
    const res = await run("agent-token", "create");
    expect(res.code).toBe(1);
    expect(res.json()).toMatchObject({
      mcp: { ok: false, hint: expect.stringContaining("WF_MCP_ENABLED") },
    });
    const body = seen.find((r) => r.path === "/api/v1/agent-access/tokens")!.body as {
      expiresAt: string;
    };
    const days = (Date.parse(body.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89);
    expect(days).toBeLessThan(91);
  });

  it("delete revokes the stored token on the server and removes the file", async () => {
    storeToken();
    const seen = mockFetch((req) => {
      if (req.path === "/api/v1/profiles/get_profile_state") return profileState();
      if (req.path === "/api/v1/agent-access/tokens") return json([{ id: "t-1" }]);
      return new Response(null, { status: 204 });
    });
    const res = await run("agent-token", "delete");
    expect(res.json()).toEqual({ deleted: true, revoked: true, id: "t-1" });
    expect(seen.map((r) => `${r.method} ${r.path}`)).toContain(
      "DELETE /api/v1/agent-access/tokens/t-1",
    );
    expect((await run("agent-token", "show")).json()).toBeNull();
  });
});
