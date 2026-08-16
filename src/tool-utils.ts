/**
 * Shared utilities for MCP tool handlers.
 * Anything used in more than one tool file lives here.
 */

import { subYears } from "date-fns";
import { getCachedHAConfig } from "./cache.js";
import { config } from "./config.js";
import { EnrichedEntity } from "./ha-client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FilterOperator = "<" | "<=" | ">" | ">=" | "=";

// ---------------------------------------------------------------------------
// Filter helpers
// ---------------------------------------------------------------------------

export function matchesFilter(
  value: number,
  op: FilterOperator,
  threshold: number
): boolean {
  switch (op) {
    case "<":  return value < threshold;
    case "<=": return value <= threshold;
    case ">":  return value > threshold;
    case ">=": return value >= threshold;
    case "=":  return value === threshold;
  }
}

// ---------------------------------------------------------------------------
// Row cap parsing
// ---------------------------------------------------------------------------

/**
 * Parse the max_results argument. Returns an ERROR string (call not executed)
 * for anything that is neither a positive number nor the literal "all" —
 * never silently substitutes the default for an invalid value.
 */
export function parseMaxResults(
  raw: unknown,
  defaultCap = config.maxResults
): { returnAll: boolean; rowCap: number } | string {
  if (raw === undefined || raw === null) return { returnAll: false, rowCap: defaultCap };
  if (raw === "all") return { returnAll: true, rowCap: Infinity };
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return { returnAll: false, rowCap: Math.floor(raw) };
  }
  return (
    `ERROR: Invalid max_results ${JSON.stringify(raw)} — the call was NOT executed. ` +
    `Pass a positive number (e.g. max_results=20) or max_results="all". Default: ${defaultCap}.`
  );
}

/**
 * Parse an optional non-negative numeric argument. Returns an ERROR string
 * (call not executed) for wrong types or negative values — never a silent default.
 */
export function parseNonNegative(
  raw: unknown,
  paramName: string,
  defaultValue: number
): number | string {
  if (raw === undefined || raw === null) return defaultValue;
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return raw;
  return (
    `ERROR: Invalid ${paramName} ${JSON.stringify(raw)} — the call was NOT executed. ` +
    `Pass a non-negative number (e.g. ${paramName}=${defaultValue || 60}). Default: ${defaultValue}.`
  );
}

/**
 * Parse day_start_hour: integer 0-23, only meaningful with group_by="day".
 * Rejects out-of-range values instead of clamping them — a silently clamped
 * boundary produces day groupings the user cannot debug.
 */
export function parseDayStartHour(raw: unknown, groupByDay: boolean): number | string {
  if (raw === undefined || raw === null) return 0;
  if (!groupByDay) {
    return (
      `ERROR: day_start_hour only applies with group_by="day" — the call was NOT executed. ` +
      `Add group_by="day" or drop day_start_hour.`
    );
  }
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= 23) return raw;
  return (
    `ERROR: Invalid day_start_hour ${JSON.stringify(raw)} — the call was NOT executed. ` +
    `Pass an integer between 0 and 23 (e.g. day_start_hour=6).`
  );
}

// ---------------------------------------------------------------------------
// HA timezone helper
// ---------------------------------------------------------------------------

/** Returns the HA server timezone from cache (falls back to UTC). */
export function getTz(): string {
  return getCachedHAConfig()?.timezone ?? "UTC";
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

/**
 * Standard sensor header line: "Sensor: Friendly Name · Area (entity_id)"
 * Accepts null/undefined for cases where entity metadata is unavailable (e.g. binary sensors).
 */
export function formatSensorLine(entity: EnrichedEntity | null | undefined, entityId: string): string {
  if (!entity) return `Sensor: ${entityId}`;
  const areaStr = entity.area_name ? ` · ${entity.area_name}` : "";
  return `Sensor: ${entity.friendly_name}${areaStr} (${entityId})`;
}

/** Unit string with a leading space, or empty string if no unit or no metadata. */
export function formatUnit(entity: EnrichedEntity | null | undefined): string {
  return entity?.unit ? ` ${entity.unit}` : "";
}

/**
 * Compute an integer percentage. Returns null when the denominator is 0 —
 * a ratio against nothing is not 0%, and rendering it as one fabricates data.
 */
export function percentage(numerator: number, denominator: number): number | null {
  return denominator !== 0 ? Math.round(numerator / denominator * 100) : null;
}

/**
 * Round a number and return as string.
 * @param decimals - decimal places (default 1 for sensor values; pass 2 for energy/kWh)
 */
export function round(v: number, decimals = 1): string {
  const factor = Math.pow(10, decimals);
  // Math.round(-0.5) rounds toward zero (gives 0, not -1) — unexpected for display.
  // Use sign-aware rounding: round half away from zero for both positive and negative values.
  return (Math.sign(v) * Math.round(Math.abs(v) * factor) / factor).toString();
}

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Wrap a column-aligned table/data block (built with padEnd/padStart, or any
 * fixed multi-row layout) in a fenced code block so markdown-rendering chat
 * UIs (HA Assist, Claude Desktop, Open WebUI) render it monospace instead of
 * collapsing the alignment into proportional-font mush.
 *
 * Accepts either an array of lines (joined with "\n") or pre-joined text.
 * Only wrap the aligned rows themselves — leave surrounding prose (headers,
 * notes, hints, error messages) outside the fence.
 */
export function fenceTable(body: string | string[]): string {
  const text = Array.isArray(body) ? body.join("\n") : body;
  return "```\n" + text + "\n```";
}

/**
 * Format a Unix-millisecond timestamp in the HA timezone.
 * @param dateOnly - omit the time component (use for day/week/month intervals)
 */
export function toLocalTimestamp(unixMs: number, tz: string, dateOnly = false): string {
  try {
    const opts: Intl.DateTimeFormatOptions = dateOnly
      ? { timeZone: tz, dateStyle: "short" }
      : { timeZone: tz, dateStyle: "short", timeStyle: "short" };
    return new Date(unixMs).toLocaleString("sv-SE", opts);
  } catch {
    const iso = new Date(unixMs).toISOString();
    return dateOnly ? iso.slice(0, 10) : iso.slice(0, 16);
  }
}

/**
 * Returns end time minus 1ms for HA statistics queries.
 * Prevents bucket-start-exactly-at-end-time from being included (HA uses inclusive end).
 * Always use this when passing period.end to fetchStatistics.
 */
export function statsEndTime(end: Date): Date {
  return new Date(end.getTime() - 1);
}



export const START_TIME_DESC =
  `Period start. Formats: relative (7d/30d/24h/2w/1y), ` +
  `named ("last month"/"last week"/"yesterday"/"last summer"/"Q1"), ` +
  `or ISO ("2026-04-01"). Default: 30d.`;

export const END_TIME_DESC =
  `Period end, same formats as start_time. Default: now.`;

// ---------------------------------------------------------------------------
// Period comparison helpers
// ---------------------------------------------------------------------------

/** Compute start/end dates for a comparison reference period. */
export function getRefPeriod(
  start: Date,
  end: Date,
  type: "previous_period" | "same_period_last_year"
): { start: Date; end: Date } {
  if (type === "previous_period") {
    const duration = end.getTime() - start.getTime();
    return { start: new Date(start.getTime() - duration), end: start };
  }
  return { start: subYears(start, 1), end: subYears(end, 1) };
}
