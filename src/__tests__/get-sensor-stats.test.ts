/**
 * Tests for ha_history_get_sensor_stats — multi-entity V1 implementation.
 *
 * All tests use mocked cache/HA-client — no real HA connection required.
 *
 * Covered cases:
 *   - one-item entity_ids with interval="none" (mean) → structured value row
 *   - one-item entity_ids with aggregation="min" → value + time_bucket row
 *   - multi-entity interval="day" → one row per date, one column per entity
 *   - multi-entity group_by="hour_of_day" → logical slot rows
 *   - duplicate entity_ids are deduplicated
 *   - mixed-unit multi-entity request fails clearly
 *   - invalid entity ID fails clearly
 *   - valid entity with no data → "-" column + footer note
 *   - multi-entity interval="none" returns a scalar comparison table
 *   - aggregations[] returns several whole-period stats in one call
 *   - max_results caps rows, not columns
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EnrichedEntity, StatisticRow } from "../ha-client.js";

// ---------------------------------------------------------------------------
// Module mocks (hoisted before imports of the modules under test)
// ---------------------------------------------------------------------------

vi.mock("../cache.js", () => ({
  getCachedEntityList: vi.fn(),
  getCachedStats: vi.fn(() => undefined), // always cache miss
  setCachedStats: vi.fn(),
  getCachedHAConfig: vi.fn(() => null), // null → getTz() falls back to "UTC"
}));

vi.mock("../ha-client.js", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    fetchStatistics: vi.fn(),
  };
});

import { getCachedEntityList } from "../cache.js";
import { fetchStatistics } from "../ha-client.js";
import { handleGetSensorStats } from "../tools/get-sensor-stats.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal EnrichedEntity for testing. */
function makeEntity(opts: {
  entity_id: string;
  friendly_name: string;
  unit?: string | null;
  has_mean?: boolean;
  has_sum?: boolean;
}): EnrichedEntity {
  return {
    statistic_id: opts.entity_id,
    friendly_name: opts.friendly_name,
    device_name: null,
    area_name: null,
    floor_id: null,
    unit: opts.unit ?? null,
    device_class: null,
    has_mean: opts.has_mean ?? true,
    has_sum: opts.has_sum ?? false,
  };
}

const ONE_HOUR = 3_600_000;
const ONE_DAY  = 86_400_000;

// Fixed reference: 2026-05-17T00:00:00Z
const T0 = new Date("2026-05-17T00:00:00Z").getTime();

/** Build a StatisticRow. mean/min/max default to the same value if not specified. */
function row(start: number, mean: number | null, min?: number | null, max?: number | null): StatisticRow {
  return {
    start,
    end: start + ONE_HOUR,
    mean: mean,
    min: min !== undefined ? min : mean,
    max: max !== undefined ? max : mean,
    sum: null,
    state: null,
    last_reset: null,
  };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const KITCHEN = makeEntity({ entity_id: "sensor.kitchen_temp", friendly_name: "Kitchen Temperature", unit: "°C" });
const STUDIO   = makeEntity({ entity_id: "sensor.studio_temp",   friendly_name: "Studio Temperature",   unit: "°C" });
const ATTIC    = makeEntity({ entity_id: "sensor.attic_temp",    friendly_name: "Attic Temperature",    unit: "°C" });
const HUMID   = makeEntity({ entity_id: "sensor.kitchen_hum",  friendly_name: "Kitchen Humidity",    unit: "%" });

function setEntityList(entities: EnrichedEntity[]): void {
  vi.mocked(getCachedEntityList).mockReturnValue(entities);
}

function setStatsResult(data: Record<string, StatisticRow[]>): void {
  vi.mocked(fetchStatistics).mockResolvedValue(data);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCachedEntityList).mockReturnValue([KITCHEN, STUDIO, ATTIC, HUMID]);
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("input validation", () => {
  it("missing entity_ids returns guidance message", async () => {
    const result = await handleGetSensorStats({ aggregations: ["mean"] });
    expect(result).toContain("entity_ids");
  });

  it("empty entity_ids array returns guidance message", async () => {
    const result = await handleGetSensorStats({ entity_ids: [], aggregations: ["mean"] });
    expect(result).toContain("entity_ids");
  });

  it("entity_ids with only empty strings returns guidance message", async () => {
    const result = await handleGetSensorStats({ entity_ids: ["", "  "], aggregations: ["mean"] });
    expect(result).toContain("entity_ids");
  });

  it("invalid entity ID fails clearly", async () => {
    const result = await handleGetSensorStats({
      entity_ids: ["sensor.nonexistent"],
      aggregations: ["mean"],
    });
    expect(result).toContain("not found");
    expect(result).toContain("sensor.nonexistent");
  });

  it("entity without mean capability fails clearly", async () => {
    const sumOnly = makeEntity({ entity_id: "sensor.energy", friendly_name: "Energy", unit: "kWh", has_mean: false, has_sum: true });
    setEntityList([sumOnly]);
    const result = await handleGetSensorStats({
      entity_ids: ["sensor.energy"],
      aggregations: ["mean"],
    });
    expect(result).toContain("ha_history_get_consumption");
  });

  it("mixed-unit multi-entity request fails clearly", async () => {
    const result = await handleGetSensorStats({
      entity_ids: ["sensor.kitchen_temp", "sensor.kitchen_hum"],
      aggregations: ["mean"],
      interval: "day",
    });
    expect(result).toContain("Mixed units");
    expect(result).toContain("°C");
    expect(result).toContain("%");
  });

  it("multi-entity interval='none' returns a scalar comparison table", async () => {
    setStatsResult({
      "sensor.kitchen_temp": [row(T0, 21.1), row(T0 + ONE_HOUR, 22.3)],
      "sensor.studio_temp": [row(T0, 20.0), row(T0 + ONE_HOUR, 24.0)],
    });
    const result = await handleGetSensorStats({
      entity_ids: ["sensor.kitchen_temp", "sensor.studio_temp"],
      aggregations: ["mean"],
    });
    expect(result).toContain("Aggregations: mean");
    expect(result).toContain("sensor");
    expect(result).toContain("Kitchen Temperature");
    expect(result).toContain("Studio Temperature");
    expect(result).toContain("21.7");
    expect(result).toContain("22");

    // The table body is fenced (monospace-safe in markdown chat UIs); the
    // "Sensors:"/"Period:" prose header stays outside the fence.
    expect(result).toMatch(/```\n[\s\S]*```/);
    const fenceStart = result.indexOf("```");
    expect(result.slice(0, fenceStart)).toContain("Sensors:");
    expect(result.slice(0, fenceStart)).not.toContain("```");
  });

  it("aggregations returns several whole-period stats in one call", async () => {
    setStatsResult({
      "sensor.kitchen_temp": [
        row(T0, 20.0, 18.0, 24.0),
        row(T0 + ONE_HOUR, 24.0, 21.0, 27.0),
      ],
      "sensor.studio_temp": [
        row(T0, 19.0, 17.0, 22.0),
        row(T0 + ONE_HOUR, 23.0, 20.0, 28.0),
      ],
    });
    const result = await handleGetSensorStats({
      entity_ids: ["sensor.kitchen_temp", "sensor.studio_temp"],
      aggregations: ["mean", "min", "max"],
      start_time: "2026-05-17",
      end_time: "2026-05-18",
    });

    expect(result).toContain("Aggregations: mean | min | max");
    expect(result).toContain("Kitchen Temperature");
    expect(result).toContain("Studio Temperature");
    expect(result).toContain("22");
    expect(result).toContain("18");
    expect(result).toContain("27");
    expect(vi.mocked(fetchStatistics)).toHaveBeenCalledOnce();
    expect(vi.mocked(fetchStatistics).mock.calls[0]?.[0]).toEqual([
      "sensor.kitchen_temp",
      "sensor.studio_temp",
    ]);
  });

  it("aggregations with median is rejected for interval output", async () => {
    const result = await handleGetSensorStats({
      entity_ids: ["sensor.kitchen_temp"],
      aggregations: ["mean", "median"],
      interval: "day",
    });
    expect(result).toContain("median");
    expect(result).toContain("whole-period");
    expect(result).toContain("ERROR");
  });

  it("duplicate entity_ids are deduplicated (only one fetch)", async () => {
    setStatsResult({ "sensor.kitchen_temp": [row(T0, 21.0)] });
    const result = await handleGetSensorStats({
      entity_ids: ["sensor.kitchen_temp", "sensor.kitchen_temp", "sensor.kitchen_temp"],
      aggregations: ["mean"],
      start_time: "2026-05-17",
      end_time: "2026-05-18",
    });
    // fetchStatistics called once with deduplicated list
    expect(vi.mocked(fetchStatistics)).toHaveBeenCalledOnce();
    const callArgs = vi.mocked(fetchStatistics).mock.calls[0]!;
    expect(callArgs[0]).toEqual(["sensor.kitchen_temp"]); // deduplicated to one entity
    // Output treats it as a single-entity request
    expect(result).toContain("Kitchen Temperature");
    expect(result).not.toContain("not supported"); // not a multi-entity rejection
  });
});

// ---------------------------------------------------------------------------
// Single-entity scalar (interval="none")
// ---------------------------------------------------------------------------

describe("single-entity interval='none'", () => {
  it("mean aggregation returns structured value row", async () => {
    setStatsResult({
      "sensor.kitchen_temp": [
        row(T0 + 0 * ONE_HOUR, 20.0),
        row(T0 + 1 * ONE_HOUR, 22.0),
        row(T0 + 2 * ONE_HOUR, 24.0),
      ],
    });
    const result = await handleGetSensorStats({
      entity_ids: ["sensor.kitchen_temp"],
      aggregations: ["mean"],
      start_time: "2026-05-17",
      end_time: "2026-05-18",
    });
    expect(result).toContain("Sensors: Kitchen Temperature");
    expect(result).toContain("Aggregation: mean");
    expect(result).toContain("Unit: °C");
    // Structured row with "value" column header
    expect(result).toContain("value");
    // Mean of [20, 22, 24] = 22.0
    expect(result).toContain("22");
    // No unit in data cell
    expect(result).not.toMatch(/22\.0\s*°C/);
  });

  it("median aggregation returns structured value row", async () => {
    setStatsResult({
      "sensor.kitchen_temp": [
        row(T0, 10.0),
        row(T0 + ONE_HOUR, 20.0),
        row(T0 + 2 * ONE_HOUR, 30.0),
      ],
    });
    const result = await handleGetSensorStats({
      entity_ids: ["sensor.kitchen_temp"],
      aggregations: ["median"],
      start_time: "2026-05-17",
      end_time: "2026-05-18",
    });
    expect(result).toContain("value");
    // Median of [10, 20, 30] = 20
    expect(result).toContain("20");
  });

  it("min aggregation includes time_bucket column", async () => {
    setStatsResult({
      "sensor.kitchen_temp": [
        row(T0 + 0 * ONE_HOUR, 20.0, 18.0, 22.0),  // min=18, row.start=T0
        row(T0 + 1 * ONE_HOUR, 15.0, 12.0, 18.0),  // min=12, this is the extreme
        row(T0 + 2 * ONE_HOUR, 21.0, 19.0, 23.0),  // min=19
      ],
    });
    const result = await handleGetSensorStats({
      entity_ids: ["sensor.kitchen_temp"],
      aggregations: ["min"],
      start_time: "2026-05-17",
      end_time: "2026-05-18",
    });
    expect(result).toContain("Aggregation: min");
    expect(result).toContain("value");
    expect(result).toContain("time_bucket");
    // The minimum row.min value is 12 (at T0 + 1 hour)
    expect(result).toContain("12");
  });

  it("max aggregation includes time_bucket column", async () => {
    setStatsResult({
      "sensor.kitchen_temp": [
        row(T0, 20.0, 18.0, 24.0),
        row(T0 + ONE_HOUR, 25.0, 22.0, 31.5), // row.max=31.5, this is the extreme
        row(T0 + 2 * ONE_HOUR, 22.0, 20.0, 25.0),
      ],
    });
    const result = await handleGetSensorStats({
      entity_ids: ["sensor.kitchen_temp"],
      aggregations: ["max"],
      start_time: "2026-05-17",
      end_time: "2026-05-18",
    });
    expect(result).toContain("time_bucket");
    expect(result).toContain("31.5");
  });

  it("no data returns informative message", async () => {
    setStatsResult({ "sensor.kitchen_temp": [] });
    const result = await handleGetSensorStats({
      entity_ids: ["sensor.kitchen_temp"],
      aggregations: ["mean"],
      start_time: "2026-05-17",
      end_time: "2026-05-18",
    });
    expect(result).toContain("No statistics found");
    expect(result).toContain("sensor.kitchen_temp");
    expect(result).toContain("Widen the period");
  });
});

// ---------------------------------------------------------------------------
// Interval output (single and multi-entity)
// ---------------------------------------------------------------------------

describe("interval output", () => {
  it("multi-entity interval='day' produces one row per date and one column per entity", async () => {
    // Two daily rows, three entities
    const day1 = T0;                // 2026-05-17
    const day2 = T0 + ONE_DAY;     // 2026-05-18

    setStatsResult({
      "sensor.kitchen_temp": [row(day1, 21.4), row(day2, 20.8)],
      "sensor.studio_temp":   [row(day1, 22.1), row(day2, 21.6)],
      "sensor.attic_temp":    [row(day1, 18.9), row(day2, 18.5)],
    });

    const result = await handleGetSensorStats({
      entity_ids: ["sensor.kitchen_temp", "sensor.studio_temp", "sensor.attic_temp"],
      aggregations: ["mean"],
      interval: "day",
      start_time: "2026-05-17",
      end_time: "2026-05-19",
    });

    // Header
    expect(result).toContain("Sensors: Kitchen Temperature (sensor.kitchen_temp) | Studio Temperature (sensor.studio_temp) | Attic Temperature (sensor.attic_temp)");
    expect(result).toContain("Aggregation: mean per day");
    expect(result).toContain("Unit: °C");
    expect(result).toContain("Rows: 2");

    // Table column headers — common suffix "temperature" stripped → "kitchen", "studio", "attic"
    expect(result).toContain("kitchen");
    expect(result).toContain("studio");
    expect(result).toContain("attic");

    // Data rows
    expect(result).toContain("21.4");
    expect(result).toContain("22.1");
    expect(result).toContain("18.9");
    expect(result).toContain("20.8");

    // Time column header
    expect(result).toContain("time");
  });

  it("single-entity interval='day' produces structured interval table", async () => {
    setStatsResult({
      "sensor.kitchen_temp": [
        row(T0, 21.0),
        row(T0 + ONE_DAY, 22.0),
        row(T0 + 2 * ONE_DAY, 20.5),
      ],
    });
    const result = await handleGetSensorStats({
      entity_ids: ["sensor.kitchen_temp"],
      aggregations: ["mean"],
      interval: "day",
      start_time: "2026-05-17",
      end_time: "2026-05-20",
    });
    expect(result).toContain("Sensors: Kitchen Temperature");
    expect(result).toContain("Aggregation: mean per day");
    expect(result).toContain("Rows: 3");
    expect(result).toContain("21");
    expect(result).toContain("22");
    expect(result).toContain("20.5");
  });

  it("valid entity with no data stays as '-' column and is reported in footer note", async () => {
    setStatsResult({
      "sensor.kitchen_temp": [row(T0, 21.4), row(T0 + ONE_DAY, 20.8)],
      "sensor.studio_temp":   [row(T0, 22.1), row(T0 + ONE_DAY, 21.6)],
      "sensor.attic_temp":    [],  // no data
    });

    const result = await handleGetSensorStats({
      entity_ids: ["sensor.kitchen_temp", "sensor.studio_temp", "sensor.attic_temp"],
      aggregations: ["mean"],
      interval: "day",
      start_time: "2026-05-17",
      end_time: "2026-05-19",
    });

    // Attic column still present but with "-"
    expect(result).toContain("attic");
    expect(result).toContain("-");
    // Footer note mentions the no-data entity
    expect(result).toContain("Note:");
    expect(result).toContain("Attic Temperature");
  });

  it("max_results caps rows, not columns", async () => {
    // 5 daily rows, max_results=2, 3 entities
    setStatsResult({
      "sensor.kitchen_temp": [
        row(T0 + 0 * ONE_DAY, 20.0),
        row(T0 + 1 * ONE_DAY, 21.0),
        row(T0 + 2 * ONE_DAY, 22.0),
        row(T0 + 3 * ONE_DAY, 23.0),
        row(T0 + 4 * ONE_DAY, 24.0),
      ],
      "sensor.studio_temp": [
        row(T0 + 0 * ONE_DAY, 21.0),
        row(T0 + 1 * ONE_DAY, 22.0),
        row(T0 + 2 * ONE_DAY, 23.0),
        row(T0 + 3 * ONE_DAY, 24.0),
        row(T0 + 4 * ONE_DAY, 25.0),
      ],
      "sensor.attic_temp": [
        row(T0 + 0 * ONE_DAY, 18.0),
        row(T0 + 1 * ONE_DAY, 19.0),
        row(T0 + 2 * ONE_DAY, 20.0),
        row(T0 + 3 * ONE_DAY, 21.0),
        row(T0 + 4 * ONE_DAY, 22.0),
      ],
    });

    const result = await handleGetSensorStats({
      entity_ids: ["sensor.kitchen_temp", "sensor.studio_temp", "sensor.attic_temp"],
      aggregations: ["mean"],
      interval: "day",
      max_results: 2,
      start_time: "2026-05-17",
      end_time: "2026-05-22",
    });

    // All three columns still present
    expect(result).toContain("kitchen");
    expect(result).toContain("studio");
    expect(result).toContain("attic");

    // Rows: reports the pre-cap total; the cap notice carries the shown count
    expect(result).toContain("Rows: 5");
    expect(result).toContain("Showing 2 of 5");

    // Cap notice present
    expect(result).toContain("max_results");
  });

  it("fetchStatistics is called with all entity IDs in one call", async () => {
    setStatsResult({
      "sensor.kitchen_temp": [row(T0, 21.0)],
      "sensor.studio_temp":   [row(T0, 22.0)],
    });

    await handleGetSensorStats({
      entity_ids: ["sensor.kitchen_temp", "sensor.studio_temp"],
      aggregations: ["mean"],
      interval: "day",
      start_time: "2026-05-17",
      end_time: "2026-05-18",
    });

    expect(vi.mocked(fetchStatistics)).toHaveBeenCalledOnce();
    const callArgs = vi.mocked(fetchStatistics).mock.calls[0]!;
    expect(callArgs[0]).toContain("sensor.kitchen_temp");
    expect(callArgs[0]).toContain("sensor.studio_temp");
    expect(callArgs[0]).toHaveLength(2);
  });

  it("interval filtering uses raw values, not rounded display values", async () => {
    setStatsResult({
      "sensor.kitchen_temp": [
        row(T0, 20.04),
        row(T0 + ONE_DAY, 20.06),
      ],
    });

    const result = await handleGetSensorStats({
      entity_ids: ["sensor.kitchen_temp"],
      aggregations: ["mean"],
      interval: "day",
      filter_operator: ">=",
      filter_value: 20.05,
      start_time: "2026-05-17",
      end_time: "2026-05-19",
    });

    expect(result).toContain("20.1");
    expect(result).toContain("2026-05-18");
    expect(result).not.toContain("2026-05-17 | 20");
    expect(result).toContain("1 of 2 buckets matched");
  });
});

// ---------------------------------------------------------------------------
// Group-by output (single and multi-entity)
// ---------------------------------------------------------------------------

describe("group_by output", () => {
  it("multi-entity group_by='hour_of_day' produces logical slot rows, one column per entity", async () => {
    // Hours 0, 1, 2 — two entities
    // T0 = 2026-05-17T00:00:00Z → UTC hour 0
    setStatsResult({
      "sensor.kitchen_temp": [
        row(T0 + 0 * ONE_HOUR, 19.0),
        row(T0 + 1 * ONE_HOUR, 18.5),
        row(T0 + 2 * ONE_HOUR, 18.0),
      ],
      "sensor.studio_temp": [
        row(T0 + 0 * ONE_HOUR, 20.0),
        row(T0 + 1 * ONE_HOUR, 19.5),
        row(T0 + 2 * ONE_HOUR, 19.0),
      ],
    });

    const result = await handleGetSensorStats({
      entity_ids: ["sensor.kitchen_temp", "sensor.studio_temp"],
      aggregations: ["mean"],
      group_by: "hour_of_day",
      start_time: "2026-05-17",
      end_time: "2026-05-18",
    });

    expect(result).toContain("Sensors: Kitchen Temperature (sensor.kitchen_temp) | Studio Temperature (sensor.studio_temp)");
    expect(result).toContain("Aggregation: mean by hour_of_day");
    // Column headers
    expect(result).toContain("bucket");
    expect(result).toContain("kitchen");
    expect(result).toContain("studio");
    // Slot labels (00:00, 01:00, 02:00)
    expect(result).toContain("00:00");
    expect(result).toContain("01:00");
    expect(result).toContain("02:00");
  });

  it("multi-entity group_by='day_of_week' produces Mon-Sun labels", async () => {
    // T0 = 2026-05-17 is a Sunday (JS getDay() = 0, ISO day = Sun)
    // T0 + 1 day = 2026-05-18 Monday
    setStatsResult({
      "sensor.kitchen_temp": [
        row(T0, 20.0),             // Sun
        row(T0 + ONE_DAY, 21.0),  // Mon
      ],
      "sensor.studio_temp": [
        row(T0, 21.0),             // Sun
        row(T0 + ONE_DAY, 22.0),  // Mon
      ],
    });

    const result = await handleGetSensorStats({
      entity_ids: ["sensor.kitchen_temp", "sensor.studio_temp"],
      aggregations: ["mean"],
      group_by: "day_of_week",
      start_time: "2026-05-17",
      end_time: "2026-05-19",
    });

    expect(result).toContain("Aggregation: mean by day_of_week");
    expect(result).toContain("bucket");
    // Mon and Sun should appear
    expect(result).toMatch(/Mon|Sun/);
  });

  it("count mode with group_by produces N/M cells", async () => {
    // 3 hourly readings at hour 0, 2 exceed threshold
    setStatsResult({
      "sensor.kitchen_temp": [
        row(T0 + 0 * ONE_HOUR, 22.0), // >21 ✓
        row(T0 + 24 * ONE_HOUR, 21.5), // >21 ✓ (next day, same hour slot 0)
        row(T0 + 48 * ONE_HOUR, 20.0), // ≤21 ✗
      ],
    });

    const result = await handleGetSensorStats({
      entity_ids: ["sensor.kitchen_temp"],
      aggregations: ["count"],
      group_by: "hour_of_day",
      filter_operator: ">",
      filter_value: 21,
      start_time: "2026-05-17",
      end_time: "2026-05-20",
    });

    expect(result).toContain("Aggregation: count by hour_of_day");
    expect(result).toContain("Counting:");
    // Hour 0 slot: 2 matched out of 3 readings
    expect(result).toContain("2/3");
  });

  it("group_by filtering uses raw aggregated values, not rounded display values", async () => {
    setStatsResult({
      "sensor.kitchen_temp": [
        row(T0 + 0 * ONE_HOUR, 20.04),
        row(T0 + 24 * ONE_HOUR, 20.04),
        row(T0 + 1 * ONE_HOUR, 20.06),
        row(T0 + 25 * ONE_HOUR, 20.06),
      ],
    });

    const result = await handleGetSensorStats({
      entity_ids: ["sensor.kitchen_temp"],
      aggregations: ["mean"],
      group_by: "hour_of_day",
      filter_operator: ">=",
      filter_value: 20.05,
      start_time: "2026-05-17",
      end_time: "2026-05-19",
    });

    expect(result).toContain("01:00");
    expect(result).not.toContain("00:00");
    expect(result).toContain("20.1");
  });
});

// ---------------------------------------------------------------------------
// Column label derivation
// ---------------------------------------------------------------------------

describe("column label derivation", () => {
  it("strips common suffix 'Temperature' to give short labels", async () => {
    setStatsResult({
      "sensor.kitchen_temp": [row(T0, 21.0)],
      "sensor.studio_temp":   [row(T0, 22.0)],
      "sensor.attic_temp":    [row(T0, 18.0)],
    });

    const result = await handleGetSensorStats({
      entity_ids: ["sensor.kitchen_temp", "sensor.studio_temp", "sensor.attic_temp"],
      aggregations: ["mean"],
      interval: "day",
      start_time: "2026-05-17",
      end_time: "2026-05-18",
    });

    // "Kitchen Temperature", "Studio Temperature", "Attic Temperature"
    // → common suffix "temperature" removed → "kitchen", "studio", "attic"
    expect(result).toContain("kitchen");
    expect(result).toContain("studio");
    expect(result).toContain("attic");
    // Should NOT show "temperature" as a column header
    expect(result).not.toMatch(/\| temperature/i);
  });
});

// ---------------------------------------------------------------------------
// Interval multi-aggregation output (new in this change)
// ---------------------------------------------------------------------------

describe("interval multi-aggregation output", () => {
  it("single entity, interval='day', aggregations=['min','max'] — no error, both columns present", async () => {
    setStatsResult({
      "sensor.kitchen_temp": [
        row(T0 + 0 * ONE_DAY, 21.0, 18.0, 24.0),
        row(T0 + 1 * ONE_DAY, 22.0, 19.5, 25.5),
        row(T0 + 2 * ONE_DAY, 20.0, 17.0, 23.0),
      ],
    });

    const result = await handleGetSensorStats({
      entity_ids: ["sensor.kitchen_temp"],
      aggregations: ["min", "max"],
      interval: "day",
      start_time: "2026-05-17",
      end_time: "2026-05-20",
    });

    // No error
    expect(result).not.toContain("only supported with interval");
    // Header
    expect(result).toContain("Sensors: Kitchen Temperature");
    expect(result).toContain("Aggregations: min | max per day");
    expect(result).toContain("Unit: °C");
    expect(result).toContain("Rows: 3");
    // Both columns present (single entity: label is full lowercase name)
    expect(result).toContain("kitchen temperature min");
    expect(result).toContain("kitchen temperature max");
    // Data values
    expect(result).toContain("18");
    expect(result).toContain("24");
    expect(result).toContain("19.5");
    expect(result).toContain("25.5");
  });

  it("multiple entities, interval='day', aggregations=['mean','min','max'] — columns per entity×aggregation", async () => {
    setStatsResult({
      "sensor.kitchen_temp": [
        row(T0 + 0 * ONE_DAY, 21.0, 18.0, 24.0),
        row(T0 + 1 * ONE_DAY, 22.0, 19.0, 25.0),
      ],
      "sensor.studio_temp": [
        row(T0 + 0 * ONE_DAY, 23.0, 20.0, 26.0),
        row(T0 + 1 * ONE_DAY, 24.0, 21.0, 27.0),
      ],
    });

    const result = await handleGetSensorStats({
      entity_ids: ["sensor.kitchen_temp", "sensor.studio_temp"],
      aggregations: ["mean", "min", "max"],
      interval: "day",
      start_time: "2026-05-17",
      end_time: "2026-05-19",
    });

    expect(result).not.toContain("only supported with interval");
    expect(result).toContain("Sensors: Kitchen Temperature (sensor.kitchen_temp) | Studio Temperature (sensor.studio_temp)");
    expect(result).toContain("Aggregations: mean | min | max per day");
    expect(result).toContain("Rows: 2");
    // Columns for each entity × aggregation (common suffix "temperature" stripped)
    expect(result).toContain("kitchen mean");
    expect(result).toContain("kitchen min");
    expect(result).toContain("kitchen max");
    expect(result).toContain("studio mean");
    expect(result).toContain("studio min");
    expect(result).toContain("studio max");
    // Data from both entities
    expect(result).toContain("18");
    expect(result).toContain("20");
  });

  it("aggregation order in output follows request order, not sorted order", async () => {
    setStatsResult({
      "sensor.kitchen_temp": [
        row(T0, 21.0, 18.0, 24.0),
      ],
    });

    const result = await handleGetSensorStats({
      entity_ids: ["sensor.kitchen_temp"],
      aggregations: ["max", "min"],   // max before min
      interval: "day",
      start_time: "2026-05-17",
      end_time: "2026-05-18",
    });

    // "max" column should appear before "min" column in the header row
    // (single entity: label is full lowercase name)
    const maxPos = result.indexOf("kitchen temperature max");
    const minPos = result.indexOf("kitchen temperature min");
    expect(maxPos).toBeGreaterThan(-1);
    expect(minPos).toBeGreaterThan(-1);
    expect(maxPos).toBeLessThan(minPos);
  });

  it("aggregations with 'count' and interval='day' is rejected with clear error", async () => {
    const result = await handleGetSensorStats({
      entity_ids: ["sensor.kitchen_temp"],
      aggregations: ["mean", "count"],
      interval: "day",
    });
    expect(result).toContain("ERROR");
    expect(result).toContain("count");
    expect(result).toContain("alone");
  });

  it("aggregations with 'median' and interval='day' is rejected with clear error", async () => {
    const result = await handleGetSensorStats({
      entity_ids: ["sensor.kitchen_temp"],
      aggregations: ["mean", "median"],
      interval: "day",
    });
    expect(result).toContain("median");
    expect(result).toContain("interval=");
  });

  it("filter_operator with multiple aggregations and interval is rejected as ambiguous", async () => {
    const result = await handleGetSensorStats({
      entity_ids: ["sensor.kitchen_temp"],
      aggregations: ["min", "max"],
      interval: "day",
      filter_operator: ">",
      filter_value: 20,
    });
    expect(result).toContain("ambiguous");
    expect(result).toContain("filter_operator");
    expect(result).toContain("aggregation");
  });

  it("regression: interval='none' with aggregations=['mean','min','max'] still works", async () => {
    setStatsResult({
      "sensor.kitchen_temp": [
        row(T0, 20.0, 18.0, 24.0),
        row(T0 + ONE_HOUR, 24.0, 21.0, 27.0),
      ],
      "sensor.studio_temp": [
        row(T0, 19.0, 17.0, 22.0),
        row(T0 + ONE_HOUR, 23.0, 20.0, 28.0),
      ],
    });

    const result = await handleGetSensorStats({
      entity_ids: ["sensor.kitchen_temp", "sensor.studio_temp"],
      aggregations: ["mean", "min", "max"],
      start_time: "2026-05-17",
      end_time: "2026-05-18",
    });

    expect(result).toContain("Aggregations: mean | min | max");
    expect(result).toContain("Kitchen Temperature");
    expect(result).toContain("Studio Temperature");
    // Whole-period mean of [20, 24] = 22
    expect(result).toContain("22");
    // Overall min across all rows
    expect(result).toContain("18");
    // Overall max across all rows
    expect(result).toContain("27");
  });
});

// ---------------------------------------------------------------------------
// Group-by multi-aggregation output (new in this change)
// ---------------------------------------------------------------------------

describe("group_by multi-aggregation output", () => {
  it("single entity, group_by='hour_of_day', aggregations=['min','max'] — no error, both columns present", async () => {
    // T0 = 2026-05-17T00:00:00Z → UTC hour 0; T0+1h → hour 1
    setStatsResult({
      "sensor.kitchen_temp": [
        row(T0 + 0 * ONE_HOUR, 20.0, 18.0, 24.0),   // hour 0
        row(T0 + 24 * ONE_HOUR, 20.5, 18.5, 24.5),   // hour 0 again (next day)
        row(T0 + 1 * ONE_HOUR, 19.0, 17.0, 22.0),    // hour 1
      ],
    });

    const result = await handleGetSensorStats({
      entity_ids: ["sensor.kitchen_temp"],
      aggregations: ["min", "max"],
      group_by: "hour_of_day",
      start_time: "2026-05-17",
      end_time: "2026-05-19",
    });

    expect(result).not.toContain("not supported with group_by");
    expect(result).toContain("Sensors: Kitchen Temperature");
    expect(result).toContain("Aggregations: min | max by hour_of_day");
    expect(result).toContain("Unit: °C");
    // Bucket labels
    expect(result).toContain("00:00");
    expect(result).toContain("01:00");
    // Columns (single entity: full lowercase name as label)
    expect(result).toContain("kitchen temperature min");
    expect(result).toContain("kitchen temperature max");
    // Data values
    expect(result).toContain("17");
    expect(result).toContain("24.5");
  });

  it("multiple entities, group_by='day_of_week', aggregations=['mean','min','max'] — columns per entity×aggregation", async () => {
    // T0 = 2026-05-17 is Sunday (JS getDay=0)
    // T0 + 1 day = Monday
    setStatsResult({
      "sensor.kitchen_temp": [
        row(T0, 20.0, 18.0, 24.0),           // Sun
        row(T0 + ONE_DAY, 21.0, 19.0, 25.0), // Mon
      ],
      "sensor.studio_temp": [
        row(T0, 22.0, 20.0, 26.0),           // Sun
        row(T0 + ONE_DAY, 23.0, 21.0, 27.0), // Mon
      ],
    });

    const result = await handleGetSensorStats({
      entity_ids: ["sensor.kitchen_temp", "sensor.studio_temp"],
      aggregations: ["mean", "min", "max"],
      group_by: "day_of_week",
      start_time: "2026-05-17",
      end_time: "2026-05-19",
    });

    expect(result).not.toContain("not supported with group_by");
    expect(result).toContain("Sensors: Kitchen Temperature (sensor.kitchen_temp) | Studio Temperature (sensor.studio_temp)");
    expect(result).toContain("Aggregations: mean | min | max by day_of_week");
    // Bucket labels (Mon and Sun)
    expect(result).toMatch(/Mon|Sun/);
    // Columns per entity×aggregation (common suffix stripped)
    expect(result).toContain("kitchen mean");
    expect(result).toContain("kitchen min");
    expect(result).toContain("kitchen max");
    expect(result).toContain("studio mean");
    expect(result).toContain("studio min");
    expect(result).toContain("studio max");
    // Data from both entities
    expect(result).toContain("18");
    expect(result).toContain("20");
  });

  it("aggregation order in output follows request order, not sorted order", async () => {
    setStatsResult({
      "sensor.kitchen_temp": [
        row(T0, 20.0, 18.0, 24.0),
      ],
    });

    const result = await handleGetSensorStats({
      entity_ids: ["sensor.kitchen_temp"],
      aggregations: ["max", "min"],   // max before min
      group_by: "hour_of_day",
      start_time: "2026-05-17",
      end_time: "2026-05-18",
    });

    // "max" column header should appear before "min" column header
    const maxPos = result.indexOf("kitchen temperature max");
    const minPos = result.indexOf("kitchen temperature min");
    expect(maxPos).toBeGreaterThan(-1);
    expect(minPos).toBeGreaterThan(-1);
    expect(maxPos).toBeLessThan(minPos);
  });

  it("aggregations with 'count' and group_by is rejected with constructive error", async () => {
    const result = await handleGetSensorStats({
      entity_ids: ["sensor.kitchen_temp"],
      aggregations: ["mean", "count"],
      group_by: "hour_of_day",
    });
    expect(result).toContain("ERROR");
    expect(result).toContain("count");
    expect(result).toContain("alone");
  });

  it("aggregations with 'median' and group_by is rejected with constructive error", async () => {
    const result = await handleGetSensorStats({
      entity_ids: ["sensor.kitchen_temp"],
      aggregations: ["mean", "median"],
      group_by: "day_of_week",
    });
    expect(result).toContain("median");
    expect(result).toContain("group_by");
    expect(result).toContain("whole-period");
  });

  it("filter_operator with multiple aggregations and group_by is rejected as ambiguous", async () => {
    const result = await handleGetSensorStats({
      entity_ids: ["sensor.kitchen_temp"],
      aggregations: ["min", "max"],
      group_by: "hour_of_day",
      filter_operator: ">",
      filter_value: 20,
    });
    expect(result).toContain("ambiguous");
    expect(result).toContain("filter_operator");
    expect(result).toContain("aggregation");
  });

  it("regression: group_by='hour_of_day' + aggregation='count' behavior preserved", async () => {
    setStatsResult({
      "sensor.kitchen_temp": [
        row(T0 + 0 * ONE_HOUR, 22.0),
        row(T0 + 24 * ONE_HOUR, 21.5),
        row(T0 + 48 * ONE_HOUR, 20.0),
      ],
    });

    const result = await handleGetSensorStats({
      entity_ids: ["sensor.kitchen_temp"],
      aggregations: ["count"],
      group_by: "hour_of_day",
      filter_operator: ">",
      filter_value: 21,
      start_time: "2026-05-17",
      end_time: "2026-05-20",
    });

    expect(result).toContain("Aggregation: count by hour_of_day");
    expect(result).toContain("2/3");
  });

  it("regression: group_by='day_of_week' + single aggregation='mean' behavior preserved", async () => {
    setStatsResult({
      "sensor.kitchen_temp": [
        row(T0, 20.0),            // Sun
        row(T0 + ONE_DAY, 21.0), // Mon
      ],
      "sensor.studio_temp": [
        row(T0, 22.0),            // Sun
        row(T0 + ONE_DAY, 23.0), // Mon
      ],
    });

    const result = await handleGetSensorStats({
      entity_ids: ["sensor.kitchen_temp", "sensor.studio_temp"],
      aggregations: ["mean"],
      group_by: "day_of_week",
      start_time: "2026-05-17",
      end_time: "2026-05-19",
    });

    expect(result).toContain("Aggregation: mean by day_of_week");
    expect(result).toContain("bucket");
    expect(result).toMatch(/Mon|Sun/);
    expect(result).toContain("kitchen");
    expect(result).toContain("studio");
  });
});

// ---------------------------------------------------------------------------
// Migration teaching error for the removed singular parameter
// ---------------------------------------------------------------------------

describe("removed 'aggregation' parameter", () => {
  it("returns a migration error naming the aggregations replacement", async () => {
    const result = await handleGetSensorStats({
      entity_ids: ["sensor.kitchen_temp"],
      aggregation: "max",
    });
    expect(result).toContain("ERROR");
    expect(result).toContain('"aggregation" was removed');
    expect(result).toContain('aggregations=["max"]');
  });
});
