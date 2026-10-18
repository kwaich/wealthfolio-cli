import { describe, expect, it } from "vitest";
import { parseSse } from "../../src/events";
import { json, mockFetch, run, text, useTempConfig, type Recorded } from "../helpers";

useTempConfig();

const encoder = new TextEncoder();

/** An SSE response that sends `chunks`, each after `gapMs`, then stays open. */
function sse(chunks: string[], gapMs = 5): Response {
  let timer: NodeJS.Timeout | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let i = 0;
      const next = () => {
        if (i < chunks.length) {
          controller.enqueue(encoder.encode(chunks[i++]));
          timer = setTimeout(next, gapMs);
        }
      };
      timer = setTimeout(next, gapMs);
    },
    cancel() {
      clearTimeout(timer);
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

const event = (name: string, data = "null") => `event: ${name}\ndata: ${data}\n\n`;

async function collect(text: string[]) {
  const out = [];
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const t of text) c.enqueue(encoder.encode(t));
      c.close();
    },
  });
  for await (const e of parseSse(body)) out.push(e);
  return out;
}

describe("parseSse", () => {
  it("parses events split across chunks, skips keep-alive comments, parses JSON data", async () => {
    expect(
      await collect([
        ": keep-alive\n\nevent: market:sync-com",
        'plete\ndata: {"failed_syncs":[]}\n\n',
        "event: portfolio:update-start\r\ndata: null\r\n\r\n",
        "data: plain\n\n",
      ]),
    ).toEqual([
      { name: "market:sync-complete", data: { failed_syncs: [] } },
      { name: "portfolio:update-start", data: null },
      { name: "message", data: "plain" },
    ]);
  });
});

function server(events: string[], gapMs?: number) {
  return mockFetch((req: Recorded) => {
    if (req.path === "/api/v1/events/stream") return sse(events, gapMs);
    if (req.path === "/api/v1/activities") return json({ id: "new" });
    return json(null);
  });
}

const createArgs = ["call", "create_activity", "--args", '{"activity":{"accountId":"a"}}'];

describe("--wait", () => {
  it("opens the stream before the write and reports the finished job", async () => {
    const seen = server([
      event("portfolio:update-start"),
      event("market:sync-complete", '{"failed_syncs":[]}'),
      event("portfolio:update-complete"),
    ]);
    const res = await run(...createArgs, "--wait");
    expect(res.code).toBe(0);
    expect(seen.map((r) => r.path)).toEqual(["/api/v1/events/stream", "/api/v1/activities"]);
    expect(seen[0]!.headers.authorization).toBeUndefined();
    expect(res.json()).toMatchObject({
      result: { id: "new" },
      wait: { status: "complete", marketSync: { failed_syncs: [] } },
    });
  });

  it("ignores the end of a job that was running before the write", async () => {
    server([
      event("portfolio:update-complete"),
      event("portfolio:update-start"),
      event("portfolio:update-error", '{"message":"boom"}'),
    ]);
    const res = await run(...createArgs, "--wait");
    expect(res.code).toBe(1);
    expect(res.json()).toMatchObject({ wait: { status: "error", error: { message: "boom" } } });
  });

  it("times out with exit 1, after the write", async () => {
    const seen = server([": keep-alive\n\n"], 5);
    const res = await run(...createArgs, "--wait", "--wait-timeout", "0");
    expect(res.code).toBe(1);
    expect(res.json()).toMatchObject({ result: { id: "new" }, wait: { status: "timeout" } });
    expect(seen.some((r) => r.path === "/api/v1/activities")).toBe(true);
  });

  it("refuses --wait on a read command", async () => {
    const seen = server([]);
    const res = await run("call", "get_accounts", "--wait");
    expect(res.code).toBe(2);
    expect(seen).toHaveLength(0);
  });

  it("does not wait on a dry run", async () => {
    const seen = mockFetch((req) =>
      req.path.endsWith("/search")
        ? json({
            data: [
              {
                id: "a1",
                accountId: "x",
                activityType: "DEPOSIT",
                currency: "USD",
                status: "POSTED",
                needsReview: false,
              },
            ],
          })
        : json(null),
    );
    const res = await run("activity", "void", "a1", "--dry-run", "--wait");
    expect(res.code).toBe(0);
    expect(seen.some((r) => r.path === "/api/v1/events/stream")).toBe(false);
  });

  it("adds wait to sync output", async () => {
    server([event("portfolio:update-start"), event("portfolio:update-complete")]);
    const res = await run("sync", "--wait");
    expect(res.json()).toMatchObject({ queued: true, wait: { status: "complete" } });
  });
});

describe("plain-text error bodies", () => {
  it("reports a 422 body and points to wf schema", async () => {
    mockFetch(
      () =>
        new Response("Failed to deserialize the JSON body: missing field `accountType`", {
          status: 422,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
    );
    const res = await run("call", "create_account", "--args", '{"account":{}}');
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("missing field `accountType`");
    expect(res.stderr).toContain("wf schema create_account");
  });
});

describe("wf schema", () => {
  it("shows the switch hint and the caller's payload and result types", async () => {
    const info = (await run("schema", "update_alternative_asset_valuation")).json() as Record<
      string,
      string
    >;
    expect(info.payload).toBe("{ assetId: string; request: Record<string, unknown> }");
    expect(info.payloadType).toContain("value: string /* New value as decimal string */");
    expect(info.resultType).toContain("quoteId: string");
    expect(info.source).toMatch(/alternative-assets\.ts:\d+$/);
  });

  it("expands zod-inferred payloads", async () => {
    const info = (await run("schema", "create_account")).json() as Record<string, string>;
    expect(info.payloadType).toContain('accountType: "SECURITIES" | "CASH"');
  });

  it("falls back to the switch hint for commands without a typed caller", async () => {
    const info = (await run("schema", "sync_broker_activities")).json() as Record<string, unknown>;
    expect(info).toMatchObject({ payload: "none" });
    expect(info.payloadType).toBeUndefined();
  });

  it("exits 2 for an unknown command", async () => {
    expect((await run("schema", "nope")).code).toBe(2);
  });
});

describe("--wait auth failures", () => {
  it("a 401 from the event stream is an auth error (exit 3), and nothing is written", async () => {
    const seen = mockFetch((req) =>
      req.path === "/api/v1/events/stream"
        ? json({ error: "unauthorized" }, { status: 401 })
        : json(null),
    );
    const res = await run(...createArgs, "--wait");
    expect(res.code).toBe(3);
    expect(res.stderr).toContain("wf login");
    expect(seen.map((r) => r.path)).toEqual(["/api/v1/events/stream"]);
  });

  it("a locked profile on the event stream is an auth error with the profile hint", async () => {
    mockFetch(() => text("PROFILE_LOCKED: unlock the profile", 423));
    const res = await run(...createArgs, "--wait");
    expect(res.code).toBe(3);
    expect(res.stderr).toContain("wf profile list");
  });
});
