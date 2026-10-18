import { describe, expect, it, vi } from "vitest";
import { targetFilter } from "../../src/commands/curated";
import { today } from "../../src/commands/args";
import { json, mockFetch, run, useTempConfig, type Recorded } from "../helpers";

useTempConfig();

const TARGETS = [
  { id: "t1", name: "Core", scopeType: "account", scopeId: "acc-1", archivedAt: null },
  { id: "t0", name: "Old", scopeType: "all", scopeId: null, archivedAt: "2026-01-01" },
];

function server(routes: Record<string, unknown> = {}) {
  return mockFetch((req: Recorded) => {
    const key = `${req.method} ${req.path.split("?")[0]}`;
    if (key in routes) return json(routes[key]);
    if (key === "GET /api/v1/allocation-targets") return json(TARGETS);
    return json({ ok: true });
  });
}

describe("wf sync", () => {
  it("syncs every asset when no --asset is given, and calls nothing else", async () => {
    const seen = server();
    const res = await run("sync");
    expect(res.code).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      method: "POST",
      path: "/api/v1/market-data/sync",
      body: { refetchAll: false },
    });
    expect(res.json()).toEqual({ queued: true });
  });

  it("passes assets and refetch flags", async () => {
    const seen = server();
    await run("sync", "--asset", "AAPL", "--asset", "MSFT", "--recent-days", "30");
    expect(seen[0]!.body).toEqual({
      assetIds: ["AAPL", "MSFT"],
      refetchAll: false,
      refetchRecentDays: 30,
    });
  });

  it("rejects a bad --recent-days with exit 2", async () => {
    server();
    expect((await run("sync", "--recent-days", "x")).code).toBe(2);
  });
});

describe("wf rebalance", () => {
  it("uses the only active target and its account scope for drift", async () => {
    const seen = server();
    const res = await run("rebalance");
    expect(res.code).toBe(0);
    const drift = seen[1]!;
    expect(drift).toMatchObject({ method: "POST", path: "/api/v1/allocation-targets/t1/drift" });
    expect(drift.body).toEqual({
      filter: { type: "account", accountId: "acc-1" },
      includeHoldings: false,
    });
    expect(seen).toHaveLength(2);
    expect(res.json()).toMatchObject({ target: { id: "t1", name: "Core" } });
  });

  it("adds a plan with --cash, with sorted unique asset ids", async () => {
    const seen = server();
    await run(
      "rebalance",
      "--target",
      "Core",
      "--cash",
      "1500.5",
      "--mode",
      "hybrid",
      "--asset",
      "b",
      "--asset",
      "a",
      "--asset",
      "b",
    );
    expect(seen[2]).toMatchObject({
      method: "POST",
      path: "/api/v1/allocation-targets/rebalance/calculate",
      body: {
        targetId: "t1",
        availableCash: 1500.5,
        filter: { type: "account", accountId: "acc-1" },
        scenarioMode: "hybrid",
        eligibleAssetIds: ["a", "b"],
      },
    });
  });

  it("exits 2 when several targets are active and none is picked", async () => {
    server({
      "GET /api/v1/allocation-targets": [
        { ...TARGETS[0], archivedAt: null },
        { id: "t2", name: "Other", scopeType: "all", archivedAt: null },
      ],
    });
    const res = await run("rebalance");
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("--target");
  });

  it("rejects an unknown --mode", async () => {
    server();
    expect((await run("rebalance", "--mode", "yolo")).code).toBe(2);
  });

  it("maps target scopes like the web app", () => {
    expect(targetFilter({ id: "", name: "", scopeType: "all" })).toEqual({ type: "all" });
    expect(targetFilter({ id: "", name: "", scopeType: "portfolio", scopeId: "p" })).toEqual({
      type: "portfolio",
      portfolioId: "p",
    });
  });
});

describe("wf spending report", () => {
  it("sends the request object with dates and accounts", async () => {
    const seen = server();
    await run(
      "spending",
      "report",
      "--from",
      "2026-01-01",
      "--to",
      "2026-03-31",
      "--account",
      "a1",
    );
    expect(seen[0]).toMatchObject({
      method: "POST",
      path: "/api/v1/spending/report",
      body: { startDate: "2026-01-01", endDate: "2026-03-31", accountIds: ["a1"] },
    });
  });

  it("defaults to this month so far", async () => {
    vi.useFakeTimers({ now: new Date(2026, 9, 18, 12) });
    try {
      const seen = server();
      await run("spending", "report");
      expect(seen[0]!.body).toEqual({ startDate: "2026-10-01", endDate: "2026-10-18" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts at the first day of the --to month without --from", async () => {
    vi.useFakeTimers({ now: new Date(2026, 9, 18, 12) });
    try {
      const seen = server();
      expect((await run("spending", "report", "--to", "2026-01-31")).code).toBe(0);
      expect(seen[0]!.body).toEqual({ startDate: "2026-01-01", endDate: "2026-01-31" });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    [["--from", "2026-13-40"]],
    [["--from", "2026-02-30"]],
    [["--from", "2026-05-01", "--to", "2026-04-01"]],
  ])("exits 2 for bad dates %j", async (args) => {
    server();
    expect((await run("spending", "report", ...args)).code).toBe(2);
  });
});

describe("wf budget", () => {
  it("sends periodKey as a query", async () => {
    const seen = server();
    await run("budget", "--period", "2026-09");
    expect(seen[0]!.path).toBe("/api/v1/spending/budget?periodKey=2026-09");
  });

  it("omits periodKey by default", async () => {
    const seen = server();
    await run("budget");
    expect(seen[0]!.path).toBe("/api/v1/spending/budget");
  });

  it("rejects a bad month", async () => {
    server();
    expect((await run("budget", "--period", "2026-9")).code).toBe(2);
  });
});

describe("wf alt-asset value", () => {
  it("PUTs the valuation with the amount as a decimal string", async () => {
    const seen = server();
    await run(
      "alt-asset",
      "value",
      "house-1",
      "850000.00",
      "--date",
      "2026-06-30",
      "--notes",
      "appraisal",
    );
    expect(seen[0]).toMatchObject({
      method: "PUT",
      path: "/api/v1/alternative-assets/house-1/valuation",
      body: { value: "850000.00", date: "2026-06-30", notes: "appraisal" },
    });
  });

  it("defaults the date to today", async () => {
    const seen = server();
    await run("alt-asset", "value", "car", "12000");
    expect(seen[0]!.body).toEqual({ value: "12000", date: today() });
  });

  it("rejects a non-decimal amount", async () => {
    const seen = server();
    expect((await run("alt-asset", "value", "car", "12k")).code).toBe(2);
    expect(seen).toHaveLength(0);
  });
});
