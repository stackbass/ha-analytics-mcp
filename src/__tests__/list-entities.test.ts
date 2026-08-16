import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleListEntities } from "../tools/list-entities.js";

describe("handleListEntities live-domain discovery", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          entity_id: "person.alex",
          state: "home",
          attributes: {
            friendly_name: "Alex",
          },
        },
        {
          entity_id: "device_tracker.iphone_alex",
          state: "not_home",
          attributes: {
            friendly_name: "iPhone Alex",
            source_type: "gps",
          },
        },
        {
          entity_id: "sensor.iphone_alex_battery_level",
          state: "25",
          attributes: {
            friendly_name: "iPhone Alex Battery Level",
            device_class: "battery",
          },
        },
      ],
    } as Response);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("accepts one-item array form for domains", async () => {
    const result = await handleListEntities({
      domains: ["person"],
      search: "Alex",
    });

    expect(result).toContain("person.alex");
    expect(result).not.toContain("sensor.iphone_alex_battery_level");
    expect(result).toContain("location zones");
  });

  it("supports multi-domain live discovery with domains", async () => {
    const result = await handleListEntities({
      domains: ["person", "device_tracker"],
      search: "Alex",
    });

    expect(result).toContain("person.alex");
    expect(result).toContain("device_tracker.iphone_alex");
    expect(result).not.toContain("sensor.iphone_alex_battery_level");
    expect(result).toContain("person and device_tracker entities show location zones");
  });

  it("fences the aligned table but leaves the title and notes as prose", async () => {
    const result = await handleListEntities({
      domains: ["person"],
      search: "Alex",
    });

    // Table rows (entity_id/friendly_name/state columns) are wrapped in a
    // fenced code block so chat UIs render them monospace.
    const fenceStart = result.indexOf("```");
    const fenceEnd = result.lastIndexOf("```");
    expect(fenceStart).toBeGreaterThan(-1);
    expect(fenceEnd).toBeGreaterThan(fenceStart);
    expect(result.slice(fenceStart, fenceEnd + 3)).toContain("person.alex");

    // Title line and the trailing "Note:"/"Tip:" prose stay outside the fence.
    expect(result.slice(0, fenceStart)).toContain("entities found");
    expect(result.slice(fenceEnd + 3)).toContain("Note:");
    expect(result.slice(fenceEnd + 3)).toContain("Next:");
  });
});
describe("closed-world zero-result inventory (Benchmark2 fix)", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          entity_id: "binary_sensor.aquara_motion",
          state: "off",
          attributes: { friendly_name: "Aquara Motion", device_class: "motion" },
        },
        {
          entity_id: "binary_sensor.window_labo",
          state: "off",
          attributes: { friendly_name: "Window Labo", device_class: "opening" },
        },
      ],
    } as Response);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("search miss on a live domain returns the full domain inventory and a stop rule", async () => {
    const result = await handleListEntities({
      domains: ["binary_sensor"],
      search: "entrance stairs",
    });
    expect(result).toContain("No binary_sensor entities found");
    expect(result).toContain("ALL 2 binary_sensor entities");
    expect(result).toContain("binary_sensor.aquara_motion");
    expect(result).toContain("does NOT exist");
    expect(result).toContain("do not try more search words");
  });
});
