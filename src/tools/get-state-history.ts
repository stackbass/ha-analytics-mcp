/**
 * Get state history for discrete-state entities.
 *
 * Covers binary sensors (motion, door, presence), person/device_tracker
 * (zone/location history), and any entity whose state is a non-numeric string.
 *
 * Two modes depending on whether state_value is provided:
 *   - Session mode (state_value set): detects periods where the entity held a
 *     specific state, returning session count, durations, and a compact list.
 *   - Timeline mode (no state_value): lists all state transitions chronologically.
 *
 * Uses HA recorder state history → limited to recorder retention (~10 days default).
 *
 * Exported for unit testing:
 *   normalizeStatesToActive, buildTimeline
 */

import { config } from "../config.js";
import { fetchHistory } from "../ha-client.js";
import { getCachedHistory, setCachedHistory } from "../cache.js";
import { resolvePeriod } from "../period-resolver.js";
import { isError, errFromCaught } from "../errors.js";
import {
  getTz,
  toLocalTimestamp,
  parseMaxResults,
  parseNonNegative,
  parseDayStartHour,
  statsEndTime,
  fenceTable,
  START_TIME_DESC,
  END_TIME_DESC,
} from "../tool-utils.js";
import {
  NormalizedState,
  normalizeStatesToActive,
  detectSessions,
  formatDuration,
  formatSessionOutput,
  formatDailySummary,
  getTime,
} from "./session-core.js";
import type { HistoryState } from "../ha-client.js";
import { getRefPeriod, percentage } from "../tool-utils.js";

export const GET_STATE_HISTORY_TOOL = {
  name: "ha_history_get_state_history",
  description:
    `Gets the state-change history for any discrete-state entity in ${config.haName}.\n` +
    `Use for binary sensors (motion, door, window, presence), person/device_tracker\n` +
    `(zone and location history), and any entity with named states.\n\n` +
    `Two modes: session mode when state_value is set, timeline mode when it is omitted.\n` +
    `Source: HA recorder state history — limited to ~10 days by default.\n` +
    `Returns a timeline of transitions, or session counts and durations when state_value is set.`,
  inputSchema: {
    type: "object",
    properties: {
      entity_id: {
        type: "string",
        description: `Exact entity_id resolved earlier, e.g. "binary_sensor.entrance_motion". Do not guess.`,
      },
      state_value: {
        type: "string",
        description:
          `Target state to detect sessions for, case-insensitive.\n` +
          `Binary sensors: "on" or "off". Person/device_tracker: a zone name e.g. "home", "not_home".\n` +
          `Prefix ! for "any state except", e.g. "!home" = time spent outside Home.\n` +
          `Omit to get a full timeline of all state transitions instead.`,
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
      min_duration_minutes: {
        type: "number",
        minimum: 0,
        default: 0,
        description:
          `Session mode only. Discard sessions shorter than this (minutes). Default: 0.\n` +
          `Filters brief glitches, e.g. 1 for motion sensors.`,
      },
      max_gap_minutes: {
        type: "number",
        minimum: 0,
        default: 0,
        description:
          `Session mode only. Bridge inactive gaps shorter than this into one session (minutes).\n` +
          `Default: 0 (no merging). E.g. 2-5 for motion sensors when a person pauses briefly.`,
      },
      group_by: {
        type: "string",
        enum: ["day"],
        description:
          `Session mode only. "day" returns one row per day (date | count | first | last | total active).\n` +
          `Combine with day_start_hour=6 for overnight/cross-midnight grouping.`,
      },
      day_start_hour: {
        type: "number",
        minimum: 0,
        maximum: 23,
        default: 0,
        description:
          `Only with group_by="day". Shifts the day boundary from midnight to this hour (0-23).\n` +
          `E.g. 6 → post-midnight activity (01:30) is attributed to the previous evening's date.`,
      },
      max_results: {
        type: ["string", "number"],
        default: 20,
        description:
          `Max rows to return. Default: 20. Pass "all" to list all.\n` +
          `Timeline mode: caps transitions shown. Session mode: caps sessions or days.`,
      },
      comparison: {
        type: "string",
        enum: ["previous_period", "same_period_last_year"],
        description: `Session mode only. Compare session count and duration to a reference period.`,
      },
    },
    required: ["entity_id"],
    additionalProperties: false,
  },
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleGetStateHistory(
  args: Record<string, unknown>,
): Promise<string> {
  try {
    const entityId = String(args.entity_id ?? "").trim();
    if (!entityId) {
      return (
        `ERROR: entity_id is required — the call was NOT executed. ` +
        `Resolve it first with ha_history_list_entities.`
      );
    }
    const stateValue =
      typeof args.state_value === "string"
        ? args.state_value.trim()
        : undefined;

    // Session-only parameters are rejected in timeline mode, never silently
    // discarded — the model asked for behavior this mode does not have.
    if (stateValue === undefined) {
      const sessionOnly = ["min_duration_minutes", "max_gap_minutes", "group_by", "day_start_hour", "comparison"]
        .filter((k) => args[k] !== undefined);
      if (sessionOnly.length > 0) {
        return (
          `ERROR: ${sessionOnly.map((k) => `"${k}"`).join(", ")} only appl${sessionOnly.length > 1 ? "y" : "ies"} ` +
          `to session mode — the call was NOT executed.\n` +
          `Add state_value (e.g. state_value="on") for session mode, or drop the parameter${sessionOnly.length > 1 ? "s" : ""} for a plain timeline.`
        );
      }
    }

    // group_by values other than "day" are rejected, never silently dropped.
    if (args.group_by !== undefined && args.group_by !== "day") {
      return (
        `ERROR: Invalid group_by ${JSON.stringify(args.group_by)} — the call was NOT executed. ` +
        `ha_history_get_state_history supports only group_by="day".`
      );
    }

    const minDur = parseNonNegative(args.min_duration_minutes, "min_duration_minutes", 0);
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

    const cmpKey = comparison ? `:${comparison}` : "";
    const grpKey = groupByDay ? `:day${dayStartHour}` : "";
    const svKey = stateValue ? `:sv=${stateValue.toLowerCase()}` : ":timeline";
    const capKey = returnAll ? `:all` : rowCap !== 20 ? `:cap${rowCap}` : "";
    const cacheKey = `statehistory:${entityId}${svKey}:${minDurMin}:gap${maxGapMin}${grpKey}${capKey}${cmpKey}:${start.getTime()}:${end.getTime()}`;
    const cached = getCachedHistory(cacheKey);
    if (typeof cached === "string") return cached;

    const histResult = await fetchHistory([entityId], start, statsEndTime(end));
    if (isError(histResult)) return histResult.text;
    const rawStates = histResult[entityId] ?? [];

    const entityLine = `Entity: ${entityId}`;
    const dataNote = "State history (~10 day retention)";

    if (rawStates.length === 0) {
      // Could be a real empty period OR a wrong entity_id — recorder history
      // has no entity catalog to check against, so say both and how to tell.
      return (
        `${entityLine}\nPeriod: ${label}\n` +
        `0 recorder history records found. Either the entity_id is wrong, or the period is ` +
        `outside recorder retention (~10 days by default).\n` +
        `Verify the entity_id with ha_history_list_entities search="...", or try start_time="7d".`
      );
    }

    // --- Timeline mode (no state_value) ---
    if (stateValue === undefined) {
      const result = formatTimeline(
        rawStates,
        entityId,
        label,
        dataNote,
        rowCap,
        returnAll,
        tz,
      );
      setCachedHistory(cacheKey, result);
      return result;
    }

    // --- Session mode (state_value provided) ---
    const trimmedStateValue = stateValue.trim();
    const conditionDesc =
      trimmedStateValue.startsWith("!") && trimmedStateValue.length > 1
        ? `state != "${trimmedStateValue.slice(1)}"`
        : `state = "${trimmedStateValue}"`;
    const normalized = normalizeStatesToActive(rawStates, stateValue);
    const sessions = detectSessions(normalized, minDurMs, end, maxGapMs);

    // When the requested state never matched, list what WAS observed: a model
    // holding a rich transition dump but no answer to its actual question is
    // the prime fabrication scenario — make the honest answer the easy one.
    let observedNote = "";
    if (sessions.length === 0) {
      const counts = new Map<string, number>();
      for (const e of buildTimeline(rawStates)) {
        counts.set(e.state, (counts.get(e.state) ?? 0) + 1);
      }
      const observed = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([s, n]) => `"${s}" (${n})`)
        .join(", ");
      if (observed) {
        observedNote =
          `\nObserved states in this period: ${observed}. ` +
          `The requested state never matched — if you expected it, the state name is likely wrong for this entity.`;
      }
    }

    let result = groupByDay
      ? formatDailySummary(
          sessions,
          start,
          end,
          label,
          entityLine,
          "",
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
          entityLine,
          "",
          conditionDesc,
          minDurMin,
          maxGapMin,
          dataNote,
          rowCap,
          returnAll,
          tz,
          normalized.length,
        );
    result += observedNote;

    if (comparison) {
      const refLabel =
        comparison === "previous_period"
          ? "prev period"
          : "same period last year";
      const refDates = getRefPeriod(start, end, comparison);
      const refResult = await fetchHistory(
        [entityId],
        refDates.start,
        statsEndTime(refDates.end),
      );
      if (isError(refResult)) {
        // A failed reference fetch must never render as "0 sessions → -100%".
        result += `\nComparison to ${refLabel}: unavailable — reference-period fetch failed (${refResult.text.split("\n")[0]})`;
      } else {
        const refNorm: NormalizedState[] = normalizeStatesToActive(
          refResult[entityId] ?? [],
          stateValue,
        );
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

    setCachedHistory(cacheKey, result);
    return result;
  } catch (err) {
    return errFromCaught(err, "ha_history_get_state_history").text;
  }
}

// ---------------------------------------------------------------------------
// Timeline formatting
// ---------------------------------------------------------------------------

/** A single state transition entry for the timeline view. */
export interface TimelineEntry {
  time: Date;
  state: string;
}

/** Extract and sort all valid state transitions from raw history records. */
export function buildTimeline(rawStates: HistoryState[]): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  for (const h of rawStates) {
    const time = getTime(h);
    if (!time) continue;
    const state = h.s ?? h.state ?? null;
    if (!state || state === "unavailable" || state === "unknown") continue;
    entries.push({ time, state });
  }
  entries.sort((a, b) => a.time.getTime() - b.time.getTime());
  return entries;
}

function formatTimeline(
  rawStates: HistoryState[],
  entityId: string,
  label: string,
  dataNote: string,
  rowCap: number,
  returnAll: boolean,
  tz: string,
): string {
  const entries = buildTimeline(rawStates);
  const configLine =
    `Entity: ${entityId}\n` +
    `Period: ${label} | Mode: all transitions\n` +
    `Source: ${dataNote}\n`;

  if (entries.length === 0) {
    return `${configLine}\nNo state transitions found in this period.`;
  }

  let display = entries;
  let capNotice = "";
  if (!returnAll && entries.length > rowCap) {
    display = entries.slice(0, rowCap);
    capNotice =
      `\nShowing ${rowCap} of ${entries.length} transitions (oldest first). ` +
      `Pass max_results="all" to see all.`;
  }

  const rows: string[] = [];
  let prevState: string | null = null;
  for (const e of display) {
    const ts = toLocalTimestamp(e.time.getTime(), tz);
    const arrow = prevState !== null ? `${prevState} → ${e.state}` : e.state;
    rows.push(`${ts} | ${arrow}`);
    prevState = e.state;
  }

  const lines = [configLine, `${entries.length} transitions`, ``, fenceTable(rows)];
  if (capNotice) lines.push(capNotice);

  return lines.join("\n");
}
