/**
 * Regression tests: the validator must reload the entity list when the cache
 * entry is missing or expired (1 h TTL), instead of failing with
 * "Entity list not yet loaded" until something else refills the cache.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EnrichedEntity } from "../ha-client.js";

vi.mock("../cache.js", () => ({
  getCachedEntityList: vi.fn(),
  setCachedEntityList: vi.fn(),
}));

vi.mock("../ha-client.js", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return { ...actual, fetchEnrichedEntities: vi.fn() };
});

import { getCachedEntityList, setCachedEntityList } from "../cache.js";
import { fetchEnrichedEntities } from "../ha-client.js";
import { validateEntities, validateEntity } from "../entity-validator.js";

const power = {
  statistic_id: "sensor.heat_pump_power",
  friendly_name: "Heat pump",
  unit: "W",
  has_mean: true,
  has_sum: false,
} as unknown as EnrichedEntity;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("entity list reload", () => {
  it("uses the cached list without calling HA", async () => {
    vi.mocked(getCachedEntityList).mockReturnValue([power]);
    const result = await validateEntity("sensor.heat_pump_power", "mean");
    expect(typeof result).not.toBe("string");
    expect(fetchEnrichedEntities).not.toHaveBeenCalled();
  });

  it("reloads and re-caches the list when the cache has expired", async () => {
    vi.mocked(getCachedEntityList).mockReturnValue(undefined);
    vi.mocked(fetchEnrichedEntities).mockResolvedValue([power]);
    const result = await validateEntities(["sensor.heat_pump_power"], "mean");
    expect(typeof result).not.toBe("string");
    expect(fetchEnrichedEntities).toHaveBeenCalledOnce();
    expect(setCachedEntityList).toHaveBeenCalledWith([power]);
  });

  it("still reports 'not yet loaded' when HA cannot be reached", async () => {
    vi.mocked(getCachedEntityList).mockReturnValue(undefined);
    vi.mocked(fetchEnrichedEntities).mockResolvedValue({
      isError: true,
      content: [],
      text: "ERROR: unreachable",
    } as never);
    const result = await validateEntity("sensor.heat_pump_power", "mean");
    expect(result).toMatch(/Entity list not yet loaded/);
    expect(setCachedEntityList).not.toHaveBeenCalled();
  });
});
