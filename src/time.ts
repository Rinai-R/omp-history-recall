import { RecallError } from "./source";

export type TimeFilter = { days?: number; from?: string; to?: string };
export type TimeRange = { from: string | null; to: string | null };

function parseDate(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
      throw new RecallError("invalid_time", "Invalid calendar date.");
    }
    return date.toISOString();
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new RecallError("invalid_time", "Use YYYY-MM-DD (UTC) or an ISO timestamp with an explicit timezone.");
  }
  // Date.parse normalizes impossible calendar dates; validate the local date too.
  parseDate(value.slice(0, 10));
  return new Date(value).toISOString();
}

export function timeRange(filter: TimeFilter, now = Date.now()): TimeRange {
  if (filter.days !== undefined) {
    if (filter.from !== undefined || filter.to !== undefined) throw new RecallError("invalid_time", "days cannot be combined with from/to.");
    if (!Number.isSafeInteger(filter.days) || filter.days < 1 || filter.days > 36500) throw new RecallError("invalid_time", "days must be an integer from 1 to 36500.");
    return { from: new Date(now - filter.days * 86_400_000).toISOString(), to: new Date(now + 1).toISOString() };
  }
  const from = filter.from === undefined ? null : parseDate(filter.from);
  const to = filter.to === undefined ? null : parseDate(filter.to);
  if (from && to && from >= to) throw new RecallError("invalid_time", "from must precede to; to is exclusive.");
  return { from, to };
}
