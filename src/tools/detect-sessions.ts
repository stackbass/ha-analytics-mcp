/**
 * Detect activity sessions from numeric sensor history via a power threshold.
 *
 * Uses long-term hourly statistics → full date range, no retention limit,
 * ±1h precision on session boundaries.
 *
 * For binary sensors, persons, and other discrete-state entities use
 * ha_history_get_state_history instead.
 *
 * Exported for unit testing:
 *   normalizeStatRows
 */

import { fetchStatistics, StatisticRow } from "../ha-client.js";
import { getCachedStats, setCachedStats } from "../cache.js";
import { resolvePeriod } from "../period-resolver.js";
import { isError, errFromCaught } from "../errors.js";
import {
  getTz,
  parseMaxResults,
  parseNonNegative,
  parseDayStartHour,
  statsEndTime,
  formatSensorLine,
  formatUnit,
  getRefPeriod,
  percentage,
  START_TIME_DESC,
  END_TIME_DESC,
} from "../tool-utils.js";
import { validateEntity } from "../entity-validator.js";
import {
  detectSessions,
  formatDuration,
  formatSessionOutput,
  formatDailySummary,
} from "./session-core.js";
import type { NormalizedState } from "./session-core.js";

export const DETECT_SESSIONS_TOOL = {
  name: "ha_history_detect_sessions",
  description:
    `Detects activity sessions from a numeric sensor using a power/value threshold.\n` +
    `Use for threshold-based activity questions such as charging sessions, appliance runs, or heating cycles.\n` +
    `Uses long-term hourly statistics → full date range, no retention limit, ±1h precision.\n` +
    `For binary sensors or person/zone state history,\n` +
    `use ha_history_get_state_history instead.\n` +
    `Returns event count, total duration, a compact session list, or a daily summary with group_by="day".`,
  inputSchema: {
    type: "object",
    properties: {
      entity_id: {
        type: "string",
        description: `Exact entity_id resolved earlier, e.g. "sensor.car_charger_power". Do not guess.`,
      },
      start_time: {
        type: "string",
        description:
          START_TIME_DESC +
          ` Special: "overnight" = 22:00 yesterday → 06:00 today.`,
      },
      end_time: {
        type: "string",
        description: END_TIME_DESC,
      },
      threshold: {
        type: "number",
        description:
          `Minimum value to count as "active", in the sensor's own unit.\n` +
          `Example: 100 for a Watt sensor (EV charger, heater, washing machine).`,
      },
      min_duration_minutes: {
        type: "number",
        minimum: 0,
        default: 1,
        description:
          `Discard sessions shorter than this (minutes). Default: 1.\n` +
          `Hourly statistics → values below 60 have no additional effect.`,
      },
      max_gap_minutes: {
        type: "number",
        minimum: 0,
        default: 0,
        description:
          `Bridge inactive gaps shorter than this into one session (minutes). Default: 0 (no merging).\n` +
          `E.g. 120 for a washing machine pausing between cycles.\n` +
          `Hourly statistics → use multiples of 60; values below 60 have no effect.`,
      },
      group_by: {
        type: "string",
        enum: ["day"],
        description:
          `"day" returns one row per day (date | count | first start | last end | total active)\n` +
          `instead of individual sessions. Use for daily patterns ("how many runs per day?").\n` +
          `Summary stats always cover the full dataset.`,
      },
      day_start_hour: {
        type: "number",
        minimum: 0,
        maximum: 23,
        default: 0,
        description:
          `Only with group_by="day". Shifts the day boundary from midnight to this hour (0-23).\n` +
          `E.g. 6 → a day runs 06:00-05:59, so 01:30 activity counts on the previous evening's date.`,
      },
      max_results: {
        type: ["string", "number"],
        default: 20,
        description:
          `Max rows (sessions, or days with group_by). Default: 20. Pass "all" to list all.\n` +
          `Summary stats always cover the full dataset regardless.`,
      },
      comparison: {
        type: "string",
        enum: ["previous_period", "same_period_last_year"],
        description:
          `Compare session count and duration to the immediately preceding equal-length period,\n` +
          `or to the same calendar period 12 months ago.`,
      },
    },
    required: ["entity_id", "threshold"],
    additionalProperties: false,
  },
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleDetectSessions(
  args: Record<string, unknown>,
): Promise<string> {
  try {
    const entityId = String(args.entity_id ?? "");
    const threshold =
      typeof args.threshold === "number" ? args.threshold : undefined;

    if (threshold === undefined) {
      return (
        `ERROR: ha_history_detect_sessions requires a numeric threshold.\n` +
        `For binary sensors or person/zone state history,\n` +
        `use ha_history_get_state_history instead.`
      );
    }

    // Discrete-state domains have no numeric statistics: route to the right
    // tool instead of failing the catalog lookup with irrelevant candidates.
    const domain = entityId.split(".")[0] ?? "";
    const DISCRETE_DOMAINS = new Set([
      "binary_sensor", "person", "device_tracker", "zone",
      "input_boolean", "input_select", "switch", "light", "lock", "cover",
    ]);
    if (DISCRETE_DOMAINS.has(domain)) {
      return (
        `ERROR: "${entityId}" is a discrete-state entity (${domain}) — it has no numeric ` +
        `statistics to threshold. Use ha_history_get_state_history with ` +
        `entity_id="${entityId}" and state_value (e.g. "on") instead.`
      );
    }

    // group_by other than "day" is a different tool's job, not a silent no-op.
    if (args.group_by !== undefined && args.group_by !== "day") {
      return (
        `ERROR: Invalid group_by ${JSON.stringify(args.group_by)} — the call was NOT executed. ` +
        `ha_history_detect_sessions supports only group_by="day". ` +
        `For time-of-day or day-of-week patterns on a numeric sensor, use ` +
        `ha_history_get_sensor_stats with group_by="hour_of_day" or "day_of_week".`
      );
    }

    const minDur = parseNonNegative(args.min_duration_minutes, "min_duration_minutes", 1);
    if (typeof minDur === "string") return minDur;
    const minDurMin = minDur;
    const minDurMs = minDurMin * 60_000;
    const maxGap = parseNonNegative(args.max_gap_minutes, "max_gap_minutes", 0);
    if (typeof maxGap === "string") return maxGap;
    const maxGapMin = maxGap;
    const maxGapMs = maxGapMin * 60_000;
    const comparison = args.comparison as
      | "previous_period"
      | "same_period_last_year"
      | undefined;
    const groupByDay = args.group_by === "day";
    const dsh = parseDayStartHour(args.day_start_hour, groupByDay);
    if (typeof dsh === "string") return dsh;
    const dayStartHour = dsh;
    const capParsed = parseMaxResults(args.max_results, 20);
    if (typeof capParsed === "string") return capParsed;
    const { returnAll, rowCap } = capParsed;

    const tz = getTz();
    const now = new Date();

    const period = resolvePeriod(
      args.start_time as string | undefined,
      args.end_time as string | undefined,
      now,
      tz,
    );
    if (typeof period === "string") return period;
    const { start, end, label } = period;

    // Validate upfront: a wrong entity_id gets candidates and the right
    // sibling tool now, instead of an empty result that looks like an answer.
    const validation = await validateEntity(entityId, "mean");
    if (typeof validation === "string") return validation;
    const meta = validation.entity;
    const unitStr = formatUnit(meta);
    const sensorLine = formatSensorLine(meta, entityId);

    const conditionDesc = `≥ ${threshold}${unitStr}`;
    const cmpKey = comparison ? `:${comparison}` : "";
    const grpKey = groupByDay ? `:day${dayStartHour}` : "";
    const capKey = returnAll ? `:all` : rowCap !== 20 ? `:cap${rowCap}` : "";
    const cacheKey = `sessions:${entityId}:${threshold}:${minDurMin}:gap${maxGapMin}${grpKey}${capKey}${cmpKey}:${start.getTime()}:${end.getTime()}`;
    const cached = getCachedStats(cacheKey);
    if (typeof cached === "string") return cached;

    const statsResult = await fetchStatistics(
      [entityId],
      start,
      statsEndTime(end),
      "hour",
      ["mean", "max"],
    );
    if (isError(statsResult)) return statsResult.text;
    const rows = statsResult[entityId] ?? [];
    if (rows.length === 0) {
      // Entity is validated, so this is a real empty period — not a failed lookup.
      return (
        `${sensorLine}\nPeriod: ${label}\n` +
        `0 hourly statistics buckets in this period. ` +
        `Widen the period, or check when this sensor started recording.`
      );
    }

    const normalized = normalizeStatRows(rows, threshold);
    const dataNote = "Hourly statistics (±1h precision, full retention)";
    const sessions = detectSessions(normalized, minDurMs, end, maxGapMs);

    let result = groupByDay
      ? formatDailySummary(
          sessions,
          start,
          end,
          label,
          sensorLine,
          unitStr,
          conditionDesc,
          minDurMin,
          maxGapMin,
          dataNote,
          rowCap,
          returnAll,
          tz,
          dayStartHour,
          normalized.length,
        )
      : formatSessionOutput(
          sessions,
          start,
          end,
          label,
          sensorLine,
          unitStr,
          conditionDesc,
          minDurMin,
          maxGapMin,
          dataNote,
          rowCap,
          returnAll,
          tz,
          normalized.length,
        );

    if (comparison) {
      const refLabel =
        comparison === "previous_period"
          ? "prev period"
          : "same period last year";
      const refDates = getRefPeriod(start, end, comparison);
      const refResult = await fetchStatistics(
        [entityId],
        refDates.start,
        statsEndTime(refDates.end),
        "hour",
        ["mean", "max"],
      );
      if (isError(refResult)) {
        // A failed reference fetch must never render as "0 sessions → -100%".
        result += `\nComparison to ${refLabel}: unavailable — reference-period fetch failed (${refResult.text.split("\n")[0]})`;
      } else {
        const refNorm = normalizeStatRows(refResult[entityId] ?? [], threshold);
        const refSessions = detectSessions(
          refNorm,
          minDurMs,
          refDates.end,
          maxGapMs,
        );
        const refTotalMs = refSessions.reduce((s, r) => s + r.durationMs, 0);
        const curTotalMs = sessions.reduce((s, r) => s + r.durationMs, 0);
        const sessionDelta = sessions.length - refSessions.length;
        const durDelta = curTotalMs - refTotalMs;
        const sessionPct = percentage(sessionDelta, refSessions.length);
        const durPct = percentage(durDelta, refTotalMs);
        const sign = (n: number) => (n >= 0 ? "+" : "");
        const pctStr = (p: number | null) => (p !== null ? `${sign(p)}${p}%` : "n/a, reference was 0");
        result +=
          `\nComparison to ${refLabel}: ${refSessions.length} sessions, ${formatDuration(refTotalMs)}` +
          ` → ${sign(sessionDelta)}${sessionDelta} sessions (${pctStr(sessionPct)}),` +
          ` ${sign(durDelta)}${formatDuration(Math.abs(durDelta))} (${pctStr(durPct)})`;
      }
    }

    setCachedStats(cacheKey, result, end);
    return result;
  } catch (err) {
    return errFromCaught(err, "ha_history_detect_sessions").text;
  }
}

// ---------------------------------------------------------------------------
// Pure core functions (exported for testing)
// ---------------------------------------------------------------------------

export interface DetectedSession {
  start: Date;
  end: Date;
  durationMs: number;
  peakValue: number | null; // max value during session (numeric sensors only)
}

/**
 * Convert hourly StatisticRow records to normalized states for session detection.
 * Uses mean for activity detection (smooths sub-hour dips) and max for peak tracking.
 * Rows with null mean are excluded (gaps in statistics data).
 */
export function normalizeStatRows(
  rows: StatisticRow[],
  threshold: number,
): NormalizedState[] {
  return rows
    .filter((row) => row.mean !== null)
    .map((row) => ({
      time: new Date(row.start),
      isActive: (row.mean ?? 0) >= threshold,
      rawValue: row.max ?? row.mean,
    }))
    .sort((a, b) => a.time.getTime() - b.time.getTime());
}

// Re-export shared functions so tests can import from detect-sessions (backward compat)
export {
  detectSessions,
  groupSessionsByDay,
  formatDuration,
  normalizeStatesToActive,
} from "./session-core.js";
