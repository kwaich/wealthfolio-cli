import { ServerError, UsageError } from "./errors";

export const SESSION_COOKIE = "wf_session";
/** Owner cookie the server sets when it runs without authentication. */
export const BROWSER_COOKIE = "wf_browser";
export const PROFILE_SCOPE_HEADER = "x-wf-profile-scope";

/** Mutable connection state shared by the CLI and the shimmed profileFetch. */
export interface TransportState {
  /** Server root, for example https://wf.example.com (no /api/v1). */
  baseUrl: string;
  token?: string;
  /** Profile session scope from get_profile_state or unlock_profile. */
  scopeId?: string;
  browserId?: string;
}

export interface Transport {
  state: TransportState;
  /** Called after a response changed token or browserId. */
  onChange?: (state: TransportState) => void;
}

let current: Transport | undefined;

export function setTransport(transport: Transport | undefined): void {
  current = transport;
}

export function getTransport(): Transport {
  if (!current) throw new Error("Transport not configured");
  return current;
}

export function joinUrl(baseUrl: string, path: string): string {
  return baseUrl.replace(/\/+$/, "") + (path.startsWith("/") ? path : `/${path}`);
}

/** Reads `name=value` pairs out of Set-Cookie headers. Empty values mean "cleared". */
export function parseSetCookies(headers: Headers): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of headers.getSetCookie()) {
    const pair = line.split(";", 1)[0] ?? "";
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    out.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return out;
}

/**
 * The vendored invoke puts payload values into URLs with template strings, so
 * a missing key becomes the text "undefined". Never send such a request: for
 * DELETE /accounts/undefined the server answers 200.
 */
export function assertNoUndefinedInUrl(path: string): void {
  const [pathname = "", query = ""] = path.split("?", 2);
  const segments = pathname.split("/").map(decodeURIComponent);
  const values = [...new URLSearchParams(query).values()];
  if ([...segments, ...values].some((part) => part === "undefined" || part === "null")) {
    throw new UsageError(
      `Refusing to send ${path}: a required payload key is missing.`,
      "Check the payload with `wf schema <command>`.",
    );
  }
}

/**
 * Sends one request to the server. `path` starts with /api/v1. Adds the
 * Bearer token, the profile scope (when `scoped`) and the owner cookie, and
 * stores a refreshed session token from Set-Cookie.
 */
export async function send(
  path: string,
  init: RequestInit = {},
  { scoped = false }: { scoped?: boolean } = {},
): Promise<Response> {
  assertNoUndefinedInUrl(path);
  const transport = getTransport();
  const { state } = transport;
  const headers = new Headers(init.headers);
  if (state.token) headers.set("authorization", `Bearer ${state.token}`);
  if (scoped && state.scopeId) headers.set(PROFILE_SCOPE_HEADER, state.scopeId);
  if (state.browserId) headers.set("cookie", `${BROWSER_COOKIE}=${state.browserId}`);

  const url = joinUrl(state.baseUrl, path);
  let response: Response;
  try {
    response = await fetch(url, { ...init, headers });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new ServerError(`Request timed out: ${init.method ?? "GET"} ${url}`);
    }
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
    throw new ServerError(
      `Cannot reach ${state.baseUrl}${cause ? `: ${cause}` : ""}`,
      undefined,
      "Check the server URL (`wf status`) and that the server is running.",
    );
  }

  const cookies = parseSetCookies(response.headers);
  let changed = false;
  const token = cookies.get(SESSION_COOKIE);
  if (token && token !== state.token) {
    state.token = token;
    changed = true;
  }
  const browserId = cookies.get(BROWSER_COOKIE);
  if (browserId && browserId !== state.browserId) {
    state.browserId = browserId;
    changed = true;
  }
  if (changed) transport.onChange?.(state);
  return response;
}
