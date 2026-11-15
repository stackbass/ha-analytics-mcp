/**
 * Regression tests: the timezone used for day boundaries and labels must not
 * fall back to UTC when the HA config cache entry expires (1 h TTL).
 *
 * Seen live: one hour after startup, daily breakdowns for a Europe/Rome home
 * put each value under the previous day's date (HA's daily rows start at
 * local midnight = 23:00 UTC the day before).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { HAConfig } from "../ha-client.js";

vi.mock("../ha-client.js", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return { ...actual, fetchHAConfig: vi.fn() };
});

import { fetchHAConfig } from "../ha-client.js";
import { clearCache, setCachedHAConfig, getCachedHAConfig, ensureHAConfig } from "../cache.js";
import { getTz } from "../tool-utils.js";

const ROME: HAConfig = {
  timezone: "Europe/Rome",
  locationName: "Casa",
  latitude: 45.4,
  longitude: 9.3,
  version: "2026.11.0",
};

beforeEach(() => {
  clearCache();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("HA_TIMEZONE", undefined as unknown as string);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("getTz", () => {
  it("prefers HA_TIMEZONE, like ha_history_get_current_time", () => {
    vi.stubEnv("HA_TIMEZONE", "Europe/Rome");
    expect(getTz()).toBe("Europe/Rome");
  });

  it("HA_TIMEZONE keeps working after the HA config cache expires", () => {
    vi.stubEnv("HA_TIMEZONE", "Europe/Rome");
    vi.useFakeTimers({ toFake: ["Date"] });
    setCachedHAConfig({ ...ROME, timezone: "Europe/Rome" });
    vi.setSystemTime(Date.now() + 61 * 60_000);
    expect(getCachedHAConfig()).toBeUndefined();
    expect(getTz()).toBe("Europe/Rome");
  });

  it("uses the cached HA timezone when HA_TIMEZONE is not set", () => {
    setCachedHAConfig(ROME);
    expect(getTz()).toBe("Europe/Rome");
  });

  it("falls back to UTC only when nothing is known", () => {
    expect(getTz()).toBe("UTC");
  });
});

describe("ensureHAConfig", () => {
  it("reloads the HA config after the cache entry expired", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    setCachedHAConfig(ROME);
    vi.setSystemTime(Date.now() + 61 * 60_000);
    expect(getTz()).toBe("UTC"); // the bug: silent fallback after 1 h

    vi.mocked(fetchHAConfig).mockResolvedValue(ROME);
    await ensureHAConfig();
    expect(fetchHAConfig).toHaveBeenCalledOnce();
    expect(getTz()).toBe("Europe/Rome");
  });

  it("does not call HA while the cache entry is valid", async () => {
    setCachedHAConfig(ROME);
    await ensureHAConfig();
    expect(fetchHAConfig).not.toHaveBeenCalled();
  });

  it("is non-fatal when HA cannot be reached", async () => {
    vi.mocked(fetchHAConfig).mockResolvedValue({
      isError: true,
      content: [],
      text: "ERROR: unreachable",
    } as never);
    await expect(ensureHAConfig()).resolves.toBeUndefined();
    expect(getTz()).toBe("UTC");
  });
});
