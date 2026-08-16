/**
 * Tests for tool-utils.ts — pure helper functions only.
 * (getTz and formatSensorLine are integration-bound and skipped here.)
 */

import { describe, it, expect } from "vitest";
import { matchesFilter, round, toLocalTimestamp, capitalize, parseMaxResults, statsEndTime, percentage, fenceTable } from "../tool-utils.js";

// ---------------------------------------------------------------------------
// matchesFilter
// ---------------------------------------------------------------------------

describe("matchesFilter", () => {
  it("< operator", () => {
    expect(matchesFilter(5, "<", 10)).toBe(true);
    expect(matchesFilter(10, "<", 10)).toBe(false);
    expect(matchesFilter(15, "<", 10)).toBe(false);
  });

  it("<= operator", () => {
    expect(matchesFilter(10, "<=", 10)).toBe(true);
    expect(matchesFilter(9.9, "<=", 10)).toBe(true);
    expect(matchesFilter(10.1, "<=", 10)).toBe(false);
  });

  it("> operator", () => {
    expect(matchesFilter(0, ">", 0)).toBe(false);
    expect(matchesFilter(-1, ">", 0)).toBe(false);
    expect(matchesFilter(0.1, ">", 0)).toBe(true);
  });

  it(">= operator", () => {
    expect(matchesFilter(0, ">=", 0)).toBe(true);
    expect(matchesFilter(-0.1, ">=", 0)).toBe(false);
  });

  it("= operator (exact equality)", () => {
    expect(matchesFilter(21, "=", 21)).toBe(true);
    expect(matchesFilter(21.0, "=", 21)).toBe(true);
    expect(matchesFilter(21.1, "=", 21)).toBe(false);
  });

  it("freezing temperature use case: < 0", () => {
    expect(matchesFilter(-0.1, "<", 0)).toBe(true);
    expect(matchesFilter(0, "<", 0)).toBe(false);
    expect(matchesFilter(0.1, "<", 0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// round
// ---------------------------------------------------------------------------

describe("round", () => {
  it("default 1 decimal", () => {
    expect(round(3.14159)).toBe("3.1");
    expect(round(3.15)).toBe("3.2");
    expect(round(3.05)).toBe("3.1");
  });

  it("0 decimals", () => {
    expect(round(3.6, 0)).toBe("4");
    expect(round(3.4, 0)).toBe("3");
  });

  it("2 decimals (energy/kWh use case)", () => {
    expect(round(104.994, 2)).toBe("104.99");
    expect(round(104.996, 2)).toBe("105");
    expect(round(10.005, 2)).toBe("10.01");
  });

  it("returns string", () => {
    expect(typeof round(1.23)).toBe("string");
  });

  it("negative values", () => {
    expect(round(-3.14159)).toBe("-3.1");
    expect(round(-0.05)).toBe("-0.1");
  });

  it("integer (no trailing zero)", () => {
    expect(round(5.0, 1)).toBe("5");
  });
});

// ---------------------------------------------------------------------------
// toLocalTimestamp
// ---------------------------------------------------------------------------

describe("toLocalTimestamp", () => {
  // 2026-05-03T12:00:00Z = 14:00 in Europe/Berlin (UTC+2)
  const unixMs = new Date("2026-05-03T12:00:00Z").getTime();
  const tz = "Europe/Berlin";

  it("datetime mode includes time", () => {
    const result = toLocalTimestamp(unixMs, tz, false);
    expect(result).toContain("2026-05-03");
    expect(result).toContain("14:00");
  });

  it("date-only mode omits time", () => {
    const result = toLocalTimestamp(unixMs, tz, true);
    expect(result).toBe("2026-05-03");
    expect(result).not.toContain("14:00");
  });

  it("reflects timezone offset (UTC vs Berlin differ)", () => {
    const utcResult = toLocalTimestamp(unixMs, "UTC", false);
    const berlinResult = toLocalTimestamp(unixMs, tz, false);
    expect(utcResult).toContain("12:00");
    expect(berlinResult).toContain("14:00");
  });

  it("falls back gracefully for invalid timezone", () => {
    // Should not throw, just return something usable
    expect(() => toLocalTimestamp(unixMs, "Invalid/Timezone")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// capitalize
// ---------------------------------------------------------------------------

describe("capitalize", () => {
  it("lowercases first char → uppercase", () => {
    expect(capitalize("hello")).toBe("Hello");
  });

  it("already capitalized → unchanged", () => {
    expect(capitalize("World")).toBe("World");
  });

  it("empty string", () => {
    expect(capitalize("")).toBe("");
  });

  it("single character", () => {
    expect(capitalize("a")).toBe("A");
  });
});

// ---------------------------------------------------------------------------
// statsEndTime
// ---------------------------------------------------------------------------

describe("statsEndTime", () => {
  it("returns 1ms before the given time", () => {
    const end = new Date("2026-05-01T00:00:00.000Z"); // May 1 00:00 UTC — HA bucket boundary
    const adjusted = statsEndTime(end);
    expect(adjusted.getTime()).toBe(end.getTime() - 1);
    expect(adjusted.toISOString()).toBe("2026-04-30T23:59:59.999Z");
  });

  it("prevents bucket-start-at-boundary from being included", () => {
    // Scenario: end_time="2026-04-30" in Europe/Berlin → extends to May 1 00:00 Berlin = April 30 22:00 UTC
    // May monthly bucket starts at April 30 22:00 UTC — statsEndTime excludes it
    const end = new Date("2026-04-30T22:00:00.000Z");
    const adjusted = statsEndTime(end);
    expect(adjusted.toISOString()).toBe("2026-04-30T21:59:59.999Z");
    // May bucket starts at 2026-04-30T22:00:00.000Z > adjusted — excluded ✓
    expect(end.getTime()).toBeGreaterThan(adjusted.getTime());
  });

  it("does not mutate the original date", () => {
    const end = new Date("2026-05-01T00:00:00.000Z");
    statsEndTime(end);
    expect(end.toISOString()).toBe("2026-05-01T00:00:00.000Z");
  });
});


describe("parseMaxResults", () => {
  const ok = (r: ReturnType<typeof parseMaxResults>) => {
    if (typeof r === "string") throw new Error(`expected parse result, got error: ${r}`);
    return r;
  };

  it('"all" → returnAll=true, rowCap=Infinity', () => {
    const r = ok(parseMaxResults("all"));
    expect(r.returnAll).toBe(true);
    expect(r.rowCap).toBe(Infinity);
  });

  it("explicit number → returnAll=false, rowCap=that number", () => {
    const r = ok(parseMaxResults(50));
    expect(r.returnAll).toBe(false);
    expect(r.rowCap).toBe(50);
  });

  it("undefined → returnAll=false, rowCap=config default (100)", () => {
    const r = ok(parseMaxResults(undefined));
    expect(r.returnAll).toBe(false);
    expect(r.rowCap).toBeGreaterThan(0);
    expect(r.rowCap).not.toBe(Infinity);
  });

  it("zero is rejected with a teaching error, not silently defaulted", () => {
    const r = parseMaxResults(0);
    expect(typeof r).toBe("string");
    expect(r).toContain("ERROR");
    expect(r).toContain("NOT executed");
  });

  it("negative is rejected with a teaching error, not silently defaulted", () => {
    const r = parseMaxResults(-5);
    expect(typeof r).toBe("string");
    expect(r).toContain("ERROR");
  });

  it("non-numeric string is rejected with a teaching error", () => {
    const r = parseMaxResults("20");
    expect(typeof r).toBe("string");
    expect(r).toContain("ERROR");
  });
});

// ---------------------------------------------------------------------------
// percentage
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// fenceTable
// ---------------------------------------------------------------------------

describe("fenceTable", () => {
  it("wraps an array of lines in a fenced code block", () => {
    const result = fenceTable(["header col1 | col2", "row1   1    | 2"]);
    expect(result).toBe("```\nheader col1 | col2\nrow1   1    | 2\n```");
  });

  it("wraps pre-joined text the same way", () => {
    const result = fenceTable("line1\nline2");
    expect(result).toBe("```\nline1\nline2\n```");
  });

  it("starts and ends with a fence marker on its own line", () => {
    const result = fenceTable(["a", "b", "c"]);
    const lines = result.split("\n");
    expect(lines[0]).toBe("```");
    expect(lines[lines.length - 1]).toBe("```");
  });

  it("preserves the original content between the fences", () => {
    const rows = ["entity_id".padEnd(10) + "state", "sensor.x  on"];
    const result = fenceTable(rows);
    expect(result).toContain(rows[0]);
    expect(result).toContain(rows[1]);
  });
});

describe("percentage", () => {
  it("basic percentage calculation", () => {
    expect(percentage(1, 4)).toBe(25);
    expect(percentage(3, 4)).toBe(75);
    expect(percentage(1, 3)).toBe(33); // rounds down
    expect(percentage(2, 3)).toBe(67); // rounds up
  });

  it("returns null when denominator is 0 — a ratio against nothing is not 0%", () => {
    expect(percentage(0, 0)).toBeNull();
    expect(percentage(100, 0)).toBeNull();
  });

  it("handles negative numerator (delta comparisons)", () => {
    expect(percentage(-1, 4)).toBe(-25);
    expect(percentage(-3, 4)).toBe(-75);
  });

  it("100% case", () => {
    expect(percentage(5, 5)).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// parseNonNegative / parseDayStartHour — reject, never silently clamp/default
// ---------------------------------------------------------------------------

import { parseNonNegative, parseDayStartHour } from "../tool-utils.js";

describe("parseNonNegative", () => {
  it("undefined → default", () => {
    expect(parseNonNegative(undefined, "min_duration_minutes", 1)).toBe(1);
  });

  it("valid number passes through", () => {
    expect(parseNonNegative(90, "max_gap_minutes", 0)).toBe(90);
    expect(parseNonNegative(0, "max_gap_minutes", 0)).toBe(0);
  });

  it("negative and wrong-typed values are rejected with a teaching error", () => {
    for (const bad of [-5, "60", NaN, true]) {
      const r = parseNonNegative(bad, "max_gap_minutes", 0);
      expect(typeof r).toBe("string");
      expect(r).toContain("ERROR");
      expect(r).toContain("max_gap_minutes");
    }
  });
});

describe("parseDayStartHour", () => {
  it("undefined → 0 regardless of group_by", () => {
    expect(parseDayStartHour(undefined, false)).toBe(0);
    expect(parseDayStartHour(undefined, true)).toBe(0);
  });

  it("valid hour with group_by='day' passes through", () => {
    expect(parseDayStartHour(6, true)).toBe(6);
    expect(parseDayStartHour(23, true)).toBe(23);
  });

  it("rejected without group_by='day' — never silently ignored", () => {
    const r = parseDayStartHour(6, false);
    expect(typeof r).toBe("string");
    expect(r).toContain('group_by="day"');
  });

  it("out-of-range values are rejected, never clamped", () => {
    for (const bad of [30, -1, 6.5]) {
      const r = parseDayStartHour(bad, true);
      expect(typeof r).toBe("string");
      expect(r).toContain("ERROR");
    }
  });
});
