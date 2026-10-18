import { describe, expect, it } from "vitest";
import { isBrokerSynced, planStatus, statusUpdate } from "../../src/commands/activities";
import { json, mockFetch, run, useTempConfig, type Recorded } from "../helpers";

useTempConfig();

type Raw = Record<string, unknown> & { id: string; status: string };

const activity = (id: string, extra: Partial<Raw> = {}): Raw => ({
  id,
  accountId: "acc",
  activityType: "DEPOSIT",
  date: "2026-01-05T00:00:00+00:00",
  amount: "100",
  currency: "USD",
  comment: "note",
  status: "POSTED",
  needsReview: false,
  sourceSystem: "MANUAL",
  sourceRecordId: null,
  importRunId: null,
  ...extra,
});

/** Fake server: activities by id, transfer pairs, and records writes. */
function server(store: Raw[], pairs: [string, string][] = []) {
  const byId = new Map(store.map((a) => [a.id, a]));
  return mockFetch((req: Recorded) => {
    if (req.path === "/api/v1/activities/search") {
      const ids = (req.body as { activityIdFilter?: string[] }).activityIdFilter ?? [];
      const data = ids.flatMap((id) => (byId.has(id) ? [byId.get(id)] : []));
      return json({ data, meta: { totalRowCount: data.length } });
    }
    const pairMatch = req.path.match(/^\/api\/v1\/activities\/([^/]+)\/transfer-pair$/);
    if (pairMatch) {
      const id = decodeURIComponent(pairMatch[1]!);
      const pair = pairs.find((p) => p.includes(id));
      if (!pair) return json(null);
      const toModel = (a: Raw) => ({
        ...a,
        activityDate: a.date,
        notes: a.comment,
        date: undefined,
      });
      return json({
        transferOut: toModel(byId.get(pair[0])!),
        transferIn: toModel(byId.get(pair[1])!),
      });
    }
    if (req.method === "PUT" && req.path === "/api/v1/activities") {
      const body = req.body as { id: string; status: string };
      return json({ ...byId.get(body.id), ...body, activityDate: "x", notes: "note" });
    }
    if (req.method === "DELETE") return json(byId.get(req.path.split("/").pop()!) ?? null);
    return json(null);
  });
}

const writes = (seen: Recorded[]) =>
  seen.filter((r) => r.method === "PUT" || r.method === "DELETE");

describe("void and restore rules (as the MCP update tools)", () => {
  it.each([
    ["void", "POSTED", "VOID"],
    ["restore", "VOID", "POSTED"],
  ] as const)("%s turns %s into %s", (change, from, to) => {
    expect(planStatus(change, { id: "a", status: from })).toBe(to);
  });

  it.each([
    ["void", "VOID", "already void"],
    ["void", "DRAFT", "is a draft"],
    ["void", "PENDING", "is pending"],
    ["restore", "POSTED", "nothing to restore"],
    ["restore", "DRAFT", "nothing to restore"],
  ] as const)("%s refuses %s", (change, from, message) => {
    expect(planStatus(change, { id: "a", status: from })).toContain(message);
  });

  it("refuses one leg of a linked transfer whose legs differ in status", () => {
    expect(
      planStatus("void", { id: "a", status: "POSTED" }, { id: "b", status: "DRAFT" }),
    ).toContain("both legs share a status");
    expect(planStatus("void", { id: "a", status: "POSTED" }, { id: "b", status: "POSTED" })).toBe(
      "VOID",
    );
  });

  it("sends the stored required fields and notes, the status, and clears review on void", () => {
    const a = activity("a1", { activityType: "BUY", needsReview: true, quantity: "2" });
    expect(statusUpdate(a as never, "VOID")).toEqual({
      id: "a1",
      accountId: "acc",
      activityType: "BUY",
      activityDate: "2026-01-05T00:00:00+00:00",
      currency: "USD",
      notes: "note",
      status: "VOID",
      needsReview: false,
    });
    expect(statusUpdate(activity("a2", { comment: null }) as never, "POSTED")).toEqual({
      id: "a2",
      accountId: "acc",
      activityType: "DEPOSIT",
      activityDate: "2026-01-05T00:00:00+00:00",
      currency: "USD",
      status: "POSTED",
    });
  });

  it("uses the effective type of an activity model with an override", () => {
    const a = {
      ...activity("a"),
      date: undefined,
      activityDate: "d",
      activityTypeOverride: "CREDIT",
    };
    expect(statusUpdate(a as never, "VOID")).toMatchObject({
      activityType: "CREDIT",
      activityDate: "d",
    });
  });
});

describe("isBrokerSynced (as core)", () => {
  it.each([
    [{ sourceSystem: "SNAPTRADE", sourceRecordId: "r1" }, true],
    [{ sourceSystem: "SNAPTRADE", importRunId: "run" }, true],
    [{ sourceSystem: "SNAPTRADE" }, false],
    [{ sourceSystem: " csv ", importRunId: "run" }, false],
    [{ sourceSystem: "MANUAL", sourceRecordId: "r1" }, false],
    [{ sourceSystem: null, sourceRecordId: " " }, false],
  ])("%j -> %s", (fields, expected) => {
    expect(isBrokerSynced(activity("a", fields) as never)).toBe(expected);
  });
});

describe("wf activity void / restore", () => {
  it("voids a posted activity", async () => {
    const seen = server([activity("a1")]);
    const res = await run("activity", "void", "a1");
    expect(res.code).toBe(0);
    const [put] = writes(seen);
    // The vendored switch sends payload.activity as the HTTP body.
    expect(put!.body).toMatchObject({ id: "a1", status: "VOID", needsReview: false });
    expect(res.json()).toMatchObject({
      dryRun: false,
      rows: [{ status: "updated", newStatus: "VOID", activity: { status: "VOID" } }],
      summary: { total: 1, updated: 1 },
    });
  });

  it("--dry-run writes nothing", async () => {
    const seen = server([activity("a1")]);
    const res = await run("activity", "void", "a1", "--dry-run");
    expect(writes(seen)).toHaveLength(0);
    expect(res.json()).toMatchObject({
      dryRun: true,
      rows: [{ status: "ready", newStatus: "VOID" }],
    });
  });

  it("treats a pair as one row and refuses the other leg and unknown ids, exit 1", async () => {
    const seen = server(
      [
        activity("out", { activityType: "TRANSFER_OUT" }),
        activity("in", { activityType: "TRANSFER_IN" }),
      ],
      [["out", "in"]],
    );
    const res = await run("activity", "void", "in", "out", "ghost");
    expect(res.code).toBe(1);
    const { rows } = res.json() as {
      rows: { status: string; error?: string; linkedActivity?: { id: string } }[];
    };
    expect(rows.map((r) => r.status)).toEqual(["updated", "invalid", "invalid"]);
    expect(rows[0]!.linkedActivity!.id).toBe("out");
    expect(rows[1]!.error).toContain("already covered by row 0");
    expect(rows[2]!.error).toBe("Activity ghost not found");
    expect(writes(seen)).toHaveLength(1);
  });

  it("restores a void activity without touching the review flag", async () => {
    const seen = server([activity("a1", { status: "VOID" })]);
    expect((await run("activity", "restore", "a1")).code).toBe(0);
    const body = writes(seen)[0]!.body as Record<string, unknown>;
    expect(body.status).toBe("POSTED");
    expect(body).not.toHaveProperty("needsReview");
  });

  it("refuses to void a draft and writes nothing", async () => {
    const seen = server([activity("d1", { status: "DRAFT", needsReview: true })]);
    const res = await run("activity", "void", "d1");
    expect(res.code).toBe(1);
    expect((res.json() as { rows: { error: string }[] }).rows[0]!.error).toContain(
      "wf activity delete",
    );
    expect(writes(seen)).toHaveLength(0);
  });
});

describe("wf activity delete", () => {
  it("previews with the linked leg and counts both, without deleting", async () => {
    const seen = server([activity("out"), activity("in")], [["out", "in"]]);
    const res = await run("activity", "delete", "out", "--dry-run");
    expect(res.code).toBe(0);
    expect(writes(seen)).toHaveLength(0);
    expect(res.json()).toMatchObject({
      dryRun: true,
      rows: [
        { status: "ready", activity: { id: "out", notes: "note" }, linkedActivity: { id: "in" } },
      ],
      summary: { total: 1, ready: 1, activitiesDeleted: 2 },
    });
  });

  it("deletes ready rows and reports each", async () => {
    const seen = server([activity("a1"), activity("a2")]);
    const res = await run("activity", "delete", "a1", "a2");
    expect(res.code).toBe(0);
    expect(writes(seen).map((r) => `${r.method} ${r.path}`)).toEqual([
      "DELETE /api/v1/activities/a1",
      "DELETE /api/v1/activities/a2",
    ]);
    expect(res.json()).toMatchObject({ summary: { total: 2, deleted: 2, activitiesDeleted: 2 } });
  });

  it("warns that a broker sync may add a synced activity back", async () => {
    server([activity("s1", { sourceSystem: "SNAPTRADE", sourceRecordId: "x" })]);
    const res = await run("activity", "delete", "s1", "--dry-run");
    expect((res.json() as { rows: { warning: string }[] }).rows[0]!.warning).toContain(
      "wf activity void",
    );
  });

  it("refuses a repeated id and still deletes the first", async () => {
    const seen = server([activity("a1")]);
    const res = await run("activity", "delete", "a1", "a1");
    expect(res.code).toBe(1);
    expect(writes(seen)).toHaveLength(1);
  });

  it("reports a failed delete per row", async () => {
    mockFetch((req) => {
      if (req.path.endsWith("/search")) return json({ data: [activity("a1")], meta: {} });
      if (req.method === "DELETE") return json({ message: "Record not found" }, { status: 404 });
      return json(null);
    });
    const res = await run("activity", "delete", "a1");
    expect(res.code).toBe(1);
    expect(res.json()).toMatchObject({ rows: [{ status: "failed", error: "Record not found" }] });
  });

  it.each([[[]], [Array.from({ length: 101 }, (_, i) => `a${i}`)], [[" "]]])(
    "exits 2 for a bad id list",
    async (ids) => {
      const seen = server([]);
      expect((await run("activity", "delete", ...ids)).code).toBe(2);
      expect(seen).toHaveLength(0);
    },
  );
});

describe("wf activity search", () => {
  it("maps flags to the search body", async () => {
    const seen = mockFetch(() => json({ data: [], meta: { totalRowCount: 0 } }));
    const res = await run(
      "activity",
      "search",
      "--account",
      "a1",
      "--type",
      "buy",
      "--type",
      "credit",
      "--from",
      "2026-01-01",
      "--to",
      "2026-02-01",
      "--needs-review",
      "--asset",
      "AAPL",
      "--page",
      "2",
      "--page-size",
      "10",
    );
    expect(res.code).toBe(0);
    expect(seen[0]).toMatchObject({ method: "POST", path: "/api/v1/activities/search" });
    expect(seen[0]!.body).toEqual({
      page: 2,
      pageSize: 10,
      accountIdFilter: ["a1"],
      activityTypeFilter: ["BUY", "CREDIT"],
      assetIdKeyword: "AAPL",
      dateFrom: "2026-01-01",
      dateTo: "2026-02-01",
      needsReviewFilter: true,
      sort: { id: "date", desc: true },
    });
  });

  it("--reviewed sends needsReviewFilter false", async () => {
    const seen = mockFetch(() => json({ data: [], meta: {} }));
    await run("activity", "search", "--reviewed");
    expect((seen[0]!.body as Record<string, unknown>).needsReviewFilter).toBe(false);
  });

  it("rejects an unknown type", async () => {
    mockFetch(() => json({ data: [] }));
    expect((await run("activity", "search", "--type", "GIFT")).code).toBe(2);
  });
});

describe("reads and health", () => {
  it("accounts --all asks for archived accounts", async () => {
    const seen = mockFetch(() => json([]));
    await run("accounts", "--all");
    expect(seen[0]!.path).toBe("/api/v1/accounts?includeArchived=true");
  });

  it("holdings uses an all or account scope", async () => {
    const seen = mockFetch(() => json([]));
    await run("holdings");
    await run("holdings", "--account", "a1", "--include-closed");
    expect(seen[0]).toMatchObject({ method: "POST", body: { filter: { type: "all" } } });
    expect(seen[1]!.path).toBe("/api/v1/holdings?accountId=a1&includeClosed=true");
  });

  it("health reads the cached status", async () => {
    const seen = mockFetch(() => json({ overallSeverity: "INFO", issues: [] }));
    await run("health");
    expect(seen.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /api/v1/health/status"]);
  });

  it("health --refresh runs the checks in the app's configured timezone", async () => {
    const seen = mockFetch((req) =>
      req.path === "/api/v1/settings" ? json({ timezone: "Asia/Hong_Kong" }) : json({ issues: [] }),
    );
    await run("health", "--refresh");
    const check = seen.find((r) => r.path === "/api/v1/health/check")!;
    expect(check.method).toBe("POST");
    expect(check.headers["x-client-timezone"]).toBe("Asia/Hong_Kong");
  });
});
