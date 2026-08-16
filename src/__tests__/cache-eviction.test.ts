import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setCached, getCached, cacheSize, clearCache } from "../cache.js";

const saved = { ...process.env };

beforeEach(() => {
  clearCache();
});

afterEach(() => {
  process.env = { ...saved };
  clearCache();
});

describe("cache eviction", () => {
  it("caps the store at CACHE_MAX_ENTRIES", () => {
    process.env["CACHE_MAX_ENTRIES"] = "5";
    for (let i = 0; i < 50; i++) setCached(`k${i}`, i, null);
    expect(cacheSize()).toBe(5);
  });

  it("evicts oldest entries first", () => {
    process.env["CACHE_MAX_ENTRIES"] = "3";
    setCached("a", 1, null);
    setCached("b", 2, null);
    setCached("c", 3, null);
    setCached("d", 4, null); // evicts "a"
    expect(getCached("a")).toBeUndefined();
    expect(getCached("b")).toBe(2);
    expect(getCached("d")).toBe(4);
  });

  it("treats a read as recent use (LRU, not plain FIFO)", () => {
    process.env["CACHE_MAX_ENTRIES"] = "3";
    setCached("a", 1, null);
    setCached("b", 2, null);
    setCached("c", 3, null);
    expect(getCached("a")).toBe(1); // refreshes "a", making "b" the oldest
    setCached("d", 4, null);
    expect(getCached("b")).toBeUndefined();
    expect(getCached("a")).toBe(1);
  });

  it("overwriting an existing key does not grow the store", () => {
    process.env["CACHE_MAX_ENTRIES"] = "10";
    for (let i = 0; i < 20; i++) setCached("same", i, null);
    expect(cacheSize()).toBe(1);
    expect(getCached("same")).toBe(19);
  });

  it("still honours TTL expiry", () => {
    setCached("expiring", "v", -1); // already expired
    expect(getCached("expiring")).toBeUndefined();
  });

  it("falls back to the default cap when CACHE_MAX_ENTRIES is invalid", () => {
    process.env["CACHE_MAX_ENTRIES"] = "garbage";
    expect(() => setCached("x", 1, null)).not.toThrow();
    expect(getCached("x")).toBe(1);
  });
});
