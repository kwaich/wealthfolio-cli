// End-to-end against a real server (scripts/test-server.sh up), through the
// built binary. Needs `pnpm build` first.
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

async function eventually<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (ok(value) || Date.now() > end) return value;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

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

  it("records an activity and reads holdings", async () => {
    const activity = await call<{ id: string; activityType: string }>("create_activity", {
      activity: {
        accountId,
        activityType: "DEPOSIT",
        activityDate: "2026-01-05",
        amount: "1000",
        currency: "USD",
      },
    });
    expect(activity.activityType).toBe("DEPOSIT");
    activityId = activity.id;
    // Valuation runs in the background after the write.
    const holdings = await eventually(
      () =>
        call<{ holdingType: string }[]>("get_holdings", {
          filter: { type: "account", accountId },
        }),
      (h) => h.length > 0,
    );
    expect(holdings.map((h) => h.holdingType)).toContain("cash");
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
    const voided = await wfJson<{ rows: { activity: { status: string; notes: string | null } }[] }>(
      "activity",
      "void",
      activityId,
    );
    expect(voided.rows[0]!.activity.status).toBe("VOID");
    expect(await eventually(cash, (n) => n === 0)).toBe(0);
    const again = await wf(["activity", "void", activityId]);
    expect(again.code).toBe(1);
    expect(again.stdout).toContain("already void");
    await wfJson("activity", "restore", activityId);
    expect(await eventually(cash, (n) => n > 0)).toBeGreaterThan(0);
    const found = await wfJson<{ data: { id: string; status: string; tax: unknown }[] }>(
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
    expect(await wfJson("sync")).toEqual({ queued: true });
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

  it("logout ends the session", async () => {
    expect((await wf(["logout"])).code).toBe(0);
    const status = await wfJson<{ authenticated: boolean }>("status");
    expect(status.authenticated).toBe(false);
    expect((await wf(["call", "get_accounts"])).code).toBe(3);
  });
});
