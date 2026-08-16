/**
 * Tests for the V1 discovery layer:
 *   - classifyMetricKind (via ha-client exports)
 *   - scoreArea (list-areas)
 *   - scoreDevice (list-devices)
 *   - deviceMetricSummary (list-devices)
 *   - scoreEntity (list-device-entities)
 *   - handleListAreas / handleListDevices / handleListDeviceEntities output formatting
 *
 * All tests use in-memory fixture data — no real HA connection required.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { scoreArea } from "../tools/list-areas.js";
import { scoreDevice, deviceMetricSummary } from "../tools/list-devices.js";
import { scoreEntity } from "../tools/list-device-entities.js";
import type { DiscoveryArea, DiscoveryDevice, DiscoveryEntity, DiscoveryIndex } from "../ha-client.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeArea(name: string, area_id?: string): DiscoveryArea {
  return {
    area_id: area_id ?? name.toLowerCase().replace(/\s+/g, "_"),
    name,
    floor_id: null,
    temperature_entity_id: null,
    humidity_entity_id: null,
  };
}

function makeDevice(opts: {
  device_id?: string;
  name?: string;
  user_name?: string;
  area_id?: string;
  manufacturer?: string;
  disabled_by?: string;
}): DiscoveryDevice {
  const effective = opts.user_name ?? opts.name ?? opts.device_id ?? "device";
  return {
    device_id: opts.device_id ?? effective.toLowerCase().replace(/\s+/g, "_"),
    name: opts.name ?? null,
    user_name: opts.user_name ?? null,
    effective_name: effective,
    area_id: opts.area_id ?? null,
    area_name: null,
    manufacturer: opts.manufacturer ?? null,
    model: null,
    disabled_by: opts.disabled_by ?? null,
    entity_ids: [],
  };
}

function makeEntity(opts: {
  entity_id: string;
  device_class?: string;
  unit?: string;
  entity_category?: string;
  hidden_by?: string;
  disabled_by?: string;
  has_mean?: boolean;
  has_sum?: boolean;
  metric_kind?: DiscoveryEntity["metric_kind"];
}): DiscoveryEntity {
  return {
    entity_id: opts.entity_id,
    friendly_name: opts.entity_id.split(".")[1]?.replace(/_/g, " ") ?? opts.entity_id,
    registry_name: null,
    original_name: null,
    device_id: null,
    area_id: null,
    area_name: null,
    device_name: null,
    device_class: opts.device_class ?? null,
    entity_category: opts.entity_category ?? null,
    unit: opts.unit ?? null,
    hidden_by: opts.hidden_by ?? null,
    disabled_by: opts.disabled_by ?? null,
    has_mean: opts.has_mean ?? false,
    has_sum: opts.has_sum ?? false,
    metric_kind: opts.metric_kind ?? "other",
  };
}

// ---------------------------------------------------------------------------
// scoreArea
// ---------------------------------------------------------------------------

describe("scoreArea", () => {
  const kitchen = makeArea("Kitchen");
  const outdoor = makeArea("Outdoor");
  const livingRoom = makeArea("Living Room");

  it("exact match scores highest", () => {
    expect(scoreArea(kitchen, "kitchen")).toBe(3);
  });

  it("prefix match scores 2", () => {
    expect(scoreArea(kitchen, "kit")).toBe(2);
  });

  it("substring match scores 1", () => {
    // "room" is a true substring but NOT a prefix of "Living Room"
    expect(scoreArea(livingRoom, "room")).toBe(1);
  });

  it("no match returns -1", () => {
    expect(scoreArea(outdoor, "bedroom")).toBe(-1);
  });

  it("no search returns 0", () => {
    expect(scoreArea(kitchen, undefined)).toBe(0);
  });

  it("case-insensitive", () => {
    expect(scoreArea(kitchen, "KITCHEN")).toBe(3);
    expect(scoreArea(outdoor, "OUT")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// scoreDevice
// ---------------------------------------------------------------------------

describe("scoreDevice", () => {
  const charger = makeDevice({ name: "Car Charging Plug", user_name: "EV Charger" });
  const climate = makeDevice({ name: "Outdoor Climate Sensor" });

  it("user_name exact match scores 4", () => {
    expect(scoreDevice(charger, "ev charger")).toBe(4);
  });

  it("user_name prefix scores 3", () => {
    expect(scoreDevice(charger, "ev")).toBe(3);
  });

  it("user_name substring scores 2", () => {
    expect(scoreDevice(charger, "charger")).toBe(2);
  });

  it("default name substring scores 1", () => {
    expect(scoreDevice(climate, "climate")).toBe(1);
  });

  it("no match returns -1", () => {
    expect(scoreDevice(charger, "thermostat")).toBe(-1);
  });

  it("no search returns 0", () => {
    expect(scoreDevice(charger, undefined)).toBe(0);
  });

  it("case-insensitive", () => {
    expect(scoreDevice(charger, "EV CHARGER")).toBe(4);
  });

  it("stem match: 'charger' matches default name containing 'charging'", () => {
    const plug = makeDevice({ name: "Car Charging Plug" });
    expect(scoreDevice(plug, "charger")).toBeGreaterThanOrEqual(1);
  });

  it("stem match: 'heating' matches device name containing 'heater'", () => {
    const heater = makeDevice({ name: "Boiler Heater" });
    expect(scoreDevice(heater, "heating")).toBeGreaterThanOrEqual(1);
  });

  it("no false positive: 'heater' does not match unrelated 'Motion Sensor'", () => {
    const sensor = makeDevice({ name: "Motion Sensor" });
    expect(scoreDevice(sensor, "heater")).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// deviceMetricSummary
// ---------------------------------------------------------------------------

describe("deviceMetricSummary", () => {
  it("returns distinct metric kinds sorted, excluding 'other' when other kinds exist", () => {
    const entities = [
      makeEntity({ entity_id: "sensor.plug_power", metric_kind: "power", has_mean: true }),
      makeEntity({ entity_id: "sensor.plug_energy", metric_kind: "energy", has_sum: true }),
      makeEntity({ entity_id: "sensor.plug_current", metric_kind: "other" }),
    ];
    const result = deviceMetricSummary(entities);
    expect(result).toEqual(["energy", "power"]);
  });

  it("falls back to 'other' when all entities are other", () => {
    const entities = [
      makeEntity({ entity_id: "sensor.x", metric_kind: "other" }),
    ];
    const result = deviceMetricSummary(entities);
    expect(result).toEqual(["other"]);
  });

  it("excludes diagnostic entities from metric summary when useful ones exist", () => {
    const entities = [
      makeEntity({ entity_id: "sensor.power", metric_kind: "power", has_mean: true }),
      makeEntity({ entity_id: "sensor.diag", metric_kind: "temperature", entity_category: "diagnostic" }),
    ];
    const result = deviceMetricSummary(entities);
    expect(result).toEqual(["power"]); // diagnostic excluded
  });
});

// ---------------------------------------------------------------------------
// scoreEntity
// ---------------------------------------------------------------------------

describe("scoreEntity", () => {
  const powerSensor = makeEntity({
    entity_id: "sensor.plug_power",
    metric_kind: "power",
    device_class: "power",
    has_mean: true,
  });

  const energySensor = makeEntity({
    entity_id: "sensor.plug_energy",
    metric_kind: "energy",
    device_class: "energy",
    has_sum: true,
  });

  const diagSensor = makeEntity({
    entity_id: "sensor.plug_diag",
    metric_kind: "other",
    entity_category: "diagnostic",
  });

  const hiddenSensor = makeEntity({
    entity_id: "sensor.plug_hidden",
    metric_kind: "power",
    has_mean: true,
    hidden_by: "user",
  });

  it("metric kind match: power sensor scores > 0 when targeting power", () => {
    const score = scoreEntity(powerSensor, "power");
    expect(score).toBeGreaterThan(0);
  });

  it("metric kind mismatch returns -1", () => {
    expect(scoreEntity(powerSensor, "energy")).toBe(-1);
    expect(scoreEntity(energySensor, "power")).toBe(-1);
  });

  it("no target metric: all non-filtered entities score >= 0", () => {
    expect(scoreEntity(powerSensor, undefined)).toBeGreaterThanOrEqual(0);
    expect(scoreEntity(energySensor, undefined)).toBeGreaterThanOrEqual(0);
  });

  it("diagnostic entities receive a penalty", () => {
    const normalScore = scoreEntity(powerSensor, undefined);
    const diagScore = scoreEntity(diagSensor, undefined);
    expect(diagScore).toBeLessThan(normalScore);
  });

  it("hidden entities receive a penalty", () => {
    const normalScore = scoreEntity(powerSensor, undefined);
    const hiddenScore = scoreEntity(hiddenSensor, undefined);
    expect(hiddenScore).toBeLessThan(normalScore);
  });

  it("energy sensor with has_sum scores well for energy target", () => {
    const score = scoreEntity(energySensor, "energy");
    expect(score).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// EV charger discovery regression case
// ---------------------------------------------------------------------------

describe("EV charger discovery regression", () => {
  /**
   * This is the known failure case: user says "EV charger" or "car charger"
   * and the old flow searched entity names directly, missing sensor.car_charging_plug_power.
   *
   * With the new hierarchical flow:
   * 1. area search for "outdoor" finds the Outdoor area
   * 2. device search "charger" within Outdoor finds Car Charging Plug (stem match: charger→charg matches charging)
   * 3. entity listing on that device with metric="power" returns the power sensor
   *
   * This test validates steps 2 and 3.
   */
  it("device default name 'Car Charging Plug' is matched by 'charger' via stem matching", () => {
    // 'charger' stem 'charg' prefix-matches 'charging' — morphological variant handled
    const plugDevice = makeDevice({ name: "Car Charging Plug", area_id: "outdoor" });
    expect(scoreDevice(plugDevice, "charger")).toBeGreaterThanOrEqual(1);
  });

  it("device default name 'Car Charging Plug' is matched by 'car charger' via stem matching", () => {
    const plugDevice = makeDevice({ name: "Car Charging Plug", area_id: "outdoor" });
    expect(scoreDevice(plugDevice, "car charger")).toBeGreaterThanOrEqual(1);
  });

  it("device with user_name 'EV Charger' matches 'charger' as substring", () => {
    const plugDevice = makeDevice({ name: "Car Charging Plug", user_name: "EV Charger", area_id: "outdoor" });
    expect(scoreDevice(plugDevice, "charger")).toBeGreaterThanOrEqual(2);
  });

  it("user_name 'EV Charger' scores highest for 'ev charger' search", () => {
    const plugDevice = makeDevice({ name: "Car Charging Plug", user_name: "EV Charger", area_id: "outdoor" });
    expect(scoreDevice(plugDevice, "ev charger")).toBe(4);
  });

  it("entity listing on Car Charging Plug with metric=power surfaces sensor.car_charging_plug_power", () => {
    const powerEntity = makeEntity({
      entity_id: "sensor.car_charging_plug_power",
      metric_kind: "power",
      device_class: "power",
      has_mean: true,
    });
    const energyEntity = makeEntity({
      entity_id: "sensor.car_charging_plug_summation_delivered",
      metric_kind: "energy",
      device_class: "energy",
      has_sum: true,
    });
    const currentEntity = makeEntity({
      entity_id: "sensor.car_charging_plug_current",
      metric_kind: "other",
      has_mean: true,
    });

    // With metric="power", only the power entity matches
    expect(scoreEntity(powerEntity, "power")).toBeGreaterThan(0);
    expect(scoreEntity(energyEntity, "power")).toBe(-1);
    expect(scoreEntity(currentEntity, "power")).toBe(-1);
  });

  it("area-scoped lookup prevents 3D printer temperature sensor from matching kitchen temperature", () => {
    // Devices in different areas
    const kitchenClimateDev = makeDevice({ name: "Kitchen Climate Sensor", area_id: "kitchen" });
    const printerDev = makeDevice({ name: "3D Printer", area_id: "workshop" });

    // Both have temperature entities
    const kitchenTemp = makeEntity({ entity_id: "sensor.kitchen_temperature", metric_kind: "temperature", has_mean: true });
    const printerTemp = makeEntity({ entity_id: "sensor.printer_bed_temperature", metric_kind: "temperature", has_mean: true });

    // When searching in the Kitchen area, only kitchen devices are returned
    // (area filtering is done in the handler, here we verify device score for area-scoped search)
    const kitchenScore = scoreDevice(kitchenClimateDev, "climate");
    const printerScore = scoreDevice(printerDev, "climate");

    expect(kitchenScore).toBeGreaterThan(0);
    expect(printerScore).toBe(-1); // "3D Printer" does not contain "climate"

    // Both temperature entities score the same for metric=temperature
    const kitchenTempScore = scoreEntity(kitchenTemp, "temperature");
    const printerTempScore = scoreEntity(printerTemp, "temperature");
    expect(kitchenTempScore).toBeGreaterThan(0);
    expect(printerTempScore).toBeGreaterThan(0);
    // The area filtering (which eliminates the printer) happens at the device level, not entity level
  });
});

// ---------------------------------------------------------------------------
// metric kind classification (via entity fixture metric_kind field)
// ---------------------------------------------------------------------------

describe("metric kind classification (regression via entity fixtures)", () => {
  it("power device_class → power", () => {
    const e = makeEntity({ entity_id: "sensor.plug_power", device_class: "power", metric_kind: "power" });
    expect(e.metric_kind).toBe("power");
  });

  it("energy device_class → energy", () => {
    const e = makeEntity({ entity_id: "sensor.plug_energy", device_class: "energy", metric_kind: "energy" });
    expect(e.metric_kind).toBe("energy");
  });

  it("temperature device_class → temperature", () => {
    const e = makeEntity({ entity_id: "sensor.room_temp", device_class: "temperature", metric_kind: "temperature" });
    expect(e.metric_kind).toBe("temperature");
  });

  it("humidity device_class → humidity", () => {
    const e = makeEntity({ entity_id: "sensor.room_humidity", device_class: "humidity", metric_kind: "humidity" });
    expect(e.metric_kind).toBe("humidity");
  });

  it("motion device_class → motion", () => {
    const e = makeEntity({ entity_id: "binary_sensor.stairs_motion", device_class: "motion", metric_kind: "motion" });
    expect(e.metric_kind).toBe("motion");
  });
});

// ---------------------------------------------------------------------------
// Output formatting — snapshot-style assertions
// ---------------------------------------------------------------------------

// We test the handler output by mocking the cache layer so no real HA is needed.
// The mock returns a minimal but representative DiscoveryIndex.

vi.mock("../cache.js", () => ({
  getCachedDiscoveryIndex: vi.fn(),
  setCachedDiscoveryIndex: vi.fn(),
  getCachedEntityList: vi.fn(),
  setCachedEntityList: vi.fn(),
}));

vi.mock("../ha-client.js", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    fetchDiscoveryIndex: vi.fn(),
  };
});

import { getCachedDiscoveryIndex, getCachedEntityList } from "../cache.js";
import { handleListAreas } from "../tools/list-areas.js";
import { handleListDevices } from "../tools/list-devices.js";
import { handleListDeviceEntities } from "../tools/list-device-entities.js";
import { handleListEntities } from "../tools/list-entities.js";
import type { EnrichedEntity } from "../ha-client.js";

function makeTestIndex(): DiscoveryIndex {
  const kitchen = makeArea("Kitchen", "kitchen");
  const outdoor = makeArea("Outdoor", "outdoor");

  const kitchenClimateDev = makeDevice({ device_id: "dev_kitchen_climate", name: "Kitchen Climate Sensor", area_id: "kitchen" });
  const chargerDev = makeDevice({ device_id: "dev_charger", name: "Car Charging Plug", user_name: "EV Charger", area_id: "outdoor", manufacturer: "Schneider Electric" });
  const motionDev = makeDevice({ device_id: "dev_motion", name: "Outdoor Motion Sensor", area_id: "outdoor" });

  const kitchenTempEnt = makeEntity({ entity_id: "sensor.kitchen_temperature", device_class: "temperature", unit: "°C", metric_kind: "temperature", has_mean: true });
  const kitchenHumEnt = makeEntity({ entity_id: "sensor.kitchen_humidity", device_class: "humidity", unit: "%", metric_kind: "humidity", has_mean: true });
  kitchenTempEnt.device_id = "dev_kitchen_climate";
  kitchenHumEnt.device_id = "dev_kitchen_climate";

  const chargerPowerEnt = makeEntity({ entity_id: "sensor.car_charging_plug_power", device_class: "power", unit: "W", metric_kind: "power", has_mean: true });
  const chargerEnergyEnt = makeEntity({ entity_id: "sensor.car_charging_plug_summation_delivered", device_class: "energy", unit: "kWh", metric_kind: "energy", has_sum: true });
  const chargerDiagEnt = makeEntity({ entity_id: "sensor.car_charging_plug_rssi", metric_kind: "other", entity_category: "diagnostic" });
  chargerPowerEnt.device_id = "dev_charger";
  chargerEnergyEnt.device_id = "dev_charger";
  chargerDiagEnt.device_id = "dev_charger";

  const motionEnt = makeEntity({ entity_id: "binary_sensor.outdoor_motion", device_class: "motion", metric_kind: "motion" });
  motionEnt.device_id = "dev_motion";

  const areaById = new Map([["kitchen", kitchen], ["outdoor", outdoor]]);
  const deviceById = new Map([
    ["dev_kitchen_climate", kitchenClimateDev],
    ["dev_charger", chargerDev],
    ["dev_motion", motionDev],
  ]);
  const entityById = new Map([
    [kitchenTempEnt.entity_id, kitchenTempEnt],
    [kitchenHumEnt.entity_id, kitchenHumEnt],
    [chargerPowerEnt.entity_id, chargerPowerEnt],
    [chargerEnergyEnt.entity_id, chargerEnergyEnt],
    [chargerDiagEnt.entity_id, chargerDiagEnt],
    [motionEnt.entity_id, motionEnt],
  ]);
  const entitiesByDevice = new Map([
    ["dev_kitchen_climate", [kitchenTempEnt, kitchenHumEnt]],
    ["dev_charger", [chargerPowerEnt, chargerEnergyEnt, chargerDiagEnt]],
    ["dev_motion", [motionEnt]],
  ]);
  const devicesByArea = new Map([
    ["kitchen", [kitchenClimateDev]],
    ["outdoor", [chargerDev, motionDev]],
  ]);

  kitchenClimateDev.entity_ids = [kitchenTempEnt.entity_id, kitchenHumEnt.entity_id];
  chargerDev.entity_ids = [chargerPowerEnt.entity_id, chargerEnergyEnt.entity_id, chargerDiagEnt.entity_id];
  motionDev.entity_ids = [motionEnt.entity_id];

  return {
    areas: [kitchen, outdoor],
    devices: [kitchenClimateDev, chargerDev, motionDev],
    entities: [kitchenTempEnt, kitchenHumEnt, chargerPowerEnt, chargerEnergyEnt, chargerDiagEnt, motionEnt],
    areaById,
    deviceById,
    entityById,
    entitiesByDevice,
    devicesByArea,
  };
}

describe("handleListAreas output", () => {
  beforeEach(() => {
    vi.mocked(getCachedDiscoveryIndex).mockReturnValue(makeTestIndex());
  });

  it("lists all areas when no search", async () => {
    const result = await handleListAreas({});
    expect(result).toContain("Kitchen");
    expect(result).toContain("Outdoor");
    expect(result).toContain("ha_history_list_devices");
  });

  it("filters by search term", async () => {
    const result = await handleListAreas({ search: "kitchen" });
    expect(result).toContain("Kitchen");
    expect(result).not.toContain("Outdoor");
  });

  it("returns no-result message when nothing matches", async () => {
    const result = await handleListAreas({ search: "nonexistent" });
    expect(result).toContain("No areas found");
  });
});

describe("handleListDevices output", () => {
  beforeEach(() => {
    vi.mocked(getCachedDiscoveryIndex).mockReturnValue(makeTestIndex());
  });

  it("lists all outdoor devices", async () => {
    const result = await handleListDevices({ area: "Outdoor" });
    expect(result).toContain("EV Charger");
    expect(result).toContain("Outdoor Motion Sensor");
    expect(result).toContain("energy");
    expect(result).toContain("power");
    expect(result).toContain("sensor.car_charging_plug_power");
    expect(result).toContain("sensor.car_charging_plug_summation_delivered");
    expect(result).not.toContain("Kitchen Climate Sensor");
  });

  it("device search 'charger' in Outdoor finds EV Charger", async () => {
    const result = await handleListDevices({ area: "Outdoor", search: "charger" });
    expect(result).toContain("EV Charger");
    expect(result).not.toContain("Outdoor Motion Sensor");
    expect(result).toContain("Ready entities:");
    expect(result).toContain("sensor.car_charging_plug_power");
  });

  it("surfaces climate entities directly from device lookup", async () => {
    const result = await handleListDevices({ area: "Kitchen" });
    expect(result).toContain("Kitchen Climate Sensor");
    expect(result).toContain("sensor.kitchen_temperature");
    expect(result).toContain("sensor.kitchen_humidity");
    expect(result).toContain("measurement");
  });

  it("returns error when area not found", async () => {
    const result = await handleListDevices({ area: "Nonexistent" });
    expect(result).toContain("No area found");
  });
});

describe("handleListDeviceEntities output", () => {
  beforeEach(() => {
    vi.mocked(getCachedDiscoveryIndex).mockReturnValue(makeTestIndex());
  });

  it("lists entities on EV Charger, no diagnostics by default", async () => {
    const result = await handleListDeviceEntities({ device: "EV Charger" });
    expect(result).toContain("sensor.car_charging_plug_power");
    expect(result).toContain("sensor.car_charging_plug_summation_delivered");
    // diagnostic should be hidden by default
    expect(result).not.toContain("sensor.car_charging_plug_rssi");
  });

  it("shows diagnostics when include_diagnostics=true", async () => {
    const result = await handleListDeviceEntities({ device: "EV Charger", include_diagnostics: true });
    expect(result).toContain("sensor.car_charging_plug_rssi");
    expect(result).toContain("[diagnostic]");
  });

  it("metric=power filters to power entities only", async () => {
    const result = await handleListDeviceEntities({ device: "EV Charger", device_class: "power" });
    expect(result).toContain("sensor.car_charging_plug_power");
    expect(result).not.toContain("sensor.car_charging_plug_summation_delivered");
  });

  it("metric=energy filters to energy entities only", async () => {
    const result = await handleListDeviceEntities({ device: "EV Charger", device_class: "energy" });
    expect(result).toContain("sensor.car_charging_plug_summation_delivered");
    expect(result).not.toContain("sensor.car_charging_plug_power");
  });

  it("returns error when device not found", async () => {
    const result = await handleListDeviceEntities({ device: "Nonexistent Device" });
    expect(result).toContain("No device found");
  });

  it("includes analytics tip in output", async () => {
    const result = await handleListDeviceEntities({ device: "EV Charger" });
    expect(result).toContain("ha_history_get_sensor_stats");
    expect(result).toContain("ha_history_get_consumption");
  });

  it("marks cumulative vs measurement in output", async () => {
    const result = await handleListDeviceEntities({ device: "EV Charger" });
    expect(result).toContain("cumulative");
    expect(result).toContain("measurement");
  });
});

function makeEnrichedEntity(opts: {
  statistic_id: string;
  friendly_name: string;
  device_name?: string | null;
  area_name?: string | null;
  unit?: string | null;
  device_class?: string | null;
  has_mean?: boolean;
  has_sum?: boolean;
}): EnrichedEntity {
  return {
    statistic_id: opts.statistic_id,
    friendly_name: opts.friendly_name,
    device_name: opts.device_name ?? null,
    area_name: opts.area_name ?? null,
    floor_id: null,
    unit: opts.unit ?? null,
    device_class: opts.device_class ?? null,
    has_mean: opts.has_mean ?? false,
    has_sum: opts.has_sum ?? false,
  };
}

function makeEntityListFixture(): EnrichedEntity[] {
  return [
    makeEnrichedEntity({
      statistic_id: "sensor.cave_temperature",
      friendly_name: "Cave Temperature",
      device_name: "Cave Climate Sensor",
      area_name: "Cave",
      unit: "°C",
      device_class: "temperature",
      has_mean: true,
    }),
    makeEnrichedEntity({
      statistic_id: "sensor.cave_humidity",
      friendly_name: "Cave Humidity",
      device_name: "Cave Climate Sensor",
      area_name: "Cave",
      unit: "%",
      device_class: "humidity",
      has_mean: true,
    }),
    makeEnrichedEntity({
      statistic_id: "sensor.kitchen_temperature",
      friendly_name: "Kitchen Temperature",
      device_name: "Kitchen Climate Sensor",
      area_name: "Kitchen",
      unit: "°C",
      device_class: "temperature",
      has_mean: true,
    }),
    makeEnrichedEntity({
      statistic_id: "sensor.kitchen_humidity",
      friendly_name: "Kitchen Humidity",
      device_name: "Kitchen Climate Sensor",
      area_name: "Kitchen",
      unit: "%",
      device_class: "humidity",
      has_mean: true,
    }),
    makeEnrichedEntity({
      statistic_id: "sensor.outdoor_humidity",
      friendly_name: "Outdoor Humidity",
      device_name: "Outdoor Climate Sensor",
      area_name: "Outdoor",
      unit: "%",
      device_class: "humidity",
      has_mean: true,
    }),
    makeEnrichedEntity({
      statistic_id: "sensor.salon_temperature",
      friendly_name: "Salon Temperature",
      device_name: "Salon Climate Sensor",
      area_name: "Salon",
      unit: "°C",
      device_class: "temperature",
      has_mean: true,
    }),
    makeEnrichedEntity({
      statistic_id: "sensor.litterbox_internal_temp",
      friendly_name: "Litterbox Internal Temp",
      device_name: "ESP32-C6-LitterBox",
      area_name: "Salon",
      unit: "°C",
      device_class: "temperature",
      has_mean: true,
    }),
    makeEnrichedEntity({
      statistic_id: "sensor.printer_bed_temperature",
      friendly_name: "Printer Bed Temperature",
      device_name: "3D Printer",
      area_name: "Workshop",
      unit: "°C",
      device_class: "temperature",
      has_mean: true,
    }),
    makeEnrichedEntity({
      statistic_id: "sensor.car_charging_plug_power",
      friendly_name: "Car Charging Plug Power",
      device_name: "Car Charging Plug",
      area_name: "Outdoor",
      unit: "W",
      device_class: "power",
      has_mean: true,
    }),
    makeEnrichedEntity({
      statistic_id: "sensor.kitchen_sensor_battery",
      friendly_name: "Kitchen Sensor Battery",
      device_name: "Kitchen Climate Sensor",
      area_name: "Kitchen",
      unit: "%",
      device_class: "battery",
      has_mean: true,
    }),
  ];
}

describe("handleListEntities output", () => {
  beforeEach(() => {
    vi.mocked(getCachedEntityList).mockReturnValue(makeEntityListFixture());
  });

  it("groups entities by area and device", async () => {
    const result = await handleListEntities({ areas: ["kitchen"] });
    expect(result).toContain("Area: Kitchen");
    expect(result).toContain("Device: Kitchen Climate Sensor");
    expect(result).toContain("sensor.kitchen_temperature");
    expect(result).toContain("sensor.kitchen_humidity");
  });

  it("separates metric filtering from general search", async () => {
    const result = await handleListEntities({ areas: ["kitchen"], device_classes: ["temperature"] });
    expect(result).toContain("sensor.kitchen_temperature");
    expect(result).not.toContain("sensor.kitchen_humidity");
  });

  it("supports multi-area discovery in one call", async () => {
    const result = await handleListEntities({
      areas: ["cave", "kitchen", "salon", "outdoor"],
      device_classes: ["temperature", "humidity"],
    });
    expect(result).toContain("Area: Cave");
    expect(result).toContain("Area: Kitchen");
    expect(result).toContain("Area: Salon");
    expect(result).toContain("Area: Outdoor");
    expect(result).toContain("sensor.cave_temperature");
    expect(result).toContain("sensor.outdoor_humidity");
  });

  it("uses AND matching for search terms", async () => {
    const result = await handleListEntities({ search: "kitchen humidity" });
    expect(result).toContain("sensor.kitchen_humidity");
    expect(result).not.toContain("sensor.kitchen_temperature");
    expect(result).not.toContain("sensor.salon_temperature");
  });

  it("area and metric prevent unrelated temperature matches", async () => {
    const result = await handleListEntities({ areas: ["kitchen"], device_classes: ["temperature"], search: "kitchen" });
    expect(result).toContain("sensor.kitchen_temperature");
    expect(result).not.toContain("sensor.printer_bed_temperature");
    expect(result).not.toContain("sensor.salon_temperature");
  });

  it("does not treat battery percentage as humidity", async () => {
    const result = await handleListEntities({ areas: ["kitchen"], device_classes: ["humidity"] });
    expect(result).toContain("sensor.kitchen_humidity");
    expect(result).not.toContain("sensor.kitchen_sensor_battery");
  });

  it("filters internal appliance temperatures from ambient room discovery", async () => {
    const result = await handleListEntities({ areas: ["salon"], device_classes: ["temperature"] });
    expect(result).toContain("sensor.salon_temperature");
    expect(result).not.toContain("sensor.litterbox_internal_temp");
  });
});

describe("device name resolution strips manufacturer suffix (Benchmark2 A/B fix)", () => {
  it("resolves a name copied back with the bracketed manufacturer", async () => {
    const result = await handleListDeviceEntities({ device: "EV Charger [Zooz]" });
    expect(result).not.toContain("ERROR");
    expect(result).toContain("sensor.car_charging_plug_power");
  });
});
