/**
 * Tests for get-state-history.ts — pure functions only.
 * No HA connection required.
 *
 * Tests:
 *   normalizeStatesToActive — state matching, filtering, timestamps
 *   buildTimeline           — timeline extraction and ordering
 *   detectSessions (via session-core) — integration with normalizeStatesToActive
 */

import { describe, it, expect } from "vitest";
import { buildTimeline } from "../tools/get-state-history.js";
import { detectSessions, normalizeStatesToActive } from "../tools/session-core.js";
import type { HistoryState } from "../ha-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build an abbreviated HistoryState (lc = Unix seconds float). */
function hs(lc: number, s: string): HistoryState {
  return { lc, s };
}

/** Build a HistoryState with lu (last_updated) instead of lc. */
function hsLu(lu: number, s: string): HistoryState {
  return { lu, s };
}

const T0 = 1_000_000_000_000; // ms
const MIN = 60_000;

// ---------------------------------------------------------------------------
// normalizeStatesToActive
// ---------------------------------------------------------------------------

describe("normalizeStatesToActive — binary sensor (on/off)", () => {
  it("maps 'on' to isActive=true, 'off' to isActive=false", () => {
    const raw = [
      hs(T0 / 1000, "on"),
      hs((T0 + 30 * MIN) / 1000, "off"),
    ];
    const result = normalizeStatesToActive(raw, "on");
    expect(result).toHaveLength(2);
    expect(result[0]!.isActive).toBe(true);
    expect(result[1]!.isActive).toBe(false);
  });

  it("case-insensitive: 'ON', 'On', 'on' all match target 'on'", () => {
    const raw = [
      hs(T0 / 1000,             "ON"),
      hs((T0 + MIN) / 1000,     "On"),
      hs((T0 + 2 * MIN) / 1000, "on"),
    ];
    const result = normalizeStatesToActive(raw, "on");
    expect(result.every(s => s.isActive)).toBe(true);
  });

  it("case-insensitive: target 'ON' matches state 'on'", () => {
    const raw = [hs(T0 / 1000, "on")];
    const result = normalizeStatesToActive(raw, "ON");
    expect(result[0]!.isActive).toBe(true);
  });

  it("rawValue is always null (discrete states have no numeric value)", () => {
    const raw = [
      hs(T0 / 1000,         "on"),
      hs((T0 + MIN) / 1000, "off"),
    ];
    const result = normalizeStatesToActive(raw, "on");
    expect(result.every(s => s.rawValue === null)).toBe(true);
  });

  it("filters out unavailable states", () => {
    const raw = [
      hs(T0 / 1000,             "on"),
      hs((T0 + 10 * MIN) / 1000, "unavailable"),
      hs((T0 + 20 * MIN) / 1000, "off"),
    ];
    const result = normalizeStatesToActive(raw, "on");
    expect(result).toHaveLength(2);
  });

  it("filters out unknown states", () => {
    const raw = [
      hs(T0 / 1000,             "on"),
      hs((T0 + 10 * MIN) / 1000, "unknown"),
      hs((T0 + 20 * MIN) / 1000, "off"),
    ];
    const result = normalizeStatesToActive(raw, "on");
    expect(result).toHaveLength(2);
  });

  it("empty input returns empty array", () => {
    expect(normalizeStatesToActive([], "on")).toEqual([]);
  });

  it("sorts by time defensively", () => {
    const raw = [
      hs((T0 + 2 * MIN) / 1000, "off"),
      hs(T0 / 1000,              "on"),
    ];
    const result = normalizeStatesToActive(raw, "on");
    expect(result[0]!.time.getTime()).toBe(T0);
    expect(result[1]!.time.getTime()).toBe(T0 + 2 * MIN);
  });

  it("reads lc timestamps (Unix seconds float)", () => {
    const raw = [hs(T0 / 1000, "on")];
    const result = normalizeStatesToActive(raw, "on");
    expect(result[0]!.time.getTime()).toBe(T0);
  });

  it("reads lu timestamps (fallback when lc absent)", () => {
    const raw = [hsLu(T0 / 1000, "on")];
    const result = normalizeStatesToActive(raw, "on");
    expect(result[0]!.time.getTime()).toBe(T0);
  });
});

describe("normalizeStatesToActive — person/zone state matching", () => {
  it("matches zone name 'LFO' exactly (case-insensitive)", () => {
    const raw = [
      hs(T0 / 1000,             "home"),
      hs((T0 + 30 * MIN) / 1000, "LFO"),
      hs((T0 + 90 * MIN) / 1000, "not_home"),
    ];
    const result = normalizeStatesToActive(raw, "LFO");
    expect(result).toHaveLength(3);
    expect(result[0]!.isActive).toBe(false); // home
    expect(result[1]!.isActive).toBe(true);  // LFO
    expect(result[2]!.isActive).toBe(false); // not_home
  });

  it("matches 'home' zone", () => {
    const raw = [
      hs(T0 / 1000,              "not_home"),
      hs((T0 + 60 * MIN) / 1000, "home"),
      hs((T0 + 90 * MIN) / 1000, "LFO"),
    ];
    const result = normalizeStatesToActive(raw, "home");
    expect(result[0]!.isActive).toBe(false);
    expect(result[1]!.isActive).toBe(true);
    expect(result[2]!.isActive).toBe(false);
  });

  it("'lfo' (lowercase target) matches state 'LFO' (uppercase value)", () => {
    const raw = [hs(T0 / 1000, "LFO")];
    const result = normalizeStatesToActive(raw, "lfo");
    expect(result[0]!.isActive).toBe(true);
  });

  it("non-matching zone name gives all inactive", () => {
    const raw = [
      hs(T0 / 1000,              "home"),
      hs((T0 + 60 * MIN) / 1000, "LFO"),
    ];
    const result = normalizeStatesToActive(raw, "work");
    expect(result.every(s => !s.isActive)).toBe(true);
  });

  it("'!home' matches any non-home state", () => {
    const raw = [
      hs(T0 / 1000,               "home"),
      hs((T0 + 60 * MIN) / 1000,  "Opera"),
      hs((T0 + 120 * MIN) / 1000, "not_home"),
    ];
    const result = normalizeStatesToActive(raw, "!home");
    expect(result[0]!.isActive).toBe(false);
    expect(result[1]!.isActive).toBe(true);
    expect(result[2]!.isActive).toBe(true);
  });
});

describe("normalizeStatesToActive — session detection integration", () => {
  it("binary sensor: detects one session between on→off", () => {
    const raw = [
      hs(T0 / 1000,              "on"),
      hs((T0 + 45 * MIN) / 1000, "off"),
    ];
    const normalized = normalizeStatesToActive(raw, "on");
    const sessions = detectSessions(normalized, 0, new Date(T0 + 60 * MIN));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.durationMs).toBe(45 * MIN);
    expect(sessions[0]!.peakValue).toBeNull(); // discrete state, no peak
  });

  it("person zone: detects arrival and stay at LFO", () => {
    const raw = [
      hs(T0 / 1000,               "home"),
      hs((T0 + 60 * MIN) / 1000,  "LFO"),   // arrived LFO
      hs((T0 + 420 * MIN) / 1000, "not_home"), // left
    ];
    const normalized = normalizeStatesToActive(raw, "LFO");
    const sessions = detectSessions(normalized, 0, new Date(T0 + 480 * MIN));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.start.getTime()).toBe(T0 + 60 * MIN);
    expect(sessions[0]!.end.getTime()).toBe(T0 + 420 * MIN);
    expect(sessions[0]!.durationMs).toBe(360 * MIN); // 6 hours
  });

  it("multiple zone visits: counts separate arrivals", () => {
    const raw = [
      hs(T0 / 1000,               "home"),
      hs((T0 + 60 * MIN) / 1000,  "LFO"),
      hs((T0 + 120 * MIN) / 1000, "home"),
      hs((T0 + 180 * MIN) / 1000, "LFO"),
      hs((T0 + 240 * MIN) / 1000, "home"),
    ];
    const normalized = normalizeStatesToActive(raw, "LFO");
    const sessions = detectSessions(normalized, 0, new Date(T0 + 300 * MIN));
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.durationMs).toBe(60 * MIN);
    expect(sessions[1]!.durationMs).toBe(60 * MIN);
  });

  it("'!home' treats different non-home zones as one continuous outside-home session until returning home", () => {
    const raw = [
      hs(T0 / 1000,               "home"),
      hs((T0 + 60 * MIN) / 1000,  "Opera"),
      hs((T0 + 180 * MIN) / 1000, "School"),
      hs((T0 + 300 * MIN) / 1000, "home"),
    ];
    const normalized = normalizeStatesToActive(raw, "!home");
    const sessions = detectSessions(normalized, 0, new Date(T0 + 360 * MIN));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.start.getTime()).toBe(T0 + 60 * MIN);
    expect(sessions[0]!.end.getTime()).toBe(T0 + 300 * MIN);
    expect(sessions[0]!.durationMs).toBe(240 * MIN);
  });

  it("min_duration filters out brief zone visits", () => {
    const raw = [
      hs(T0 / 1000,              "LFO"),  // 2 min visit
      hs((T0 + 2 * MIN) / 1000,  "home"),
      hs((T0 + 60 * MIN) / 1000, "LFO"),  // 60 min visit
      hs((T0 + 120 * MIN) / 1000, "home"),
    ];
    const normalized = normalizeStatesToActive(raw, "LFO");
    const sessions = detectSessions(normalized, 5 * MIN, new Date(T0 + 180 * MIN));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.durationMs).toBe(60 * MIN);
  });

  it("open session at end: closed at periodEnd", () => {
    const periodEnd = new Date(T0 + 120 * MIN);
    const raw = [
      hs(T0 / 1000, "home"), // arrived home, never leaves
    ];
    const normalized = normalizeStatesToActive(raw, "home");
    const sessions = detectSessions(normalized, 0, periodEnd);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.end.getTime()).toBe(T0 + 120 * MIN);
  });
});

// ---------------------------------------------------------------------------
// buildTimeline
// ---------------------------------------------------------------------------

describe("buildTimeline", () => {
  it("extracts all valid state transitions", () => {
    const raw: HistoryState[] = [
      hs(T0 / 1000,             "home"),
      hs((T0 + 60 * MIN) / 1000, "LFO"),
      hs((T0 + 120 * MIN) / 1000, "not_home"),
    ];
    const entries = buildTimeline(raw);
    expect(entries).toHaveLength(3);
    expect(entries[0]!.state).toBe("home");
    expect(entries[1]!.state).toBe("LFO");
    expect(entries[2]!.state).toBe("not_home");
  });

  it("filters unavailable and unknown states", () => {
    const raw: HistoryState[] = [
      hs(T0 / 1000,              "home"),
      hs((T0 + 10 * MIN) / 1000, "unavailable"),
      hs((T0 + 20 * MIN) / 1000, "unknown"),
      hs((T0 + 30 * MIN) / 1000, "LFO"),
    ];
    const entries = buildTimeline(raw);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.state).toBe("home");
    expect(entries[1]!.state).toBe("LFO");
  });

  it("sorts entries chronologically", () => {
    const raw: HistoryState[] = [
      hs((T0 + 60 * MIN) / 1000, "LFO"),
      hs(T0 / 1000,              "home"),
    ];
    const entries = buildTimeline(raw);
    expect(entries[0]!.time.getTime()).toBe(T0);
    expect(entries[1]!.time.getTime()).toBe(T0 + 60 * MIN);
  });

  it("returns timestamps as Date objects", () => {
    const raw: HistoryState[] = [hs(T0 / 1000, "on")];
    const entries = buildTimeline(raw);
    expect(entries[0]!.time).toBeInstanceOf(Date);
    expect(entries[0]!.time.getTime()).toBe(T0);
  });

  it("empty input returns empty array", () => {
    expect(buildTimeline([])).toEqual([]);
  });

  it("works with lu timestamps", () => {
    const raw: HistoryState[] = [hsLu(T0 / 1000, "home")];
    const entries = buildTimeline(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.time.getTime()).toBe(T0);
  });

  it("preserves original state strings including mixed case and underscores", () => {
    const raw: HistoryState[] = [
      hs(T0 / 1000,             "not_home"),
      hs((T0 + MIN) / 1000,     "LFO"),
      hs((T0 + 2 * MIN) / 1000, "Morning_Routine"),
    ];
    const entries = buildTimeline(raw);
    expect(entries[0]!.state).toBe("not_home");
    expect(entries[1]!.state).toBe("LFO");
    expect(entries[2]!.state).toBe("Morning_Routine");
  });
});

// ---------------------------------------------------------------------------
// Handler-level rejections added after the 2026-08-16 live benchmark
// ---------------------------------------------------------------------------

import { handleGetStateHistory } from "../tools/get-state-history.js";

describe("handleGetStateHistory rejections", () => {
  it("rejects group_by values other than 'day' instead of silently ignoring them", async () => {
    const result = await handleGetStateHistory({
      entity_id: "binary_sensor.x",
      state_value: "on",
      group_by: "hour_of_day",
    });
    expect(result).toContain("ERROR");
    expect(result).toContain("NOT executed");
    expect(result).toContain('group_by="day"');
  });
});
