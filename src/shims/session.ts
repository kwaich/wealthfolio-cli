// Node stand-in for upstream apps/frontend/src/features/profiles/session.ts.
// Only profileFetch is used by the vendored core.ts.
import { AuthError, ServerError } from "../errors";
import { send } from "../transport";
import { notifyUnauthorized } from "./auth-token";

export const PROFILE_HINT =
  "Run `wf profile list`, then `wf profile use <id>` to unlock a profile.";

export async function profileFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const response = await send(String(input), init, { scoped: true });
  if (response.ok && response.headers.get("content-type")?.includes("text/html")) {
    notifyUnauthorized("signIn");
  }
  // Profile admission failures are 423 with a plain-text body, which the
  // vendored invoke would reduce to the status text. Upstream revokes the
  // browser's profile session here; the CLI reports it.
  if (response.status === 423) {
    const text = (await response.text()).trim();
    if (text.startsWith("PROFILE_")) throw new AuthError(text, PROFILE_HINT);
    throw new ServerError(text || "Profile unavailable", 423);
  }
  // Request-body rejections (422 "missing field `accountType`") and some
  // other errors are plain text. The vendored invoke reads only JSON error
  // bodies and would report the status text instead. 401 stays with invoke.
  if (!response.ok && response.status !== 401 && !isJson(response)) {
    const text = (await response.text()).trim();
    throw new ServerError(text || response.statusText, response.status);
  }
  return response;
}

function isJson(response: Response): boolean {
  return response.headers.get("content-type")?.includes("json") ?? false;
}
