/**
 * Shared pure functions for session detection.
 *
 * Used by both detect-sessions (numeric/threshold) and get-state-history
 * (discrete-state entities: binary sensors, person, device_tracker, etc.)
 *
 * Exported for unit testing.
 */

import { HistoryState } from "../ha-client.js";
import { toLocalTimestamp, percentage, fenceTable } from "../tool-utils.js";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface NormalizedState {
  time: Date;
  isActive: boolean;
  rawValue: number | null; // null for discrete-state entities
}

export interface DetectedSession {
  start: Date;
  end: Date;
  durationMs: number;
  peakValue: number | null; // non-null only for numeric sensors via detect_sessions
}

/** Daily row produced by grouping sessions by calendar date. */
export interface DailyRow {
  date: string; // YYYY-MM-DD in HA timezone
  count: number;
  firstStartMs: number;
  lastEndMs: number;
  totalActiveMs: number;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/** Extract a Date from a raw HistoryState (handles abbreviated + full formats). */
export function getTime(h: HistoryState): Date | null {
  // Abbreviated record: lc/lu are Unix seconds (float)
  if (h.lc !== undefined) return new Date(h.lc * 1000);
  if (h.lu !== undefined) return new Date(h.lu * 1000);
  // Full record: last_changed is typed number but HA may return ISO string
  const raw: unknown = h.last_changed ?? h.last_updated;
  if (raw === undefined) return null;
  if (typeof raw === "string") return new Date(raw);
  if (typeof raw === "number")
    return raw > 1e12 ? new Date(raw) : new Date(raw * 1000);
  return null;
}

/**
 * Convert raw HistoryState records to normalized states for session detection.
 *
 * A state is "active" when it matches stateValue (case-insensitive).
 * Use stateValue="on" for binary sensors, zone name for persons, etc.
 * Special case: a leading "!" means "any state except this one", for example
 * stateValue="!home" for person/device_tracker time spent outside the Home zone.
 *
 * Unavailable and unknown states are filtered out.
 * rawValue is always null (these are discrete-state entities, no numeric value).
 */
export function normalizeStatesToActive(
  rawStates: HistoryState[],
  stateValue: string,
): NormalizedState[] {
  const normalizedTarget = stateValue.trim().toLowerCase();
  const isNegated =
    normalizedTarget.startsWith("!") && normalizedTarget.length > 1;
  const target = isNegated ? normalizedTarget.slice(1) : normalizedTarget;
  const result: NormalizedState[] = [];

  for (const h of rawStates) {
    const time = getTime(h);
    if (!time) continue;
    const stateStr = h.s ?? h.state ?? null;
    if (!stateStr || stateStr === "unavailable" || stateStr === "unknown")
      continue;
    const normalizedState = stateStr.toLowerCase();
    const isActive = isNegated
      ? normalizedState !== target
      : normalizedState === target;
    result.push({ time, isActive, rawValue: null });
  }

  result.sort((a, b) => a.time.getTime() - b.time.getTime());
  return result;
}

// ---------------------------------------------------------------------------
// Session detection
// ---------------------------------------------------------------------------

/**
 * Detect contiguous active sessions from normalized states.
 * Sessions shorter than minDurationMs are discarded.
 * An open session at the end of data is closed at periodEnd (or now).
 *
 * maxGapMs: if set > 0, brief inactive gaps shorter than this threshold are
 * bridged rather than treated as session ends. Useful for devices that briefly
 * cut power mid-session (e.g. EV charger duty-cycling).
 */
export function detectSessions(
  states: NormalizedState[],
  minDurationMs: number,
  periodEnd?: Date,
  maxGapMs: number = 0,
): DetectedSession[] {
  const sessions: DetectedSession[] = [];
  let sessionStart: Date | null = null;
  let gapStart: Date | null = null;
  let peakValue: number | null = null;

  for (const state of states) {
    if (state.isActive) {
      if (sessionStart === null) {
        sessionStart = state.time;
        peakValue = state.rawValue;
        gapStart = null;
      } else if (gapStart !== null) {
        const gapMs = state.time.getTime() - gapStart.getTime();
        if (gapMs > maxGapMs) {
          const durationMs = gapStart.getTime() - sessionStart.getTime();
          if (durationMs >= minDurationMs) {
            sessions.push({
              start: sessionStart,
              end: gapStart,
              durationMs,
              peakValue,
            });
          }
          sessionStart = state.time;
          peakValue = state.rawValue;
        } else {
          if (
            state.rawValue !== null &&
            (peakValue === null || state.rawValue > peakValue)
          ) {
            peakValue = state.rawValue;
          }
        }
        gapStart = null;
      } else {
        if (
          state.rawValue !== null &&
          (peakValue === null || state.rawValue > peakValue)
        ) {
          peakValue = state.rawValue;
        }
      }
    } else if (sessionStart !== null && gapStart === null) {
      gapStart = state.time;
    }
  }

  if (sessionStart !== null) {
    const closeAt = gapStart ?? periodEnd ?? new Date();
    const durationMs = closeAt.getTime() - sessionStart.getTime();
    if (durationMs >= minDurationMs) {
      sessions.push({
        start: sessionStart,
        end: closeAt,
        durationMs,
        peakValue,
      });
    }
  }

  return sessions;
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

export function groupSessionsByDay(
  sessions: DetectedSession[],
  tz: string,
  dayStartHour = 0,
): DailyRow[] {
  const byDay = new Map<string, DetectedSession[]>();
  const shiftMs = dayStartHour * 3_600_000;
  for (const s of sessions) {
    const key = toLocalTimestamp(s.start.getTime() - shiftMs, tz, true);
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key)!.push(s);
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, daySessions]) => ({
      date,
      count: daySessions.length,
      firstStartMs: Math.min(...daySessions.map((s) => s.start.getTime())),
      lastEndMs: Math.max(...daySessions.map((s) => s.end.getTime())),
      totalActiveMs: daySessions.reduce((sum, s) => sum + s.durationMs, 0),
    }));
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Format a duration in milliseconds as a human-readable string. */
export function formatDuration(ms: number): string {
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export function formatSessionOutput(
  sessions: DetectedSession[],
  periodStart: Date,
  periodEnd: Date,
  label: string,
  sensorLine: string,
  unitStr: string,
  conditionDesc: string,
  minDurMin: number,
  maxGapMin: number,
  dataNote: string,
  rowCap: number,
  returnAll: boolean,
  tz: string,
  examinedCount?: number,
): string {
  // Defaults are policy: the gap tolerance materially changes session counts,
  // so it is always printed, including its 0 (no-merging) default.
  const configLine =
    `${sensorLine}\n` +
    `Period: ${label} | Condition: ${conditionDesc} | Min duration: ${minDurMin} min | Gap tolerance: ${maxGapMin} min\n` +
    `Source: ${dataNote}\n`;

  if (sessions.length === 0) {
    return `${configLine}\n${zeroSessionsLine(examinedCount)}`;
  }

  const periodMs = periodEnd.getTime() - periodStart.getTime();
  const totalActiveMs = sessions.reduce((s, r) => s + r.durationMs, 0);
  const activePct = percentage(totalActiveMs, periodMs);
  const avgMs = totalActiveMs / sessions.length;
  const longest = sessions.reduce((best, s) =>
    s.durationMs > best.durationMs ? s : best,
  );

  const summary =
    `${sessions.length} sessions — ` +
    `Total active: ${formatDuration(totalActiveMs)}${activePct !== null ? ` (${activePct}% of period)` : ""} | ` +
    `Avg: ${formatDuration(avgMs)} | ` +
    `Longest: ${formatDuration(longest.durationMs)} on ${toLocalTimestamp(longest.start.getTime(), tz, true)}`;

  let display = sessions;
  let capNotice = "";
  if (!returnAll && sessions.length > rowCap) {
    display = sessions.slice(0, rowCap);
    capNotice =
      `\nShowing ${rowCap} of ${sessions.length} sessions (oldest first); the summary above covers all ${sessions.length}. ` +
      `Pass max_results="all" to see all.`;
  }

  const rows = display.map((s) => {
    const startStr = toLocalTimestamp(s.start.getTime(), tz);
    const endStr = toLocalTimestamp(s.end.getTime(), tz);
    const peak =
      s.peakValue !== null ? ` | peak ${Math.round(s.peakValue)}${unitStr}` : "";
    return `${startStr} → ${endStr} | ${formatDuration(s.durationMs)}${peak}`;
  });

  const lines = [`${configLine}`, summary, ``, fenceTable(rows)];
  if (capNotice) lines.push(capNotice);

  return lines.join("\n");
}

/**
 * A zero must state its denominator: "0 sessions" from 0 data points is a
 * data problem, from 5000 data points a condition problem — and each has a
 * different recovery.
 */
function zeroSessionsLine(examinedCount?: number): string {
  const scope =
    examinedCount !== undefined
      ? `0 sessions detected (${examinedCount} data points examined in this period).`
      : `0 sessions detected in this period.`;
  const hint =
    examinedCount === 0
      ? ` No data in this period — widen the period or verify the entity has history.`
      : ` If sessions were expected, loosen the condition (threshold / state_value), lower min_duration_minutes, or widen the period.`;
  return scope + hint;
}

export function formatDailySummary(
  sessions: DetectedSession[],
  _periodStart: Date,
  _periodEnd: Date,
  label: string,
  sensorLine: string,
  _unitStr: string,
  conditionDesc: string,
  minDurMin: number,
  maxGapMin: number,
  dataNote: string,
  rowCap: number,
  returnAll: boolean,
  tz: string,
  dayStartHour = 0,
  examinedCount?: number,
): string {
  const boundaryNote =
    dayStartHour > 0
      ? ` | Day boundary: ${String(dayStartHour).padStart(2, "0")}:00 (+1 = next calendar day)`
      : "";
  const configLine =
    `${sensorLine}\n` +
    `Period: ${label} | Condition: ${conditionDesc} | Min duration: ${minDurMin} min | Gap tolerance: ${maxGapMin} min\n` +
    `Source: ${dataNote}\n`;

  if (sessions.length === 0) {
    return `${configLine}\n${zeroSessionsLine(examinedCount)}`;
  }

  const days = groupSessionsByDay(sessions, tz, dayStartHour);
  const avgPerDay = (sessions.length / days.length).toFixed(1);
  const summaryLine = `${sessions.length} sessions across ${days.length} active days (avg ${avgPerDay}/day)${boundaryNote}`;

  let display = days;
  let capNotice = "";
  if (!returnAll && days.length > rowCap) {
    display = days.slice(0, rowCap);
    capNotice =
      `\nShowing ${rowCap} of ${days.length} days (oldest first); the summary above covers all ${days.length}. ` +
      `Pass max_results="all" to see all.`;
  }

  const header = `Date | Sessions | First | Last | Active`;
  const rows = display.map((row) => {
    const firstTime = toLocalTimestamp(row.firstStartMs, tz).slice(11, 16);
    const lastTime = toLocalTimestamp(row.lastEndMs, tz).slice(11, 16);
    const firstSuffix =
      dayStartHour > 0 &&
      toLocalTimestamp(row.firstStartMs, tz, true) !== row.date
        ? "+1"
        : "";
    const lastSuffix =
      dayStartHour > 0 && toLocalTimestamp(row.lastEndMs, tz, true) !== row.date
        ? "+1"
        : "";
    return `${row.date} | ${row.count} | ${firstTime}${firstSuffix} | ${lastTime}${lastSuffix} | ${formatDuration(row.totalActiveMs)}`;
  });

  const lines = [configLine, summaryLine, ``, fenceTable([header, ...rows])];
  if (capNotice) lines.push(capNotice);

  return lines.join("\n");
}
