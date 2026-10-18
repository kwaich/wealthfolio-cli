// Node stand-in for upstream apps/frontend/src/lib/auth-token.ts.
// The browser shows a sign-in screen; the CLI stops with exit code 3.
import { AuthError } from "../errors";

export type AuthFailure = "expired" | "signIn";

export const notifyUnauthorized = (reason: AuthFailure = "expired"): never => {
  if (reason === "signIn") {
    throw new AuthError(
      "The server returned an HTML page instead of JSON. A proxy sign-in page may be in front of it.",
      "Check the server URL, or sign in through the proxy and use `wf login --token`.",
    );
  }
  throw new AuthError("Not logged in, or the session expired.", "Run `wf login`.");
};
