/**
 * Tests for period-resolver.ts
 *
 * "now" is fixed at 2026-05-03T12:00:00Z = 14:00 Europe/Berlin (UTC+2 summer)
 * so all named expressions resolve deterministically.
 */

import { describe, it, expect } from "vitest";
import { resolvePeriod, ResolvedPeriod } from "../period-resolver.js";

// Fixed reference point
const NOW = new Date("2026-05-03T12:00:00Z");
const TZ = "Europe/Berlin"; // UTC+2 in summer

function ok(result: ResolvedPeriod | string): ResolvedPeriod {
  if (typeof result === "string") throw new Error(`Expected ResolvedPeriod, got error: ${result}`);
  return result;
}

// ---------------------------------------------------------------------------
// Relative expressions
// ---------------------------------------------------------------------------

describe("relative expressions", () => {
  it("7d → start is 7 days before now", () => {
    const r = ok(resolvePeriod("7d", undefined, NOW, TZ));
    const diffDays = (NOW.getTime() - r.start.getTime()) / 86400_000;
    expect(diffDays).toBeCloseTo(7, 5);
    expect(r.end.getTime()).toBe(NOW.getTime());
    expect(r.label).toBe("last 7d (2026-04-26 → 2026-05-03)");
  });

  it("30d → start is 30 days before now", () => {
    const r = ok(resolvePeriod("30d", undefined, NOW, TZ));
    const diffDays = (NOW.getTime() - r.start.getTime()) / 86400_000;
    expect(diffDays).toBeCloseTo(30, 5);
  });

  it("24h → start is 24 hours before now", () => {
    const r = ok(resolvePeriod("24h", undefined, NOW, TZ));
    const diffHours = (NOW.getTime() - r.start.getTime()) / 3_600_000;
    expect(diffHours).toBeCloseTo(24, 5);
  });

  it("default (no start) → 30 days", () => {
    const r = ok(resolvePeriod(undefined, undefined, NOW, TZ));
    const diffDays = (NOW.getTime() - r.start.getTime()) / 86400_000;
    expect(diffDays).toBeCloseTo(30, 5);
  });
});

// ---------------------------------------------------------------------------
// Date-only ISO strings — critical timezone test
// ---------------------------------------------------------------------------

describe("date-only ISO strings (timezone-aware midnight)", () => {
  it("2026-04-01 in Europe/Berlin → 2026-03-31T22:00:00Z (NOT UTC midnight)", () => {
    // UTC+2 in summer: midnight Berlin = 22:00 UTC previous day
    const r = ok(resolvePeriod("2026-04-01", "2026-04-02", NOW, TZ));
    expect(r.start.toISOString()).toBe("2026-03-31T22:00:00.000Z");
    // date-only end is extended to start of next day (2026-04-03 00:00 Berlin = 2026-04-02T22:00Z)
    expect(r.end.toISOString()).toBe("2026-04-02T22:00:00.000Z");
  });

  it("date-only end extends to include the full day", () => {
    const r = ok(resolvePeriod("2026-04-01", "2026-04-30", NOW, TZ));
    // end = 2026-04-30 is extended to next day midnight Berlin = 2026-05-01T00:00 Berlin = 2026-04-30T22:00Z
    expect(r.end.toISOString()).toBe("2026-04-30T22:00:00.000Z");
  });

  it("UTC midnight bug: date-only must NOT equal parseISO result", () => {
    // parseISO("2026-04-01") returns 2026-04-01T00:00:00Z — which is WRONG for UTC+2
    const wrongUtcMidnight = new Date("2026-04-01T00:00:00.000Z");
    const r = ok(resolvePeriod("2026-04-01", "2026-04-02", NOW, TZ));
    expect(r.start.getTime()).not.toBe(wrongUtcMidnight.getTime());
    expect(r.start.getTime()).toBe(new Date("2026-03-31T22:00:00Z").getTime());
  });
});

// ---------------------------------------------------------------------------
// Named expressions
// ---------------------------------------------------------------------------

describe("named expressions", () => {
  it("yesterday → May 2 2026 midnight Berlin = May 1 22:00 UTC", () => {
    const r = ok(resolvePeriod("yesterday", undefined, NOW, TZ));
    expect(r.start.toISOString()).toBe("2026-05-01T22:00:00.000Z");
  });

  it("today → May 3 2026 midnight Berlin = May 2 22:00 UTC", () => {
    const r = ok(resolvePeriod("today", undefined, NOW, TZ));
    expect(r.start.toISOString()).toBe("2026-05-02T22:00:00.000Z");
  });

  it("last month (in May) → full April: April 1 → May 1 Berlin", () => {
    const r = ok(resolvePeriod("last month", undefined, NOW, TZ));
    expect(r.start.toISOString()).toBe("2026-03-31T22:00:00.000Z");
    expect(r.end.toISOString()).toBe("2026-04-30T22:00:00.000Z");
    expect(r.label).toBe("last month (2026-04-01 → 2026-04-30)");
  });

  it("this year → Jan 1 2026 midnight Berlin = Dec 31 2025 23:00 UTC", () => {
    const r = ok(resolvePeriod("this year", undefined, NOW, TZ));
    // UTC+1 in winter (Jan 1): midnight Berlin = 2025-12-31T23:00Z
    expect(r.start.toISOString()).toBe("2025-12-31T23:00:00.000Z");
  });

  it("last year → Jan 1 2025 midnight Berlin = Dec 31 2024 23:00 UTC", () => {
    const r = ok(resolvePeriod("last year", undefined, NOW, TZ));
    expect(r.start.toISOString()).toBe("2024-12-31T23:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// Closed named periods end where the period ends (TOOLS.md), not at now
// ---------------------------------------------------------------------------

describe("closed named periods", () => {
  it("yesterday → May 2 only, not May 2 until now", () => {
    const r = ok(resolvePeriod("yesterday", undefined, NOW, TZ));
    expect(r.start.toISOString()).toBe("2026-05-01T22:00:00.000Z");
    expect(r.end.toISOString()).toBe("2026-05-02T22:00:00.000Z");
    expect(r.label).toBe("yesterday (2026-05-02 → 2026-05-02)");
  });

  it("last week (Sun May 3) → Mon Apr 20 → Mon Apr 27", () => {
    const r = ok(resolvePeriod("last week", undefined, NOW, TZ));
    expect(r.start.toISOString()).toBe("2026-04-19T22:00:00.000Z");
    expect(r.end.toISOString()).toBe("2026-04-26T22:00:00.000Z");
  });

  it("last year → full 2025", () => {
    const r = ok(resolvePeriod("last year", undefined, NOW, TZ));
    expect(r.start.toISOString()).toBe("2024-12-31T23:00:00.000Z");
    expect(r.end.toISOString()).toBe("2025-12-31T23:00:00.000Z");
  });

  it("last winter (in May) → Dec 2025 → Mar 2026", () => {
    const r = ok(resolvePeriod("last winter", undefined, NOW, TZ));
    expect(r.start.toISOString()).toBe("2025-11-30T23:00:00.000Z");
    expect(r.end.toISOString()).toBe("2026-02-28T23:00:00.000Z");
  });

  it("last winter (in January) → the previous, completed winter", () => {
    const jan = new Date("2027-01-15T12:00:00Z");
    const r = ok(resolvePeriod("last winter", undefined, jan, TZ));
    expect(r.start.toISOString()).toBe("2025-11-30T23:00:00.000Z"); // Dec 1 2025
    expect(r.end.toISOString()).toBe("2026-02-28T23:00:00.000Z");   // Mar 1 2026
  });

  it("last summer (in July) → the previous, completed summer", () => {
    const jul = new Date("2026-07-15T12:00:00Z");
    const r = ok(resolvePeriod("last summer", undefined, jul, TZ));
    expect(r.start.toISOString()).toBe("2025-05-31T22:00:00.000Z"); // Jun 1 2025
    expect(r.end.toISOString()).toBe("2025-08-31T22:00:00.000Z");   // Sep 1 2025
  });

  it("open periods (today, this month) still end at now", () => {
    expect(ok(resolvePeriod("today", undefined, NOW, TZ)).end.getTime()).toBe(NOW.getTime());
    expect(ok(resolvePeriod("this month", undefined, NOW, TZ)).end.getTime()).toBe(NOW.getTime());
  });

  it("an explicit end_time still wins", () => {
    const r = ok(resolvePeriod("last month", "now", NOW, TZ));
    expect(r.end.getTime()).toBe(NOW.getTime());
  });
});

// ---------------------------------------------------------------------------
// Month name auto-end
// ---------------------------------------------------------------------------

describe("month name auto-end", () => {
  it("april (no end) → full April 2026", () => {
    const r = ok(resolvePeriod("april", undefined, NOW, TZ));
    // April 2026 start: April 1 midnight Berlin = March 31 22:00 UTC
    expect(r.start.toISOString()).toBe("2026-03-31T22:00:00.000Z");
    // April 2026 end: May 1 midnight Berlin = April 30 22:00 UTC
    expect(r.end.toISOString()).toBe("2026-04-30T22:00:00.000Z");
    expect(r.label).toBe("April 2026 (2026-04-01 → 2026-04-30)");
  });

  it("january (no end) → full January 2026 (past, in same year since we're in May)", () => {
    const r = ok(resolvePeriod("january", undefined, NOW, TZ));
    expect(r.start.toISOString()).toBe("2025-12-31T23:00:00.000Z"); // Jan 1 Berlin = Dec 31 UTC (UTC+1 in winter)
    expect(r.label).toBe("January 2026 (2026-01-01 → 2026-01-31)");
  });

  it("december (no end) → December 2025 (past)", () => {
    // December is past because we're in May 2026
    const r = ok(resolvePeriod("december", undefined, NOW, TZ));
    expect(r.start.toISOString()).toBe("2025-11-30T23:00:00.000Z"); // Dec 1 Berlin = Nov 30 23:00 UTC
    expect(r.label).toBe("December 2025 (2025-12-01 → 2025-12-31)");
  });
});

// ---------------------------------------------------------------------------
// Quarter auto-end
// ---------------------------------------------------------------------------

describe("quarter auto-end", () => {
  it("q1 (no end) → full Q1 2026 (Jan–Mar)", () => {
    const r = ok(resolvePeriod("q1", undefined, NOW, TZ));
    expect(r.start.toISOString()).toBe("2025-12-31T23:00:00.000Z"); // Jan 1 Berlin (UTC+1)
    expect(r.end.toISOString()).toBe("2026-03-31T22:00:00.000Z");   // Apr 1 Berlin (UTC+2 summer)
    expect(r.label).toBe("Q1 2026 (2026-01-01 → 2026-03-31)");
  });

  it("q4 (no end) → full Q4 2025 (Oct–Dec, past)", () => {
    const r = ok(resolvePeriod("q4", undefined, NOW, TZ));
    // Q4 starts October → Oct 1 2025, Oct is past in May 2026
    expect(r.start.toISOString()).toBe("2025-09-30T22:00:00.000Z"); // Oct 1 Berlin (UTC+2)
    expect(r.label).toBe("Q4 2025 (2025-10-01 → 2025-12-31)");
  });
});

// ---------------------------------------------------------------------------
// Seasonal expressions
// ---------------------------------------------------------------------------

describe("seasonal expressions", () => {
  it("last winter (in May) → December 2025 start", () => {
    // In May: month >= 2, so year = 2026-1 = 2025, Dec 1
    const r = ok(resolvePeriod("last winter", undefined, NOW, TZ));
    expect(r.start.toISOString()).toBe("2025-11-30T23:00:00.000Z"); // Dec 1 Berlin (UTC+1)
  });

  it("last summer (in May) → June 2025 start", () => {
    // In May: month < 6, so year = 2026-1 = 2025, June 1
    const r = ok(resolvePeriod("last summer", undefined, NOW, TZ));
    expect(r.start.toISOString()).toBe("2025-05-31T22:00:00.000Z"); // Jun 1 Berlin (UTC+2)
  });
});

// ---------------------------------------------------------------------------
// Full ISO datetime
// ---------------------------------------------------------------------------

describe("full ISO datetime", () => {
  it("explicit UTC datetime is respected as-is", () => {
    const r = ok(resolvePeriod("2026-01-15T10:00:00Z", "2026-01-20T10:00:00Z", NOW, TZ));
    expect(r.start.toISOString()).toBe("2026-01-15T10:00:00.000Z");
    expect(r.end.toISOString()).toBe("2026-01-20T10:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe("error cases", () => {
  it("start after end → returns error string", () => {
    const result = resolvePeriod("2026-04-10", "2026-04-01", NOW, TZ);
    expect(typeof result).toBe("string");
    expect(result as string).toContain("start_time must be before end_time");
  });

  it("invalid expression → returns error string", () => {
    const result = resolvePeriod("not-a-date", undefined, NOW, TZ);
    expect(typeof result).toBe("string");
  });
});
