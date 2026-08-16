import { describe, it, expect, afterEach } from "vitest";
import { config, getConfig, ConfigError, DEFAULT_HOST, DEFAULT_CACHE_MAX_ENTRIES } from "../config.js";

const saved = { ...process.env };

afterEach(() => {
  process.env = { ...saved };
});

describe("config lazy evaluation", () => {
  it("does not throw at import time and reads env on access", () => {
    // vitest.config.ts provides HA_URL / HA_TOKEN — importing the module is safe.
    expect(config.haUrl).toBe("http://ha.test.local");
    expect(config.haToken).toBe("test-token");
  });

  it("throws a descriptive ConfigError instead of exiting when a required var is missing", () => {
    delete process.env["HA_URL"];
    expect(() => config.haUrl).toThrow(ConfigError);
    expect(() => config.haUrl).toThrow(/HA_URL/);
    expect(() => getConfig()).toThrow(ConfigError);
  });

  it("reflects env changes on each access (no import-time snapshot)", () => {
    process.env["HA_NAME"] = "Changed";
    expect(config.haName).toBe("Changed");
    process.env["HA_NAME"] = "Changed Again";
    expect(config.haName).toBe("Changed Again");
  });

  it("strips a trailing slash from HA_URL", () => {
    process.env["HA_URL"] = "https://ha.example.com/";
    expect(config.haUrl).toBe("https://ha.example.com");
  });

  it("applies defaults for optional variables", () => {
    delete process.env["HOST"];
    delete process.env["MCP_HTTP_TOKEN"];
    delete process.env["HA_INSECURE_TLS"];
    delete process.env["CACHE_MAX_ENTRIES"];
    delete process.env["MAX_RESULTS"];
    expect(config.host).toBe(DEFAULT_HOST);
    expect(config.httpToken).toBeUndefined();
    expect(config.haInsecureTls).toBe(false);
    expect(config.cacheMaxEntries).toBe(DEFAULT_CACHE_MAX_ENTRIES);
    expect(config.maxResults).toBe(100);
  });

  it("parses HA_INSECURE_TLS truthy values", () => {
    for (const raw of ["1", "true", "TRUE", "yes", "on"]) {
      process.env["HA_INSECURE_TLS"] = raw;
      expect(config.haInsecureTls, raw).toBe(true);
    }
    for (const raw of ["0", "false", "no", ""]) {
      process.env["HA_INSECURE_TLS"] = raw;
      expect(config.haInsecureTls, raw).toBe(false);
    }
  });

  it("rejects a non-numeric integer variable with ConfigError", () => {
    process.env["CACHE_MAX_ENTRIES"] = "not-a-number";
    expect(() => config.cacheMaxEntries).toThrow(ConfigError);
  });

  it("getConfig returns a plain validated snapshot", () => {
    const snapshot = getConfig();
    expect(snapshot.haUrl).toBe("http://ha.test.local");
    expect(snapshot.haName).toBe("TestHA");
    process.env["HA_NAME"] = "Later";
    expect(snapshot.haName).toBe("TestHA"); // snapshot, not a live view
  });
});
