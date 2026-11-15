/**
 * Tests for ha_history_get_consumption whole-period totals (interval="none").
 *
 * HA's `sum` in a daily statistics row is the meter value at the END of that
 * day. A total must therefore subtract the row BEFORE the period (baseline),
 * not the period's first row, or the first day is silently lost.
 *
 * Fixture mirrors a real case: a heat pump meter used 10.92 kWh on 14 Nov
 * (verified against raw readings at midnight), and "yesterday" asked on
 * 15 Nov at 16:46 returned today's partial 10.36 kWh instead.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { EnrichedEntity, StatisticRow } from "../ha-client.js";

vi.mock("../cache.js", () => ({
  getCachedEntityList: vi.fn(),
  setCachedEntityList: vi.fn(),
  getCachedStats: vi.fn(() => undefined), // always cache miss
  setCachedStats: vi.fn(),
  getCachedHAConfig: vi.fn(() => null), // null → getTz() falls back to "UTC"
}));

vi.mock("../ha-client.js", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return { ...actual, fetchStatistics: vi.fn() };
});

import { getCachedEntityList } from "../cache.js";
import { fetchStatistics } from "../ha-client.js";
import { handleGetConsumption } from "../tools/get-consumption.js";

const ENTITY = "sensor.heat_pump_energy";
const DAY = 86_400_000;

const meter = {
  statistic_id: ENTITY,
  friendly_name: "Heat pump energy",
  device_name: null,
  area_name: null,
  floor_id: null,
  unit: "kWh",
  device_class: "energy",
  has_mean: false,
  has_sum: true,
} as unknown as EnrichedEntity;

function row(day: string, sum: number): StatisticRow {
  const start = new Date(`${day}T00:00:00Z`).getTime();
  return { start, end: start + DAY, mean: null, min: null, max: null, sum, state: null, last_reset: null };
}

// Meter value at the end of each day (15 Nov is today, partial).
const ALL_ROWS = [
  row("2026-11-12", 90),
  row("2026-11-13", 100),
  row("2026-11-14", 110.92),
  row("2026-11-15", 121.28),
];

/** Emulates HA: returns the rows whose start lies within [startTime, endTime]. */
function serveRows(rows: StatisticRow[]) {
  vi.mocked(fetchStatistics).mockImplementation(async (_ids, startTime, endTime) => ({
    [ENTITY]: rows.filter((r) => r.start >= startTime.getTime() && r.start <= endTime.getTime()),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-15T16:46:00Z"));
  vi.mocked(getCachedEntityList).mockReturnValue([meter]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("whole-period totals", () => {
  it("yesterday = 14 Nov only (not today's partial consumption)", async () => {
    serveRows(ALL_ROWS);
    const out = await handleGetConsumption({ entity_id: ENTITY, start_time: "yesterday" });
    expect(out).toContain("Total: 10.92");
  });

  it("a single ISO day includes that day (baseline is the row before it)", async () => {
    serveRows(ALL_ROWS);
    const out = await handleGetConsumption({
      entity_id: ENTITY, start_time: "2026-11-14", end_time: "2026-11-14",
    });
    expect(out).toContain("Total: 10.92");
  });

  it("equals the sum of the day-by-day breakdown", async () => {
    serveRows(ALL_ROWS);
    const args = { entity_id: ENTITY, start_time: "2026-11-13", end_time: "2026-11-14" };
    const total = await handleGetConsumption(args);
    const daily = await handleGetConsumption({ ...args, interval: "day" });
    expect(total).toContain("Total: 20.92");
    expect(daily).toContain("Total: 20.92");
  });

  it("without data before the period, says the first day is not included", async () => {
    serveRows(ALL_ROWS.slice(2)); // meter starts on 14 Nov
    const out = await handleGetConsumption({
      entity_id: ENTITY, start_time: "2026-11-14", end_time: "2026-11-15",
    });
    expect(out).toContain("Total: 10.36");
    expect(out).toContain("first day not included");
  });

  it("previous_period comparison uses a baseline too", async () => {
    serveRows(ALL_ROWS);
    const out = await handleGetConsumption({
      entity_id: ENTITY, start_time: "2026-11-14", end_time: "2026-11-14",
      comparison: "previous_period",
    });
    expect(out).toContain("Total: 10.92");
    expect(out).toContain("Comparison (previous period): 10 kWh  Δ +0.92 kWh");
  });
});
