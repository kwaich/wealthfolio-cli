// Request shapes for a sample of commands. Expected values are read off the
// vendored invoke switch (vendor/upstream/<tag>/adapters/web/core.ts).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { COMMANDS, PAYLOADS, UPSTREAM_TAG } from "../../src/contract";
import { json, mockFetch, run, useTempConfig } from "../helpers";

useTempConfig();

async function call(command: string, args?: unknown) {
  const seen = mockFetch(() => json({ ok: true }));
  const res = await run(
    "call",
    command,
    ...(args === undefined ? [] : ["--args", JSON.stringify(args)]),
  );
  expect(res.stderr).toBe("");
  expect(res.code).toBe(0);
  expect(seen).toHaveLength(1);
  return seen[0]!;
}

describe("wf call builds the request the vendored switch builds", () => {
  it("get_accounts: GET with includeArchived query", async () => {
    const req = await call("get_accounts", { includeArchived: true });
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/api/v1/accounts?includeArchived=true");
    expect(req.body).toBeUndefined();
  });

  it("update_account: id in path, accountUpdate as body", async () => {
    const accountUpdate = { id: "a1", name: "Brokerage", currency: "USD" };
    const req = await call("update_account", { accountUpdate });
    expect(req.method).toBe("PUT");
    expect(req.path).toBe("/api/v1/accounts/a1");
    expect(req.body).toEqual(accountUpdate);
    expect(req.headers["content-type"]).toBe("application/json");
  });

  it("delete_activity: DELETE with the encoded id in the path", async () => {
    const req = await call("delete_activity", { activityId: "x/1" });
    expect(req.method).toBe("DELETE");
    expect(req.path).toBe("/api/v1/activities/x%2F1");
  });

  it("get_holdings: POST body for a portfolio scope", async () => {
    const filter = { type: "portfolio", portfolioId: "pf1" };
    const req = await call("get_holdings", { filter });
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/api/v1/holdings/query");
    expect(req.body).toEqual({ filter });
  });

  it("get_holdings: switches to GET with a query for one account", async () => {
    const req = await call("get_holdings", {
      filter: { type: "account", accountId: "a1" },
      includeClosed: true,
    });
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/api/v1/holdings?accountId=a1&includeClosed=true");
  });

  it("get_budget: periodKey query", async () => {
    const req = await call("get_budget", { periodKey: "2026-09" });
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/api/v1/spending/budget?periodKey=2026-09");
  });

  it("list_cash_activities: array filters become key[] params", async () => {
    const req = await call("list_cash_activities", {
      filter: { startDate: "2026-01-01", accountIds: ["a", "b"], nested: { x: 1 } },
    });
    expect(req.path).toBe(
      "/api/v1/spending/cash-activities?startDate=2026-01-01&accountIds%5B%5D=a&accountIds%5B%5D=b",
    );
  });

  it("calculate_rebalance_plan: omits eligibleAssetIds when not given", async () => {
    const req = await call("calculate_rebalance_plan", {
      targetId: "t1",
      availableCash: 500,
      filter: { type: "all" },
      scenarioMode: "hybrid",
    });
    expect(req.path).toBe("/api/v1/allocation-targets/rebalance/calculate");
    expect(req.body).toEqual({
      targetId: "t1",
      availableCash: 500,
      filter: { type: "all" },
      scenarioMode: "hybrid",
    });
  });

  it("run_health_checks: sends X-Client-Timezone", async () => {
    const req = await call("run_health_checks", { clientTimezone: "Asia/Hong_Kong" });
    expect(req.headers["x-client-timezone"]).toBe("Asia/Hong_Kong");
  });

  it("get_app_info: no payload", async () => {
    const req = await call("get_app_info");
    expect(req).toMatchObject({ method: "GET", path: "/api/v1/app/info" });
  });
});

describe("wf call input handling", () => {
  it("reads --args-file", async () => {
    const seen = mockFetch(() => json(null));
    const file = `${process.env.WF_CONFIG_DIR}/args.json`;
    (await import("node:fs")).writeFileSync(file, JSON.stringify({ activityId: "z" }));
    expect((await run("call", "delete_activity", "--args-file", file)).code).toBe(0);
    expect(seen[0]!.path).toBe("/api/v1/activities/z");
  });

  it.each([
    [["call", "get_accounts", "--args", "{bad"], "Invalid JSON"],
    [["call", "get_accounts", "--args", "[1]"], "must be a JSON object"],
    [["call", "no_such_command"], "Unknown command"],
    [["call", "get_accounts", "--args", "{}", "--args-file", "x"], "not both"],
    [["call", "update_account", "--args", "{}"], "Bad arguments"],
    [["call", "delete_account", "--args", "{}"], "Refusing to send /api/v1/accounts/undefined"],
  ])("exits 2 for %j", async (args, message) => {
    const seen = mockFetch(() => json(null));
    const res = await run(...args);
    expect(res.code).toBe(2);
    expect(res.stderr).toContain(message);
    expect(seen).toHaveLength(0);
  });

  it("prints null for an empty response", async () => {
    mockFetch(() => new Response(null, { status: 204 }));
    const res = await run("call", "delete_activity", "--args", '{"activityId":"a"}');
    expect(res.stdout).toBe("null\n");
  });

  it("exits 1 with the server message on an API error", async () => {
    mockFetch(() => json({ code: "NOT_FOUND", message: "Record not found" }, { status: 404 }));
    const res = await run("call", "get_activity_assignments", "--args", '{"activityId":"a"}');
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("Record not found");
  });

  it("keeps upstream's console.error quiet unless WF_DEBUG is set", async () => {
    const spy = vi.spyOn(console, "error");
    mockFetch(() => json({ message: "boom" }, { status: 500 }));
    await run("call", "get_accounts");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("wf commands", () => {
  it("lists every command in the COMMANDS map with its payload hint", async () => {
    const res = await run("commands");
    const rows = res.json() as { name: string; method: string; path: string; payload: string }[];
    expect(rows.map((r) => r.name)).toEqual(Object.keys(COMMANDS));
    expect(rows.find((r) => r.name === "delete_activity")).toEqual({
      name: "delete_activity",
      method: "DELETE",
      path: "/activities",
      payload: "{ activityId: string }",
    });
  });

  it("filters by name", async () => {
    const rows = (await run("commands", "--filter", "budget_group")).json() as { name: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.name.includes("budget_group"))).toBe(true);
  });

  it("has a payload hint for every switch case, and no hint for unknown names", () => {
    for (const name of Object.keys(PAYLOADS)) expect(COMMANDS).toHaveProperty(name);
  });
});

describe("vendored contract", () => {
  const source = JSON.parse(
    readFileSync(`vendor/upstream/${UPSTREAM_TAG}/SOURCE.json`, "utf8"),
  ) as { tag: string; files: Record<string, string> };

  it("UPSTREAM_TAG file matches src/contract.ts and SOURCE.json", () => {
    expect(readFileSync("UPSTREAM_TAG", "utf8").trim()).toBe(UPSTREAM_TAG);
    expect(source.tag).toBe(UPSTREAM_TAG);
  });

  it("vendored files are byte-identical to what vendor.sh copied", () => {
    for (const [upstreamPath, sum] of Object.entries(source.files)) {
      const local = upstreamPath.replace("apps/frontend/src/", `vendor/upstream/${UPSTREAM_TAG}/`);
      expect(createHash("sha256").update(readFileSync(local)).digest("hex"), local).toBe(sum);
    }
  });
});
