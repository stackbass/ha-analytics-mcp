/**
 * Tests for detect-sessions.ts — pure algorithm functions only.
 * No HA connection required.
 *
 * normalizeStatRows is tested here (detect-sessions.ts specific).
 * detectSessions, groupSessionsByDay, formatDuration live in session-core.ts
 * but are re-exported from detect-sessions.ts for backward compatibility.
 */

import { describe, it, expect } from "vitest";
import {
  normalizeStatRows,
  detectSessions,
  formatDuration,
} from "../tools/detect-sessions.js";
import type { NormalizedState } from "../tools/session-core.js";
import {
  groupSessionsByDay,
  formatSessionOutput,
  formatDailySummary,
} from "../tools/session-core.js";
import type { DetectedSession } from "../tools/session-core.js";
import { StatisticRow } from "../ha-client.js";

// ---------------------------------------------------------------------------
// Helpers to build test fixtures
// ---------------------------------------------------------------------------

/** Build a sequence of NormalizedStates from (time_ms, isActive, rawValue?) tuples. */
function ns(time: number, isActive: boolean, rawValue: number | null = null): NormalizedState {
  return { time: new Date(time), isActive, rawValue };
}

/** Build a StatisticRow (start in ms, mean/max optional). */
function statRow(startMs: number, mean: number | null, max: number | null = null): StatisticRow {
  return { start: startMs, end: startMs + 3_600_000, mean, min: null, max, sum: null, state: null, last_reset: null };
}

const T0 = 1_000_000_000_000; // arbitrary epoch reference (ms)
const HOUR = 3_600_000;
const MIN = 60_000;

// ---------------------------------------------------------------------------
// normalizeStatRows
// ---------------------------------------------------------------------------

describe("normalizeStatRows", () => {
  it("marks rows with mean >= threshold as active", () => {
    const rows = [statRow(T0, 2500), statRow(T0 + HOUR, 0)];
    const result = normalizeStatRows(rows, 100);
    expect(result[0]!.isActive).toBe(true);
    expect(result[1]!.isActive).toBe(false);
  });

  it("uses bucket start as time", () => {
    const rows = [statRow(T0, 500)];
    const result = normalizeStatRows(rows, 100);
    expect(result[0]!.time.getTime()).toBe(T0);
  });

  it("uses max as rawValue when available", () => {
    const rows = [statRow(T0, 500, 3200)];
    const result = normalizeStatRows(rows, 100);
    expect(result[0]!.rawValue).toBe(3200);
  });

  it("falls back to mean for rawValue when max is null", () => {
    const rows = [statRow(T0, 1500, null)];
    const result = normalizeStatRows(rows, 100);
    expect(result[0]!.rawValue).toBe(1500);
  });

  it("filters out rows with null mean", () => {
    const rows = [statRow(T0, null), statRow(T0 + HOUR, 500)];
    const result = normalizeStatRows(rows, 100);
    expect(result).toHaveLength(1);
    expect(result[0]!.time.getTime()).toBe(T0 + HOUR);
  });

  it("sorts output by time", () => {
    const rows = [statRow(T0 + HOUR, 500), statRow(T0, 200)];
    const result = normalizeStatRows(rows, 100);
    expect(result[0]!.time.getTime()).toBe(T0);
    expect(result[1]!.time.getTime()).toBe(T0 + HOUR);
  });

  it("threshold=0 treats any non-negative mean as active", () => {
    const rows = [statRow(T0, 0), statRow(T0 + HOUR, 0.1)];
    const result = normalizeStatRows(rows, 0);
    expect(result[0]!.isActive).toBe(true);
    expect(result[1]!.isActive).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// detectSessions
// ---------------------------------------------------------------------------

describe("detectSessions — basic session detection", () => {
  it("single on/off → one session", () => {
    const states: NormalizedState[] = [
      ns(T0,            true),
      ns(T0 + 60 * MIN, false),
    ];
    const sessions = detectSessions(states, 0);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.durationMs).toBe(60 * MIN);
  });

  it("two separate sessions", () => {
    const states: NormalizedState[] = [
      ns(T0,              true),
      ns(T0 + 30 * MIN,   false),
      ns(T0 + 60 * MIN,   true),
      ns(T0 + 90 * MIN,   false),
    ];
    const sessions = detectSessions(states, 0);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.durationMs).toBe(30 * MIN);
    expect(sessions[1]!.durationMs).toBe(30 * MIN);
    expect(sessions[1]!.start.getTime()).toBe(T0 + 60 * MIN);
  });

  it("empty states → no sessions", () => {
    expect(detectSessions([], 0)).toHaveLength(0);
  });

  it("all inactive → no sessions", () => {
    const states = [ns(T0, false), ns(T0 + MIN, false)];
    expect(detectSessions(states, 0)).toHaveLength(0);
  });

  it("session still active at end → closed at periodEnd", () => {
    const periodEnd = new Date(T0 + 120 * MIN);
    const states: NormalizedState[] = [
      ns(T0, true),
      // never goes inactive
    ];
    const sessions = detectSessions(states, 0, periodEnd);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.end.getTime()).toBe(T0 + 120 * MIN);
    expect(sessions[0]!.durationMs).toBe(120 * MIN);
  });
});

describe("detectSessions — min_duration_ms filter", () => {
  it("session shorter than min is discarded", () => {
    const states: NormalizedState[] = [
      ns(T0,           true),
      ns(T0 + 2 * MIN, false), // 2 min — below 5 min threshold
      ns(T0 + 10 * MIN, true),
      ns(T0 + 30 * MIN, false), // 20 min — above threshold
    ];
    const sessions = detectSessions(states, 5 * MIN);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.durationMs).toBe(20 * MIN);
  });

  it("session exactly at min_duration is kept", () => {
    const states: NormalizedState[] = [
      ns(T0,           true),
      ns(T0 + 5 * MIN, false),
    ];
    const sessions = detectSessions(states, 5 * MIN);
    expect(sessions).toHaveLength(1);
  });
});

describe("detectSessions — peak value tracking", () => {
  it("tracks peak across multiple active readings", () => {
    const states: NormalizedState[] = [
      ns(T0,              true, 1000),
      ns(T0 + 5 * MIN,    true, 2400),  // new peak
      ns(T0 + 10 * MIN,   true, 1200),
      ns(T0 + 15 * MIN,   false, 0),
    ];
    const sessions = detectSessions(states, 0);
    expect(sessions[0]!.peakValue).toBe(2400);
  });

  it("null rawValue (binary mode) → peakValue stays null", () => {
    const states: NormalizedState[] = [
      ns(T0,           true,  null),
      ns(T0 + 5 * MIN, false, null),
    ];
    const sessions = detectSessions(states, 0);
    expect(sessions[0]!.peakValue).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectSessions — max_gap_minutes (gap merge)
// ---------------------------------------------------------------------------

describe("detectSessions — maxGapMs gap merging", () => {
  it("brief inactive gap within tolerance merges into one session", () => {
    // 10 min active, 1 min inactive, 10 min active → should merge to 21 min
    const states: NormalizedState[] = [
      ns(T0,             true,  2300),
      ns(T0 + 10 * MIN,  false, null), // 1 min dip starts
      ns(T0 + 11 * MIN,  true,  2350), // came back
      ns(T0 + 21 * MIN,  false, null), // actual end
    ];
    const sessions = detectSessions(states, 0, new Date(T0 + 30 * MIN), 5 * MIN);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.durationMs).toBe(21 * MIN);
    expect(sessions[0]!.start).toEqual(new Date(T0));
    expect(sessions[0]!.end).toEqual(new Date(T0 + 21 * MIN));
  });

  it("gap exactly at tolerance boundary merges (gap = maxGap)", () => {
    // Gap of exactly 5 min, tolerance = 5 min → NOT merged (gap must be strictly less)
    const states: NormalizedState[] = [
      ns(T0,             true,  2300),
      ns(T0 + 10 * MIN,  false, null), // 5 min dip
      ns(T0 + 15 * MIN,  true,  2300), // back after 5 min
      ns(T0 + 25 * MIN,  false, null),
    ];
    const sessions = detectSessions(states, 0, new Date(T0 + 30 * MIN), 5 * MIN);
    // 5 * MIN gap is NOT > 5 * MIN, so it merges
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.durationMs).toBe(25 * MIN);
  });

  it("gap exceeding tolerance creates two separate sessions", () => {
    // 10 min active, 20 min gap, 10 min active → 2 sessions (gap > 5 min tolerance)
    const states: NormalizedState[] = [
      ns(T0,             true,  2300),
      ns(T0 + 10 * MIN,  false, null), // 20 min gap starts
      ns(T0 + 30 * MIN,  true,  2300), // came back
      ns(T0 + 40 * MIN,  false, null),
    ];
    const sessions = detectSessions(states, 0, new Date(T0 + 60 * MIN), 5 * MIN);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.durationMs).toBe(10 * MIN);
    expect(sessions[1]!.durationMs).toBe(10 * MIN);
  });

  it("multiple small gaps all merge into one session", () => {
    // Simulates EV charger with 3 brief dips (0.6 min each)
    const states: NormalizedState[] = [
      ns(T0,                   true,  2350),
      ns(T0 + 60 * MIN,        false, null), // dip 1 start
      ns(T0 + 60 * MIN + 36_000, true, 2360), // back in 36s
      ns(T0 + 120 * MIN,       false, null), // dip 2 start
      ns(T0 + 120 * MIN + 36_000, true, 2340),
      ns(T0 + 180 * MIN,       false, null), // session end
    ];
    const sessions = detectSessions(states, 0, new Date(T0 + 200 * MIN), 5 * MIN);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.start).toEqual(new Date(T0));
    expect(sessions[0]!.end).toEqual(new Date(T0 + 180 * MIN));
  });

  it("peak value spans the merged gap correctly", () => {
    const states: NormalizedState[] = [
      ns(T0,             true,  2000),
      ns(T0 + 5 * MIN,   true,  2500), // peak before gap
      ns(T0 + 10 * MIN,  false, null), // brief gap
      ns(T0 + 12 * MIN,  true,  2300), // resumed
      ns(T0 + 20 * MIN,  false, null),
    ];
    const sessions = detectSessions(states, 0, new Date(T0 + 30 * MIN), 5 * MIN);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.peakValue).toBe(2500);
  });

  it("maxGapMs=0 (default) preserves original split-on-any-inactive behaviour", () => {
    const states: NormalizedState[] = [
      ns(T0,             true,  2300),
      ns(T0 + 10 * MIN,  false, null), // 1 min gap
      ns(T0 + 11 * MIN,  true,  2350),
      ns(T0 + 21 * MIN,  false, null),
    ];
    // No maxGapMs passed → default 0 → two sessions
    const sessions = detectSessions(states, 0);
    expect(sessions).toHaveLength(2);
  });

  it("min_duration still applied after gap merge", () => {
    // Long 30-min session, then a short merged session that's only 4 min total
    // (2 min active + 2 min of gap within tolerance, closes at periodEnd)
    const states: NormalizedState[] = [
      ns(T0,             true,  2300),
      ns(T0 + 30 * MIN,  false, null), // long session ends (gap 28min > 5min)
      ns(T0 + 60 * MIN,  true,  2300), // short session starts
      ns(T0 + 61 * MIN,  false, null), // 1 min dip (within 5 min tolerance → open)
      ns(T0 + 62 * MIN,  true,  2300), // resumed
      // period ends at T0+64min → session closes there, duration = 4min < 5min → discarded
    ];
    const sessions = detectSessions(states, 5 * MIN, new Date(T0 + 64 * MIN), 5 * MIN);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.durationMs).toBe(30 * MIN);
  });
});

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------

describe("formatDuration", () => {
  it("< 60 min → minutes only", () => {
    expect(formatDuration(45 * MIN)).toBe("45 min");
    expect(formatDuration(1 * MIN)).toBe("1 min");
    expect(formatDuration(59 * MIN)).toBe("59 min");
  });

  it("exactly 1 hour → no minutes shown", () => {
    expect(formatDuration(60 * MIN)).toBe("1h");
  });

  it("hours and minutes", () => {
    expect(formatDuration(90 * MIN)).toBe("1h 30m");
    expect(formatDuration(150 * MIN)).toBe("2h 30m");
  });

  it("rounds to nearest minute", () => {
    expect(formatDuration(90 * MIN + 30_000)).toBe("1h 31m"); // 90.5 min → 1h 31m
    expect(formatDuration(90 * MIN + 29_000)).toBe("1h 30m"); // 90.48 min → 1h 30m
  });

  it("long sessions show full hours", () => {
    expect(formatDuration(14 * 60 * MIN)).toBe("14h");
    expect(formatDuration(14 * 60 * MIN + 22 * MIN)).toBe("14h 22m");
  });
});

// ---------------------------------------------------------------------------
// groupSessionsByDay
// ---------------------------------------------------------------------------

/** Build a DetectedSession from Unix-ms timestamps. */
function session(startMs: number, endMs: number, peak: number | null = null): DetectedSession {
  return { start: new Date(startMs), end: new Date(endMs), durationMs: endMs - startMs, peakValue: peak };
}

// Use a fixed UTC-based timezone so tests are deterministic regardless of host TZ.
// UTC+0 means toLocalTimestamp(ts, "UTC", true) returns the ISO date of ts.
const TZ = "UTC";

// Anchor to 2026-04-23 midnight UTC
const DAY1 = Date.UTC(2026, 3, 23);  // 2026-04-23 00:00 UTC
const DAY2 = Date.UTC(2026, 3, 24);  // 2026-04-24 00:00 UTC
const DAY3 = Date.UTC(2026, 3, 25);  // 2026-04-25 00:00 UTC

describe("groupSessionsByDay", () => {
  it("groups sessions on the same calendar day into one row", () => {
    const sessions = [
      session(DAY1 + 6 * HOUR,   DAY1 + 7 * HOUR),
      session(DAY1 + 12 * HOUR,  DAY1 + 12 * HOUR + 30 * MIN),
      session(DAY1 + 22 * HOUR,  DAY1 + 23 * HOUR),
    ];
    const rows = groupSessionsByDay(sessions, TZ);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.date).toBe("2026-04-23");
    expect(rows[0]!.count).toBe(3);
  });

  it("splits sessions across two calendar days into two rows", () => {
    const sessions = [
      session(DAY1 + 6 * HOUR,  DAY1 + 7 * HOUR),
      session(DAY2 + 8 * HOUR,  DAY2 + 9 * HOUR),
    ];
    const rows = groupSessionsByDay(sessions, TZ);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.date).toBe("2026-04-23");
    expect(rows[1]!.date).toBe("2026-04-24");
  });

  it("firstStartMs is the earliest session start in the day", () => {
    const sessions = [
      session(DAY1 + 12 * HOUR,  DAY1 + 13 * HOUR),
      session(DAY1 + 6 * HOUR,   DAY1 + 7 * HOUR),  // earlier — added second
      session(DAY1 + 22 * HOUR,  DAY1 + 23 * HOUR),
    ];
    const rows = groupSessionsByDay(sessions, TZ);
    expect(rows[0]!.firstStartMs).toBe(DAY1 + 6 * HOUR);
  });

  it("lastEndMs is the latest session end in the day", () => {
    const sessions = [
      session(DAY1 + 6 * HOUR,   DAY1 + 7 * HOUR),
      session(DAY1 + 22 * HOUR,  DAY1 + 23 * HOUR + 18 * MIN), // latest end
      session(DAY1 + 12 * HOUR,  DAY1 + 13 * HOUR),
    ];
    const rows = groupSessionsByDay(sessions, TZ);
    expect(rows[0]!.lastEndMs).toBe(DAY1 + 23 * HOUR + 18 * MIN);
  });

  it("totalActiveMs sums all session durations in the day", () => {
    const sessions = [
      session(DAY1 + 6 * HOUR,  DAY1 + 7 * HOUR),          // 1h
      session(DAY1 + 12 * HOUR, DAY1 + 12 * HOUR + 30 * MIN), // 30min
      session(DAY1 + 22 * HOUR, DAY1 + 22 * HOUR + 45 * MIN), // 45min
    ];
    const rows = groupSessionsByDay(sessions, TZ);
    expect(rows[0]!.totalActiveMs).toBe(HOUR + 30 * MIN + 45 * MIN);
  });

  it("rows are sorted chronologically by date", () => {
    const sessions = [
      session(DAY3 + 8 * HOUR, DAY3 + 9 * HOUR),
      session(DAY1 + 8 * HOUR, DAY1 + 9 * HOUR),
      session(DAY2 + 8 * HOUR, DAY2 + 9 * HOUR),
    ];
    const rows = groupSessionsByDay(sessions, TZ);
    expect(rows.map(r => r.date)).toEqual(["2026-04-23", "2026-04-24", "2026-04-25"]);
  });

  it("empty session list returns empty array", () => {
    expect(groupSessionsByDay([], TZ)).toEqual([]);
  });

  // --- day_start_hour tests ---

  it("dayStartHour=6: post-midnight session (01:30) attributed to previous date", () => {
    // DAY2 = 2026-04-24 00:00 UTC; 01:30 on Apr 24 → should go to Apr 23 bucket
    const sessions = [session(DAY2 + 1 * HOUR + 30 * MIN, DAY2 + 2 * HOUR)];
    const rows = groupSessionsByDay(sessions, TZ, 6);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.date).toBe("2026-04-23");
  });

  it("dayStartHour=6: session at exactly 06:00 stays on its own date", () => {
    // 06:00 on Apr 24 → bucket starts at Apr 24 (not pushed back to Apr 23)
    const sessions = [session(DAY2 + 6 * HOUR, DAY2 + 7 * HOUR)];
    const rows = groupSessionsByDay(sessions, TZ, 6);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.date).toBe("2026-04-24");
  });

  it("dayStartHour=6: session at 05:59 goes to previous date", () => {
    const sessions = [session(DAY2 + 5 * HOUR + 59 * MIN, DAY2 + 6 * HOUR)];
    const rows = groupSessionsByDay(sessions, TZ, 6);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.date).toBe("2026-04-23");
  });

  it("dayStartHour=6: evening + post-midnight sessions merge into one night row", () => {
    // Evening on Apr 24 at 23:00, then post-midnight at 01:00 on Apr 25 → both "Apr 24"
    const sessions = [
      session(DAY2 + 23 * HOUR, DAY2 + 23 * HOUR + 30 * MIN),
      session(DAY3 + 1 * HOUR,  DAY3 + 1 * HOUR + 30 * MIN),
    ];
    const rows = groupSessionsByDay(sessions, TZ, 6);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.date).toBe("2026-04-24");
    expect(rows[0]!.count).toBe(2);
  });

  it("dayStartHour=6: lastEndMs correctly tracks cross-midnight end time", () => {
    const sessions = [
      session(DAY2 + 23 * HOUR,              DAY2 + 23 * HOUR + 30 * MIN),
      session(DAY3 + 1 * HOUR,               DAY3 + 1 * HOUR + 45 * MIN),  // latest end
    ];
    const rows = groupSessionsByDay(sessions, TZ, 6);
    expect(rows[0]!.lastEndMs).toBe(DAY3 + 1 * HOUR + 45 * MIN);
  });

  it("dayStartHour=0: default behaviour identical to no argument", () => {
    const sessions = [
      session(DAY1 + 23 * HOUR, DAY1 + 23 * HOUR + 30 * MIN),
      session(DAY2 + 1 * HOUR,  DAY2 + 1 * HOUR + 30 * MIN),
    ];
    const withZero   = groupSessionsByDay(sessions, TZ, 0);
    const withDefault = groupSessionsByDay(sessions, TZ);
    expect(withZero).toEqual(withDefault);
    // Both sessions in different calendar days with dayStartHour=0
    expect(withZero).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// formatSessionOutput / formatDailySummary — table fencing
// ---------------------------------------------------------------------------

describe("formatSessionOutput — table fencing", () => {
  it("fences the session list but leaves the config line and summary as prose", () => {
    const sessions = [
      session(DAY1 + 8 * HOUR, DAY1 + 8 * HOUR + 45 * MIN, 1500),
      session(DAY2 + 9 * HOUR, DAY2 + 9 * HOUR + 30 * MIN, 1200),
    ];
    const result = formatSessionOutput(
      sessions,
      new Date(DAY1),
      new Date(DAY3),
      "2026-04-23 to 2026-04-25",
      "Sensor: EV Charger (sensor.ev_charger_power)",
      " W",
      "≥ 1000 W",
      1,
      0,
      "Hourly statistics (±1h precision, full retention)",
      20,
      false,
      TZ,
    );

    const fenceStart = result.indexOf("```");
    const fenceEnd = result.lastIndexOf("```");
    expect(fenceStart).toBeGreaterThan(-1);
    expect(fenceEnd).toBeGreaterThan(fenceStart);

    // Sensor/period/source prose and the summary line stay outside the fence.
    const prose = result.slice(0, fenceStart);
    expect(prose).toContain("Sensor: EV Charger");
    expect(prose).toContain("2 sessions");
    expect(prose).not.toContain("```");

    // The session rows are inside the fence.
    const fenced = result.slice(fenceStart, fenceEnd + 3);
    expect(fenced).toContain("peak 1500");
    expect(fenced).toContain("peak 1200");
  });

  it("does not fence the 0-sessions message (single prose line)", () => {
    const result = formatSessionOutput(
      [],
      new Date(DAY1),
      new Date(DAY2),
      "2026-04-23",
      "Sensor: EV Charger (sensor.ev_charger_power)",
      " W",
      "≥ 1000 W",
      1,
      0,
      "Hourly statistics",
      20,
      false,
      TZ,
    );
    expect(result).not.toContain("```");
    expect(result).toContain("0 sessions detected");
  });
});

describe("formatDailySummary — table fencing", () => {
  it("fences the header row and daily rows but leaves the summary as prose", () => {
    const sessions = [
      session(DAY1 + 8 * HOUR, DAY1 + 8 * HOUR + 45 * MIN),
      session(DAY2 + 9 * HOUR, DAY2 + 9 * HOUR + 30 * MIN),
    ];
    const result = formatDailySummary(
      sessions,
      new Date(DAY1),
      new Date(DAY3),
      "2026-04-23 to 2026-04-25",
      "Sensor: EV Charger (sensor.ev_charger_power)",
      " W",
      "≥ 1000 W",
      1,
      0,
      "Hourly statistics (±1h precision, full retention)",
      20,
      false,
      TZ,
    );

    const fenceStart = result.indexOf("```");
    const fenceEnd = result.lastIndexOf("```");
    expect(fenceStart).toBeGreaterThan(-1);
    expect(fenceEnd).toBeGreaterThan(fenceStart);

    const prose = result.slice(0, fenceStart);
    expect(prose).toContain("Sensor: EV Charger");
    expect(prose).toContain("active days");

    const fenced = result.slice(fenceStart, fenceEnd + 3);
    expect(fenced).toContain("Date | Sessions | First | Last | Active");
    expect(fenced).toContain("2026-04-23");
    expect(fenced).toContain("2026-04-24");
  });
});

// ---------------------------------------------------------------------------
// Handler-level rejections added after the 2026-08-16 live benchmark
// ---------------------------------------------------------------------------

import { handleDetectSessions } from "../tools/detect-sessions.js";

describe("handleDetectSessions rejections", () => {
  it("routes discrete-state entities to get_state_history instead of a failed catalog lookup", async () => {
    const result = await handleDetectSessions({
      entity_id: "binary_sensor.aquara_motion",
      threshold: 1,
    });
    expect(result).toContain("ERROR");
    expect(result).toContain("discrete-state");
    expect(result).toContain("ha_history_get_state_history");
    expect(result).not.toContain("not found");
  });

  it("rejects group_by='hour_of_day' with a routing hint to get_sensor_stats", async () => {
    const result = await handleDetectSessions({
      entity_id: "sensor.heater_power",
      threshold: 50,
      group_by: "hour_of_day",
    });
    expect(result).toContain("ERROR");
    expect(result).toContain("NOT executed");
    expect(result).toContain("ha_history_get_sensor_stats");
  });
});
