/**
 * Resolves human-friendly time expressions into absolute { start, end } Date pairs.
 * All named periods and date-only ISO strings are resolved in the HA server timezone.
 */

import {
  startOfDay,
  startOfMonth,
  endOfMonth,
  startOfYear,
  startOfWeek,
  subDays,
  subWeeks,
  subMonths,
  subYears,
  addDays,
  parseISO,
  isValid,
} from "date-fns";
import { toZonedTime, fromZonedTime, formatInTimeZone } from "date-fns-tz";

export interface ResolvedPeriod {
  start: Date;
  end: Date;
  label: string;
}

const MONTH_NAMES: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
};

const QUARTER_MONTHS: Record<string, [number, number]> = {
  q1: [0, 2],
  q2: [3, 5],
  q3: [6, 8],
  q4: [9, 11],
};

function parseRelativeMs(s: string): number | null {
  const m = s.match(/^(\d+)(h|d|w|m|y)$/i);
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  switch (m[2]!.toLowerCase()) {
    case "h":
      return n * 3600 * 1000;
    case "d":
      return n * 86400 * 1000;
    case "w":
      return n * 7 * 86400 * 1000;
    case "m":
      return n * 30 * 86400 * 1000;
    case "y":
      return n * 365 * 86400 * 1000;
    default:
      return null;
  }
}

interface Resolved {
  date: Date;
  /** True when the input was a date-only string like "2026-04-01" (no time component). */
  dateOnly: boolean;
}

/**
 * Resolve a single expression to a UTC Date.
 * Date-only ISO strings (YYYY-MM-DD) are interpreted as midnight in the HA timezone,
 * NOT as UTC midnight — this avoids the off-by-one shift for UTC+ zones.
 */
function resolveExpression(
  expr: string,
  now: Date,
  tz: string,
): Resolved | null {
  const s = expr.trim().toLowerCase();

  // Date-only ISO: "2026-04-01" — treat as midnight in HA timezone
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(expr.trim());
  if (dateOnly) {
    const [y, mo, d] = expr.trim().split("-").map(Number);
    const zonedMidnight = new Date(y!, mo! - 1, d!, 0, 0, 0, 0);
    return { date: fromZonedTime(zonedMidnight, tz), dateOnly: true };
  }

  // Full ISO datetime (with time component) — parse as-is (respects Z or offset if present)
  const iso = parseISO(expr.trim());
  if (isValid(iso)) return { date: iso, dateOnly: false };

  // Relative: "7d", "30d", "24h", "2w"
  const ms = parseRelativeMs(s);
  if (ms !== null)
    return { date: new Date(now.getTime() - ms), dateOnly: false };

  // Named expressions — resolve in HA timezone
  const zonedNow = toZonedTime(now, tz);

  const named: Record<string, () => Date> = {
    now: () => now,
    today: () => fromZonedTime(startOfDay(zonedNow), tz),
    yesterday: () => fromZonedTime(startOfDay(subDays(zonedNow, 1)), tz),
    "this week": () =>
      fromZonedTime(startOfWeek(zonedNow, { weekStartsOn: 1 }), tz),
    "last week": () =>
      fromZonedTime(
        startOfWeek(subWeeks(zonedNow, 1), { weekStartsOn: 1 }),
        tz,
      ),
    "this month": () => fromZonedTime(startOfMonth(zonedNow), tz),
    "last month": () => fromZonedTime(startOfMonth(subMonths(zonedNow, 1)), tz),
    "this year": () => fromZonedTime(startOfYear(zonedNow), tz),
    "last year": () => fromZonedTime(startOfYear(subYears(zonedNow, 1)), tz),
    "last winter": () => {
      // Winter starts in December; if we haven't reached December yet this year, take Dec of last year.
      const year =
        zonedNow.getMonth() < 11
          ? zonedNow.getFullYear() - 1
          : zonedNow.getFullYear();
      return fromZonedTime(new Date(year, 11, 1), tz);
    },
    "last summer": () => {
      const year =
        zonedNow.getMonth() < 6
          ? zonedNow.getFullYear() - 1
          : zonedNow.getFullYear();
      return fromZonedTime(new Date(year, 5, 1), tz);
    },
  };

  if (named[s]) return { date: named[s]!(), dateOnly: false };

  // Month name: "january", "april"
  const monthIdx = MONTH_NAMES[s];
  if (monthIdx !== undefined) {
    let year = zonedNow.getFullYear();
    if (monthIdx > zonedNow.getMonth()) year--;
    return {
      date: fromZonedTime(new Date(year, monthIdx, 1), tz),
      dateOnly: false,
    };
  }

  // Quarter: "q1" … "q4"
  const qMonths = QUARTER_MONTHS[s];
  if (qMonths) {
    const [startM] = qMonths;
    let year = zonedNow.getFullYear();
    if (startM > zonedNow.getMonth()) year--;
    return {
      date: fromZonedTime(new Date(year, startM, 1), tz),
      dateOnly: false,
    };
  }

  return null;
}

/** "overnight" = 22:00 yesterday → 06:00 today in HA timezone. */
export function resolveOvernightPeriod(tz: string, now: Date): ResolvedPeriod {
  const zonedNow = toZonedTime(now, tz);
  const y = zonedNow.getFullYear(),
    mo = zonedNow.getMonth(),
    d = zonedNow.getDate();
  const start = fromZonedTime(new Date(y, mo, d - 1, 22, 0, 0), tz);
  const end = fromZonedTime(new Date(y, mo, d, 6, 0, 0), tz);
  return { start, end, label: "overnight (22:00–06:00)" };
}

export function resolvePeriod(
  startExpr: string | undefined,
  endExpr: string | undefined,
  now: Date,
  tz: string,
): ResolvedPeriod | string {
  // Special case: "overnight" resolves to 22:00 yesterday → 06:00 today
  if (startExpr?.trim().toLowerCase() === "overnight") {
    return resolveOvernightPeriod(tz, now);
  }

  // --- Resolve end ---
  let end: Date;
  if (!endExpr) {
    end = now;
  } else {
    const r = resolveExpression(endExpr, now, tz);
    if (!r)
      return `ERROR: Invalid end_time "${endExpr}". Use formats like "2026-04-01", "7d", "last month", "april".`;
    // Date-only end: extend to start-of-next-day so the full end day is included
    end = r.dateOnly
      ? fromZonedTime(startOfDay(addDays(toZonedTime(r.date, tz), 1)), tz)
      : r.date;
  }

  // --- Resolve start ---
  let start: Date;
  let autoLabel: string | null = null;

  if (!startExpr) {
    start = new Date(end.getTime() - 30 * 86400 * 1000);
  } else {
    const s = startExpr.trim().toLowerCase();

    // Named month with no explicit end → auto-compute end-of-that-month
    const monthIdx = MONTH_NAMES[s];
    if (monthIdx !== undefined && !endExpr) {
      const r = resolveExpression(startExpr, now, tz);
      if (!r)
        return `ERROR: Invalid start_time "${startExpr}". Use formats like "2026-04-01", "7d", "last month", "april".`;
      const zonedStart = toZonedTime(r.date, tz);
      start = r.date;
      end = fromZonedTime(startOfDay(addDays(endOfMonth(zonedStart), 1)), tz);
      const monthName = startExpr.charAt(0).toUpperCase() + startExpr.slice(1);
      autoLabel = `${monthName} ${zonedStart.getFullYear()}`;
    }
    // Named quarter with no explicit end → auto-compute end-of-that-quarter
    else if (QUARTER_MONTHS[s] && !endExpr) {
      const r = resolveExpression(startExpr, now, tz);
      if (!r)
        return `ERROR: Invalid start_time "${startExpr}". Use formats like "2026-04-01", "7d", "last month", "april".`;
      const [, endM] = QUARTER_MONTHS[s]!;
      const zonedStart = toZonedTime(r.date, tz);
      start = r.date;
      const endOfQuarter = endOfMonth(
        new Date(zonedStart.getFullYear(), endM, 1),
      );
      end = fromZonedTime(startOfDay(addDays(endOfQuarter, 1)), tz);
      autoLabel = `${s.toUpperCase()} ${zonedStart.getFullYear()}`;
    } else {
      const r = resolveExpression(startExpr, now, tz);
      if (!r)
        return `ERROR: Invalid start_time "${startExpr}". Use formats like "2026-04-01", "7d", "last month", "april".`;
      start = r.date;
    }
  }

  if (start >= end) {
    return (
      `ERROR: start_time must be before end_time. ` +
      `Got start=${start.toISOString()}, end=${end.toISOString()}. Swap the two values.`
    );
  }

  const label = buildLabel(startExpr, endExpr, start, end, tz, autoLabel);
  return { start, end, label };
}

/**
 * Human-readable label that always echoes the resolved absolute range, so the
 * model can verify and cite the dates the server actually computed — the
 * user's words alone ("last month", "7d") hide the resolution.
 * The end date is displayed inclusively (end minus 1ms), so an end_time of
 * "2026-04-07" shows as 2026-04-07, not the internal 2026-04-08 midnight bound.
 */
function buildLabel(
  startExpr: string | undefined,
  endExpr: string | undefined,
  start: Date,
  end: Date,
  tz: string,
  autoLabel: string | null = null,
): string {
  const fmt = (d: Date) => formatInTimeZone(d, tz, "yyyy-MM-dd");
  const range = `${fmt(start)} → ${fmt(new Date(end.getTime() - 1))}`;

  if (autoLabel) return `${autoLabel} (${range})`;
  if (startExpr && !endExpr) {
    const name = /^\d+[hdwmy]$/i.test(startExpr) ? `last ${startExpr}` : startExpr;
    return `${name} (${range})`;
  }
  return range;
}
