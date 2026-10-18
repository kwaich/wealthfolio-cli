import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { main } from "../src/main";

export interface Recorded {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export type Handler = (req: Recorded) => Response | Promise<Response>;

export const BASE = "http://wf.test";

export function json(value: unknown, init: ResponseInit & { cookies?: string[] } = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  for (const c of init.cookies ?? []) headers.append("set-cookie", c);
  return new Response(value === undefined ? null : JSON.stringify(value), { ...init, headers });
}

export function text(body: string, status: number): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}

/** Replaces global fetch. Returns the list of requests it saw. */
export function mockFetch(handler: Handler): Recorded[] {
  const seen: Recorded[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const raw = init.body;
    let body: unknown = raw;
    if (typeof raw === "string") {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    const req: Recorded = {
      method: init.method ?? "GET",
      url,
      path: url.slice(BASE.length),
      headers,
      body,
    };
    seen.push(req);
    return handler(req);
  });
  return seen;
}

/** Fresh config dir per test, with WF_URL pointing at the fake server. */
export function useTempConfig(): { dir: () => string } {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wf-test-"));
    vi.stubEnv("WF_CONFIG_DIR", dir);
    vi.stubEnv("WF_URL", BASE);
    vi.stubEnv("WF_TOKEN", "");
    vi.stubEnv("WF_PASSWORD", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
    process.exitCode = undefined;
  });
  return { dir: () => dir };
}

/** Runs `wf ...args` in-process and captures stdout, stderr and the exit code. */
export async function run(...args: string[]) {
  let stdout = "";
  let stderr = "";
  const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  try {
    const code = await main(["node", "wf", ...args]);
    return { code, stdout, stderr, json: () => JSON.parse(stdout) as unknown };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}
