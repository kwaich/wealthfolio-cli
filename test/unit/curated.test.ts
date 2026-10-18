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

  it("drops category colours unless --full", async () => {
    const drift = {
      rows: [{ categoryId: "c1", color: "#fff", driftBps: 10 }],
      holdings: { rows: [{ symbol: "SAP", categoryColor: "#fff" }] },
    };
    server({ "POST /api/v1/allocation-targets/t1/drift": drift });
    expect((await run("rebalance", "--holdings")).json()).toMatchObject({
      drift: {
        rows: [{ categoryId: "c1", driftBps: 10 }],
        holdings: { rows: [{ symbol: "SAP" }] },
      },
    });
    expect(((await run("rebalance", "--full")).json() as { drift: unknown }).drift).toEqual(drift);
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

  it("drops the per-day totals unless --full", async () => {
    const report = {
      current: { outflow: 10 },
      spendingBreakdown: [{ categoryId: "cat_food", amount: 10 }],
      byDay: [{ date: "2026-01-01" }],
      byDayByCategory: [{ date: "2026-01-01", categoryId: "cat_food" }],
    };
    server({ "POST /api/v1/spending/report": report });
    expect((await run("spending", "report")).json()).toEqual({
      current: { outflow: 10 },
      spendingBreakdown: [{ categoryId: "cat_food", amount: 10 }],
    });
    expect((await run("spending", "report", "--full")).json()).toEqual(report);
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

  it("prints computed rows without ids, colours or empty categories unless --full", async () => {
    const category = (name: string, target: number, actual: number) => ({
      taxonomyId: "spending_categories",
      categoryId: `cat_${name}`,
      groupId: "g1",
      parentId: null,
      name,
      color: "#fff",
      icon: "Home",
      target,
      actual,
      rolloverIn: 0,
      rolloverOut: 0,
      remaining: target - actual,
      overspent: actual > target,
      hasDefaultTarget: false,
      hasMonthOverride: false,
      rolloverEnabled: false,
    });
    const budget = {
      state: { groups: [{ id: "g1", name: "Needs" }], groupAssignments: [], targets: [] },
      computed: {
        currency: "USD",
        periodKey: "2026-09",
        fxAsOf: "2026-09-30",
        groupRows: [
          {
            group: { id: "g1", name: "Needs", color: "#fff", createdAt: "x" },
            categoryTargetTotal: 500,
            buffer: 0,
            plannedTotal: 500,
            actual: 600,
            rolloverIn: 0,
            rolloverOut: 0,
            remaining: -100,
            overspent: true,
            rolloverEnabled: false,
            categories: [category("housing", 500, 600), category("bills", 0, 0)],
          },
        ],
        ungroupedRows: [],
        incomeRows: [category("salary", 0, 0)],
        totals: { spendingPlanned: 500, spendingActual: 600 },
      },
    };
    server({ "GET /api/v1/spending/budget": budget });
    expect((await run("budget")).json()).toEqual({
      periodKey: "2026-09",
      currency: "USD",
      totals: { spendingPlanned: 500, spendingActual: 600 },
      groups: [
        {
          name: "Needs",
          planned: 500,
          actual: 600,
          remaining: -100,
          overspent: true,
          categories: [
            {
              categoryId: "cat_housing",
              name: "housing",
              target: 500,
              actual: 600,
              remaining: -100,
              overspent: true,
            },
          ],
        },
      ],
      ungrouped: [],
      income: [],
    });
    expect((await run("budget", "--full")).json()).toEqual(budget);
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
