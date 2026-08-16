/**
 * Fixture-based integration tests for detect-sessions core functions.
 *
 * These tests use synthetic HA history data (generated to mirror the shapes
 * real HA history/statistics payloads take — see scripts/capture-fixture.ts)
 * to verify that the session detection algorithm handles realistic data
 * shapes correctly.
 *
 * Key data-shape properties verified:
 * - History uses `lu` (last_updated), not `lc` (last_changed) — getTime() fallback path
 * - Timestamps are Unix seconds (as in real HA history payloads)
 * - Binary sensor data contains "unavailable" states to filter
 * - "unavailable" can appear mid-stream (simulated device restart)
 * - Numeric sensor raw history has brief duty-cycle dips mid-session, used
 *   here to exercise gap-bridging (max_gap_minutes)
 * - Motion events span midnight, used to exercise day_start_hour grouping
 *
 * The synthetic data's ground truth is known exactly (it's generated), so
 * expectations below are derived from that ground truth rather than loose
 * bounds — see the generator's output for the values asserted here.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import {
  normalizeStatesToActive,
  normalizeStatRows,
  detectSessions,
  groupSessionsByDay,
} from "../tools/detect-sessions.js";
import type { HistoryState, StatisticRow } from "../ha-client.js";

// ---------------------------------------------------------------------------
// Load fixtures
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): { history: Record<string, HistoryState[]>; statistics: Record<string, StatisticRow[]> } {
  const path = join(__dirname, "fixtures", name);
  const raw = JSON.parse(readFileSync(path, "utf8")) as {
    history: Record<string, HistoryState[]>;
    statistics: Record<string, StatisticRow[]>;
  };
  return { history: raw.history ?? {}, statistics: raw.statistics ?? {} };
}

const motionFixture = loadFixture("motion-entrance.json");
const carChargerFixture = loadFixture("car-charger-power.json");

const motionHistory = motionFixture.history["binary_sensor.hallway_motion"]!;
const carChargerHistory = carChargerFixture.history["sensor.ev_charger_power"]!;
const carChargerStats = carChargerFixture.statistics["sensor.ev_charger_power"]!;

// ---------------------------------------------------------------------------
// Motion sensor (binary) — 6 days of synthetic data
// ---------------------------------------------------------------------------

describe("normalizeStatesToActive — synthetic binary sensor (lu timestamps, unavailable states)", () => {
  it("returns only 'on' and 'off' states — filters unavailable", () => {
    const normalized = normalizeStatesToActive(motionHistory, "on");
    const states = new Set(normalized.map((s) => s.isActive));
    // Only true/false, no undefined
    expect(states.has(true)).toBe(true);
    expect(states.has(false)).toBe(true);
    // All unavailable/unknown filtered out
    const totalStates = motionHistory.length;
    const unavailableCount = motionHistory.filter(
      (h) => !["on", "off"].includes((h.s ?? h.state ?? "").toLowerCase())
    ).length;
    expect(unavailableCount).toBe(6); // one simulated restart blip per day, 6 days
    expect(normalized.length).toBe(totalStates - unavailableCount);
  });

  it("reads lu timestamps correctly (fallback from lc to lu)", () => {
    // All fixture entries use `lu`, not `lc`
    const hasLu = motionHistory.every((h) => h.lu !== undefined);
    const hasLc = motionHistory.some((h) => h.lc !== undefined);
    expect(hasLu).toBe(true);
    expect(hasLc).toBe(false); // confirms we're testing the lu fallback path

    const normalized = normalizeStatesToActive(motionHistory, "on");
    // All times should be valid dates — verify they're in a plausible year range
    const year2020Ms = Date.UTC(2020, 0, 1);
    const year2030Ms = Date.UTC(2030, 0, 1);
    for (const s of normalized) {
      expect(s.time.getTime()).toBeGreaterThan(year2020Ms);
      expect(s.time.getTime()).toBeLessThan(year2030Ms);
    }
  });

  it("timestamps are sorted in ascending order", () => {
    const normalized = normalizeStatesToActive(motionHistory, "on");
    for (let i = 1; i < normalized.length; i++) {
      expect(normalized[i]!.time.getTime()).toBeGreaterThanOrEqual(
        normalized[i - 1]!.time.getTime()
      );
    }
  });

  it("rawValue is null for binary sensor states", () => {
    const normalized = normalizeStatesToActive(motionHistory, "on");
    expect(normalized.every((s) => s.rawValue === null)).toBe(true);
  });
});

describe("detectSessions — synthetic binary sensor over 6 days", () => {
  const periodEnd = new Date(motionFixture.history["binary_sensor.hallway_motion"]![0]!.lu! * 1000 + 6 * 86_400_000);

  it("detects the exact known number of motion events (6d, no min_duration)", () => {
    const normalized = normalizeStatesToActive(motionHistory, "on");
    const sessions = detectSessions(normalized, 0, periodEnd);
    // Ground truth from the generator: 11 bursts/day * 6 days + 2 extra
    // cross-midnight bursts, all separated by intervening "off"/"unavailable" gaps.
    expect(sessions.length).toBe(68);
  });

  it("min_duration = 60s reduces session count but keeps medium-length bursts", () => {
    const normalized = normalizeStatesToActive(motionHistory, "on");
    const all = detectSessions(normalized, 0, periodEnd);
    const filtered = detectSessions(normalized, 60_000, periodEnd);
    // Most daily bursts are brief (< 1 min) — filter eliminates the majority,
    // but the one ~90s "medium" burst per day survives this filter.
    expect(filtered.length).toBeLessThan(all.length);
    expect(filtered.length).toBe(20);
  });

  it("min_duration = 5min filters to only sustained motion events", () => {
    const normalized = normalizeStatesToActive(motionHistory, "on");
    const sessions = detectSessions(normalized, 5 * 60_000, periodEnd);
    // The ~90s "medium" burst is dropped at this threshold (60s survivors
    // shrink from 20 to 14) — only the two sustained ~6min bursts per day,
    // plus the two dedicated cross-midnight events, remain.
    expect(sessions.length).toBe(14);
    for (const s of sessions) {
      expect(s.durationMs).toBeGreaterThanOrEqual(5 * 60_000);
    }
  });

  it("session durations are always positive", () => {
    const normalized = normalizeStatesToActive(motionHistory, "on");
    const sessions = detectSessions(normalized, 0, periodEnd);
    for (const s of sessions) {
      expect(s.durationMs).toBeGreaterThan(0);
      expect(s.end.getTime()).toBeGreaterThan(s.start.getTime());
    }
  });

  it("sessions are sorted in chronological order", () => {
    const normalized = normalizeStatesToActive(motionHistory, "on");
    const sessions = detectSessions(normalized, 0, periodEnd);
    for (let i = 1; i < sessions.length; i++) {
      expect(sessions[i]!.start.getTime()).toBeGreaterThan(
        sessions[i - 1]!.end.getTime()
      );
    }
  });

  it("all sessions fall within the fixture's capture period", () => {
    const normalized = normalizeStatesToActive(motionHistory, "on");
    const sessions = detectSessions(normalized, 0, periodEnd);
    const fixtureStart = new Date(motionHistory[0]!.lu! * 1000);
    for (const s of sessions) {
      expect(s.start.getTime()).toBeGreaterThanOrEqual(fixtureStart.getTime());
      expect(s.end.getTime()).toBeLessThanOrEqual(periodEnd.getTime() + 1000);
    }
  });

  it("includes an event that spans midnight (23:58 -> 00:07 next day)", () => {
    const normalized = normalizeStatesToActive(motionHistory, "on");
    const sessions = detectSessions(normalized, 5 * 60_000, periodEnd);
    const crossMidnight = sessions.find(
      (s) =>
        s.start.toISOString() === "2026-07-08T23:58:00.000Z" &&
        s.end.toISOString() === "2026-07-09T00:07:00.000Z"
    );
    expect(crossMidnight).toBeDefined();
  });
});

describe("groupSessionsByDay — day_start_hour shifts post-midnight activity to the previous day", () => {
  const periodEnd = new Date(motionHistory[0]!.lu! * 1000 + 6 * 86_400_000);
  const normalized = normalizeStatesToActive(motionHistory, "on");
  const sessions = detectSessions(normalized, 0, periodEnd);

  it("total session count is preserved across both groupings", () => {
    const byMidnight = groupSessionsByDay(sessions, "UTC", 0);
    const byNightBoundary = groupSessionsByDay(sessions, "UTC", 6);
    const sum = (rows: { count: number }[]) =>
      rows.reduce((s, r) => s + r.count, 0);
    expect(sum(byMidnight)).toBe(sessions.length);
    expect(sum(byNightBoundary)).toBe(sessions.length);
  });

  it("with day_start_hour=0, the 00:10 event on 2026-07-10 is grouped under 2026-07-10", () => {
    const byMidnight = groupSessionsByDay(sessions, "UTC", 0);
    const day10 = byMidnight.find((r) => r.date === "2026-07-10");
    const day09 = byMidnight.find((r) => r.date === "2026-07-09");
    expect(day10?.count).toBe(12);
    expect(day09?.count).toBe(11);
  });

  it("with day_start_hour=6, the same 00:10 event is attributed to the previous evening (2026-07-09)", () => {
    const byNightBoundary = groupSessionsByDay(sessions, "UTC", 6);
    const day10 = byNightBoundary.find((r) => r.date === "2026-07-10");
    const day09 = byNightBoundary.find((r) => r.date === "2026-07-09");
    // One session moves from 07-10 to 07-09 relative to the midnight boundary
    expect(day09?.count).toBe(12);
    expect(day10?.count).toBe(11);
  });
});

// ---------------------------------------------------------------------------
// EV charger — hourly statistics (30 days, synthetic data)
// The statistics fixture encodes 9 clean overnight charging sessions.
// Mean values smooth out the 35-second duty-cycle dips visible in the raw
// history excerpt (see the gap-bridging describe block below).
// ---------------------------------------------------------------------------

describe("EV charger — statistics-based session detection", () => {
  const THRESHOLD = 100;
  const MIN_DUR = 5 * 60_000; // 5 min (but hourly data → effective min is 1 hour)

  it("fixture has statistics data for the EV charger", () => {
    expect(carChargerStats).toBeDefined();
    expect(carChargerStats.length).toBeGreaterThan(0);
  });

  it("statistics rows have expected fields", () => {
    const row = carChargerStats[0]!;
    expect(typeof row.start).toBe("number");
    expect(typeof row.end).toBe("number");
    expect(row.end - row.start).toBe(3_600_000); // exactly 1 hour bucket
  });

  it("normalizeStatRows produces normalized states from the fixture", () => {
    const normalized = normalizeStatRows(carChargerStats, THRESHOLD);
    expect(normalized.length).toBeGreaterThan(0);
    // All have valid timestamps
    for (const s of normalized) {
      expect(s.time.getTime()).toBeGreaterThan(0);
      expect(typeof s.isActive).toBe("boolean");
    }
  });

  it("statistics-based detection finds exactly 9 clean charging sessions in 30 days", () => {
    const normalized = normalizeStatRows(carChargerStats, THRESHOLD);
    const sessions = detectSessions(normalized, MIN_DUR);
    expect(sessions.length).toBe(9);
  });

  it("session durations match the known generated schedule (5h-16h)", () => {
    const normalized = normalizeStatRows(carChargerStats, THRESHOLD);
    const sessions = detectSessions(normalized, MIN_DUR);
    const hours = sessions.map((s) => s.durationMs / 3_600_000);
    expect(hours).toEqual([8, 6, 10, 5, 12, 7, 9, 6, 16]);
  });

  it("sessions are sorted chronologically with no overlaps", () => {
    const normalized = normalizeStatRows(carChargerStats, THRESHOLD);
    const sessions = detectSessions(normalized, MIN_DUR);
    for (let i = 1; i < sessions.length; i++) {
      expect(sessions[i]!.start.getTime()).toBeGreaterThan(
        sessions[i - 1]!.end.getTime()
      );
    }
  });

  it("first session starts 2026-06-03 (crossing into the next calendar day)", () => {
    const normalized = normalizeStatRows(carChargerStats, THRESHOLD);
    const sessions = detectSessions(normalized, MIN_DUR);
    const first = sessions[0]!;
    expect(first.start.toISOString().slice(0, 10)).toBe("2026-06-03");
    // 22:00 start + 8h duration crosses midnight into 2026-06-04
    expect(first.end.toISOString().slice(0, 10)).toBe("2026-06-04");
  });

  it("peak values are non-null and above threshold", () => {
    const normalized = normalizeStatRows(carChargerStats, THRESHOLD);
    const sessions = detectSessions(normalized, MIN_DUR);
    for (const s of sessions) {
      expect(s.peakValue).not.toBeNull();
      expect(s.peakValue!).toBeGreaterThanOrEqual(THRESHOLD);
    }
  });
});

// ---------------------------------------------------------------------------
// EV charger — raw history: gap-bridging (max_gap_minutes) via a deliberate
// ~90s duty-cycle dip injected mid-session by the fixture generator.
// ---------------------------------------------------------------------------

describe("EV charger — raw history gap-bridging (max_gap_minutes)", () => {
  const THRESHOLD = 100;

  // Raw history isn't hourly statistics, so build NormalizedState directly
  // from the numeric string values (mirrors what a numeric-threshold
  // consumer of raw history would do).
  function normalizeRaw(rows: HistoryState[]) {
    return rows
      .map((h) => ({
        time: new Date((h.lu as number) * 1000),
        isActive: parseFloat((h.s as string) ?? "0") >= THRESHOLD,
        rawValue: parseFloat((h.s as string) ?? "0"),
      }))
      .sort((a, b) => a.time.getTime() - b.time.getTime());
  }

  it("without gap bridging, the duty-cycle dip splits one charging session into two", () => {
    const normalized = normalizeRaw(carChargerHistory);
    const sessions = detectSessions(normalized, 0, undefined, 0);
    // 3 sessions are represented in the raw-history excerpt; the first one
    // (2026-06-03 22:00) contains a deliberate ~90s dip, so it splits in two.
    expect(sessions.length).toBe(4);
  });

  it("with a 2-minute gap tolerance, the dip is bridged into a single session", () => {
    const normalized = normalizeRaw(carChargerHistory);
    const sessions = detectSessions(normalized, 0, undefined, 2 * 60_000);
    expect(sessions.length).toBe(3);
    // The bridged session now spans the full original range unbroken.
    const bridged = sessions[0]!;
    expect(bridged.start.toISOString()).toBe("2026-06-03T22:00:00.000Z");
    expect(bridged.end.toISOString()).toBe("2026-06-04T06:05:00.000Z");
  });

  it("gap tolerance shorter than the dip does not bridge it", () => {
    const normalized = normalizeRaw(carChargerHistory);
    const sessions = detectSessions(normalized, 0, undefined, 30_000); // 30s < ~105s measured gap
    expect(sessions.length).toBe(4);
  });
});
