// Node stand-in for upstream apps/frontend/src/lib/backend-error.ts.
// Upstream keeps only an error code and drops the server's message, so that
// the UI can translate it. The CLI wants the message: profileFetch throws a
// ServerError for every non-OK response except 401, so the vendored invoke
// never reaches the code below. It only satisfies the import.
export class BackendError extends Error {
  constructor(
    readonly errorCode: string,
    readonly outcomeUnknown?: boolean,
  ) {
    super(errorCode);
    this.name = "BackendError";
  }
}

export const backendError = (_cause: unknown): BackendError | undefined => undefined;
