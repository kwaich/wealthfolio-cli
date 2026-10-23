import { describe, expect, it } from "vitest";
import { UPSTREAM_TAG } from "../../src/contract";
import { print, renderTable } from "../../src/output";
import { json, mockFetch, run, useTempConfig } from "../helpers";

useTempConfig();

function server(version: string) {
  return mockFetch((req) => {
    if (req.path === "/api/v1/auth/status")
      return json({ requiresPassword: false, oidcEnabled: false });
    if (req.path === "/api/v1/auth/me") return json({ authenticated: true });
    if (req.path === "/api/v1/app/info") return json({ version });
    return json(null);
  });
}

describe("wf status", () => {
  it("reports no warning when the server matches UPSTREAM_TAG", async () => {
    server(UPSTREAM_TAG.slice(1));
    const res = await run("status");
    expect(res.code).toBe(0);
    expect(res.json()).toMatchObject({
      serverVersion: UPSTREAM_TAG.slice(1),
      upstreamTag: UPSTREAM_TAG,
      warnings: [],
    });
    expect(res.stderr).toBe("");
  });

  it("warns when the server version differs from UPSTREAM_TAG", async () => {
    server("0.0.1");
    const res = await run("status");
    expect(res.stderr).toContain(`differs from the vendored contract ${UPSTREAM_TAG}`);
    expect((res.json() as { warnings: string[] }).warnings).toHaveLength(1);
  });

  it("exits 1 when the server is down", async () => {
    mockFetch(() => Promise.reject(new TypeError("fetch failed")));
    const res = await run("status");
    expect(res.code).toBe(1);
    expect(res.json()).toMatchObject({ reachable: false });
  });

  it("exits 2 without a configured URL", async () => {
    process.env.WF_URL = "";
    const res = await run("status");
    expect(res.code).toBe(2);
    expect(res.stderr).toContain("wf login --url");
  });
});

describe("json output", () => {
  it("is one compact line", () => {
    let out = "";
    print({ a: [1, { b: null }] }, {}, (text) => (out += text));
    expect(out).toBe('{"a":[1,{"b":null}]}\n');
  });
});

describe("--table", () => {
  it("renders rows with the union of keys", () => {
    expect(
      renderTable([
        { a: 1, b: "x" },
        { a: 2, c: { d: 1 } },
      ]),
    ).toBe(["a  b  c", "-  -  -------", "1  x", '2     {"d":1}'].join("\n"));
  });

  it("renders an object as key/value", () => {
    expect(renderTable({ k: "v" })).toBe(["key  value", "---  -----", "k    v"].join("\n"));
  });

  it("is a global flag", async () => {
    mockFetch(() => json([{ id: "a1", name: "Cash" }]));
    const res = await run("--table", "call", "get_accounts");
    expect(res.stdout).toContain("id  name");
  });
});

describe("server URL resolution", () => {
  it("falls back to the config file when WF_URL is set but empty", async () => {
    const { writeFileSync } = await import("node:fs");
    process.env.WF_URL = "";
    writeFileSync(
      `${process.env.WF_CONFIG_DIR}/config.json`,
      JSON.stringify({ url: "http://wf.test" }),
    );
    const seen = mockFetch(() => json([]));
    expect((await run("call", "get_accounts")).code).toBe(0);
    expect(seen[0]!.url).toBe("http://wf.test/api/v1/accounts");
  });

  it("keeps a reverse-proxy path prefix", async () => {
    process.env.WF_URL = "https://host.example/wealthfolio/";
    const seen = mockFetch(() => json([]));
    await run("call", "get_accounts");
    expect(seen[0]!.url).toBe("https://host.example/wealthfolio/api/v1/accounts");
  });
});
