// Flag parsers shared by the curated commands.
import { InvalidArgumentError } from "commander";

export const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DECIMAL = /^-?\d+(\.\d+)?$/;

/** Local calendar date as YYYY-MM-DD. */
export function today(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function dateArg(value: string): string {
  if (!DATE.test(value) || Number.isNaN(Date.parse(value))) {
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
