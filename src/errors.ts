export const EXIT = { ok: 0, server: 1, usage: 2, auth: 3 } as const;

export class WfError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly hint?: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** Bad flags, bad JSON, unknown command. Exit code 2. */
export class UsageError extends WfError {
  constructor(message: string, hint?: string) {
    super(message, EXIT.usage, hint);
  }
}

/** Missing, expired or rejected session, or no admitted profile. Exit code 3. */
export class AuthError extends WfError {
  constructor(message: string, hint?: string) {
    super(message, EXIT.auth, hint);
  }
}

/** The server answered with an error, or could not be reached. Exit code 1. */
export class ServerError extends WfError {
  constructor(
    message: string,
    readonly status?: number,
    hint?: string,
  ) {
    super(message, EXIT.server, hint);
  }
}
