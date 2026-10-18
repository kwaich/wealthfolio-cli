// Flag parsers shared by the curated commands.
import { InvalidArgumentError } from "commander";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DECIMAL = /^-?\d+(\.\d+)?$/;

/** Local calendar date as YYYY-MM-DD. */
export function today(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function dateArg(value: string): string {
  // Date.parse rolls 2026-02-30 over to March, so check that the date round-trips.
  const parsed = DATE.test(value) ? new Date(`${value}T00:00:00Z`) : undefined;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new InvalidArgumentError("Use YYYY-MM-DD.");
  }
  return value;
}

export function monthArg(value: string): string {
  if (!MONTH.test(value)) throw new InvalidArgumentError("Use YYYY-MM.");
  return value;
}

export function decimalArg(value: string): string {
  if (!DECIMAL.test(value))
    throw new InvalidArgumentError("Use a plain decimal number, for example 1250.50.");
  return value;
}

export function numberArg(value: string): number {
  const n = Number(value);
  if (value.trim() === "" || !Number.isFinite(n)) throw new InvalidArgumentError("Use a number.");
  return n;
}

export function intArg(value: string): number {
  const n = numberArg(value);
  if (!Number.isInteger(n) || n < 0) throw new InvalidArgumentError("Use a whole number.");
  return n;
}

export const collect = (value: string, previous: string[] = []) => [...previous, value];

/** The timezone if Intl knows it, else this machine's, as the web app resolves it. */
function resolveTimezone(timezone?: string | null): string {
  const candidate = timezone?.trim();
  if (candidate) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(new Date());
      return candidate;
    } catch {
      // fall through
    }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Today's calendar date as YYYY-MM-DD in `timezone` (else this machine's). */
export function todayIn(timezone?: string | null, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: resolveTimezone(timezone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** How far `timezone`'s wall clock is ahead of UTC at `instant`, in ms. */
function offsetMs(instant: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  const hour = part("hour") === 24 ? 0 : part("hour");
  const wall = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    hour,
    part("minute"),
    part("second"),
    instant.getUTCMilliseconds(),
  );
  return wall - instant.getTime();
}

/**
 * The first or last millisecond of a YYYY-MM-DD day in `timezone`, as an
 * RFC 3339 timestamp: what the web app sends for a date range
 * (zonedCalendarDateBoundaryToDate in features/spending/lib/timezone.ts).
 */
export function dayBoundary(date: string, boundary: "start" | "end", timezone?: string | null) {
  const tz = resolveTimezone(timezone);
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const wall =
    boundary === "start" ? Date.UTC(y, m - 1, d) : Date.UTC(y, m - 1, d, 23, 59, 59, 999);
  let instant = new Date(wall);
  for (let i = 0; i < 3; i += 1) {
    const next = new Date(wall - offsetMs(instant, tz));
    if (next.getTime() === instant.getTime()) break;
    instant = next;
  }
  return instant.toISOString();
}
