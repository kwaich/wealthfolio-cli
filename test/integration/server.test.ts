// End-to-end against a real server (scripts/test-server.sh up, which turns on
// the /mcp endpoint), through the built binary. Needs `pnpm build` first.
//
//   WF_TEST_URL, WF_TEST_PASSWORD  required
//   WF_TEST_REFRESH=1              also check the sliding-session refresh
//                                  (server must run with a 1-minute TTL; adds ~35 s)
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const URL = process.env.WF_TEST_URL;
const PASSWORD = process.env.WF_TEST_PASSWORD;
const BIN = join(process.cwd(), "dist/wf.js");
const configDir = mkdtempSync(join(tmpdir(), "wf-it-"));

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

async function wf(args: string[], env: Record<string, string> = {}): Promise<Result> {
  try {
    const { stdout, stderr } = await exec("node", [BIN, ...args], {
      env: { ...process.env, WF_CONFIG_DIR: configDir, WF_URL: "", WF_TOKEN: "", ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

/** Runs wf and parses stdout; fails the test on a non-zero exit. */
async function wfJson<T = unknown>(...args: string[]): Promise<T> {
  const res = await wf(args);
  expect(res.code, `wf ${args.join(" ")}\n${res.stderr}`).toBe(0);
  return JSON.parse(res.stdout) as T;
}

const call = <T = unknown>(command: string, args?: unknown) =>
  wfJson<T>("call", command, ...(args === undefined ? [] : ["--args", JSON.stringify(args)]));

const session = () =>
  JSON.parse(readFileSync(join(configDir, "session.json"), "utf8")) as { token: string };

describe.skipIf(!URL || !PASSWORD)("against a live server", () => {
  let accountId = "";
  let activityId = "";

  beforeAll(async () => {
    // The server allows 5 logins per minute per IP; log in once.
    const res = await wf(["login", "--url", URL!], { WF_PASSWORD: PASSWORD! });
    expect(res.code, res.stderr).toBe(0);
    expect(JSON.parse(res.stdout)).toMatchObject({
      authenticated: true,
      profile: { name: expect.any(String) },
    });
  });

  afterAll(async () => {
    if (accountId) await wf(["call", "delete_account", "--args", JSON.stringify({ accountId })]);
    rmSync(configDir, { recursive: true, force: true });
  });

  it("status: logged in, version matches UPSTREAM_TAG", async () => {
    const status = await wfJson<{
      authenticated: boolean;
      serverVersion: string;
      warnings: string[];
    }>("status");
    const tag = readFileSync("UPSTREAM_TAG", "utf8").trim();
    expect(status.authenticated).toBe(true);
    expect(status.serverVersion).toBe(tag.replace(/^v/, ""));
    expect(status.warnings).toEqual([]);
  });

  it("creates an account", async () => {
    // A fresh server has no base currency until onboarding; holdings need one.
    await call("update_settings", {
      settingsUpdate: { baseCurrency: "USD", timezone: "UTC", onboardingCompleted: true },
    });
    const account = await call<{ id: string; name: string }>("create_account", {
      account: {
        name: "wf integration",
        accountType: "SECURITIES",
        currency: "USD",
        isDefault: false,
        isActive: true,
        isArchived: false,
        trackingMode: "TRANSACTIONS",
      },
    });
    expect(account.name).toBe("wf integration");
    accountId = account.id;
    const accounts = await call<{ id: string }[]>("get_accounts");
    expect(accounts.map((a) => a.id)).toContain(accountId);
  });

  it("records an activity, waits for the recalculation, and reads holdings", async () => {
    const created = await wfJson<{
      result: { id: string; activityType: string };
      wait: { status: string };
    }>(
      "call",
      "create_activity",
      "--wait",
      "--wait-timeout",
      "60",
      "--args",
      JSON.stringify({
        activity: {
          accountId,
          activityType: "DEPOSIT",
          activityDate: "2026-01-05",
          amount: "1000",
          currency: "USD",
        },
      }),
    );
    expect(created.result.activityType).toBe("DEPOSIT");
    expect(created.wait.status).toBe("complete");
    activityId = created.result.id;
    // No polling: --wait returned after the recalculation.
    const holdings = await wfJson<{ holdingType: string }[]>("holdings", "--account", accountId);
    expect(holdings.map((h) => h.holdingType)).toContain("cash");
  });

  it("schema describes create_activity, and a bad payload names the missing field", async () => {
    const info = await wfJson<{ payloadType: string }>("schema", "create_activity");
    expect(info.payloadType).toContain("accountId: string");
    const bad = await wf(["call", "create_account", "--args", '{"account":{"name":"x"}}']);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/missing field `\w+`/);
    expect(bad.stderr).toContain("wf schema create_account");
  });

  it("updates the activity through the server's MCP tools, after a preview", async () => {
    const token = await wfJson<{ scopes: string[]; mcp: { ok: boolean } }>(
      "agent-token",
      "create",
      "--expires-days",
      "1",
    );
    expect(token.mcp.ok).toBe(true);
    expect(token.scopes).toContain("activities:write");

    const preview = await wfJson<{
      rows: { status: string; changes: { field: string; current: unknown; proposed: unknown }[] }[];
    }>("activity", "update", activityId, "--amount", "1200", "--notes", "corrected", "--dry-run");
    expect(preview.rows[0]!.status).toBe("ready");
    expect(preview.rows[0]!.changes).toEqual(
      expect.arrayContaining([
        { field: "amount", current: "1000", proposed: "1200" },
        { field: "notes", current: null, proposed: "corrected" },
      ]),
    );
    const same = await wf(["activity", "update", activityId, "--amount", "1000", "--dry-run"]);
    expect(same.code).toBe(1);
    expect(same.stdout).toContain("Nothing to change");

    const applied = await wfJson<{
      updated: { changes: { field: string; after: unknown }[] }[];
      errors: unknown[];
      wait: { status: string };
    }>("activity", "update", activityId, "--amount", "1200", "--wait", "--wait-timeout", "60");
    expect(applied.errors).toEqual([]);
    expect(applied.updated[0]!.changes).toContainEqual(
      expect.objectContaining({ field: "amount", after: "1200" }),
    );
    expect(applied.wait.status).toBe("complete");
    const holdings = await wfJson<{ holdingType: string; quantity: number }[]>(
      "holdings",
      "--account",
      accountId,
    );
    expect(holdings.find((h) => h.holdingType === "cash")!.quantity).toBe(1200);
  });

  it("voids and restores the activity; holdings follow", async () => {
    const cash = async () =>
      (await wfJson<{ holdingType: string }[]>("holdings", "--account", accountId)).length;
    const preview = await wfJson<{ rows: { status: string; newStatus: string }[] }>(
      "activity",
      "void",
      activityId,
      "--dry-run",
    );
    expect(preview.rows[0]).toMatchObject({ status: "ready", newStatus: "VOID" });
    const voided = await wfJson<{
      rows: { activity: { status: string } }[];
      wait: { status: string };
    }>("activity", "void", activityId, "--wait", "--wait-timeout", "60");
    expect(voided.rows[0]!.activity.status).toBe("VOID");
    expect(voided.wait.status).toBe("complete");
    expect(await cash()).toBe(0);
    const again = await wf(["activity", "void", activityId]);
    expect(again.code).toBe(1);
    expect(again.stdout).toContain("already void");
    await wfJson("activity", "restore", activityId, "--wait", "--wait-timeout", "60");
    expect(await cash()).toBeGreaterThan(0);
    const found = await wfJson<{ data: { id: string; status: string }[] }>(
      "activity",
      "search",
      "--id",
      activityId,
    );
    expect(found.data[0]).toMatchObject({ id: activityId, status: "POSTED" });
  });

  it("deletes the activity after a preview", async () => {
    const preview = await wfJson<{ summary: { ready: number } }>(
      "activity",
      "delete",
      activityId,
      "--dry-run",
    );
    expect(preview.summary.ready).toBe(1);
    const deleted = await wfJson<{ rows: { status: string; activity: { id: string } }[] }>(
      "activity",
      "delete",
      activityId,
    );
    expect(deleted.rows[0]).toMatchObject({ status: "deleted", activity: { id: activityId } });
    const again = await wf(["activity", "delete", activityId]);
    expect(again.code).toBe(1);
    expect(again.stdout).toContain("not found");
  });

  it("runs the health checks", async () => {
    const health = await wfJson<{ checkedAt: string; issues: unknown[] }>("health", "--refresh");
    expect(health.checkedAt).toBeTruthy();
    expect(Array.isArray(health.issues)).toBe(true);
  });

  it("runs the other curated read commands", async () => {
    expect(await wfJson("sync", "--wait", "--wait-timeout", "60")).toMatchObject({
      queued: true,
      wait: { status: "complete" },
    });
    expect(await wfJson("budget")).toHaveProperty("state");
    expect(
      await wfJson("spending", "report", "--from", "2026-01-01", "--to", "2026-01-31"),
    ).toHaveProperty("current");
    const rebalance = await wf(["rebalance"]);
    expect(rebalance.code).toBe(2);
    expect(rebalance.stderr).toContain("No active allocation targets");
  });

  it("guards against a missing id", async () => {
    const res = await wf(["call", "delete_account", "--args", "{}"]);
    expect(res.code).toBe(2);
  });

  it.runIf(process.env.WF_TEST_REFRESH === "1")(
    "stores the token the server refreshes after half the TTL",
    async () => {
      const before = session().token;
      await new Promise((r) => setTimeout(r, 35_000));
      await call("get_accounts");
      expect(session().token).not.toBe(before);
      await call("get_accounts");
    },
    60_000,
  );

  it("revokes the agent token", async () => {
    expect(await wfJson("agent-token", "delete")).toMatchObject({ deleted: true, revoked: true });
    const res = await wf(["activity", "update", activityId || "x", "--fee", "1", "--dry-run"]);
    expect(res.code).toBe(3);
  });

  it("logout ends the session", async () => {
    expect((await wf(["logout"])).code).toBe(0);
    const status = await wfJson<{ authenticated: boolean }>("status");
    expect(status.authenticated).toBe(false);
    expect((await wf(["call", "get_accounts"])).code).toBe(3);
  });
});
