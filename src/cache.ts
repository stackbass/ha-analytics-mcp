import { deriveEnrichedEntities, fetchHAConfig, fetchDiscoveryIndex, HAConfig, EnrichedEntity, DiscoveryIndex } from "./ha-client.js";
import { config, DEFAULT_CACHE_MAX_ENTRIES } from "./config.js";
import { isError } from "./errors.js";
import { logError, logInfo, summarizeCacheKey } from "./logger.js";

interface CacheEntry<T> {
  value: T;
  expiresAt: number | null; // null = never expires
}

// Map preserves insertion order; a hit re-inserts its key so eviction is LRU.
const store = new Map<string, CacheEntry<unknown>>();

/** Hard cap on stored entries. Overridable with CACHE_MAX_ENTRIES. */
function maxEntries(): number {
  try {
    return config.cacheMaxEntries;
  } catch {
    return DEFAULT_CACHE_MAX_ENTRIES;
  }
}

/** Drops least-recently-used entries until the store fits within `limit`. */
function evictToLimit(limit: number): void {
  while (store.size > limit) {
    const oldest = store.keys().next();
    if (oldest.done) return;
    store.delete(oldest.value);
    logInfo("CACHE", "evicted", { key: summarizeCacheKey(oldest.value), size: store.size });
  }
}

function get<T>(key: string): T | undefined {
  const entry = store.get(key) as CacheEntry<T> | undefined;
  const shortKey = summarizeCacheKey(key);
  if (!entry) {
    logInfo("CACHE", "miss", { key: shortKey });
    return undefined;
  }
  if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
    store.delete(key);
    logInfo("CACHE", "expired", { key: shortKey });
    return undefined;
  }
  // Mark as most recently used.
  store.delete(key);
  store.set(key, entry as CacheEntry<unknown>);
  logInfo("CACHE", "hit", { key: shortKey });
  return entry.value;
}

function set<T>(key: string, value: T, ttlMs: number | null): void {
  store.delete(key); // re-insert so the key moves to the most-recent position
  store.set(key, {
    value,
    expiresAt: ttlMs !== null ? Date.now() + ttlMs : null,
  });
  evictToLimit(maxEntries());
  logInfo("CACHE", "store", {
    key: summarizeCacheKey(key),
    ttl_ms: ttlMs,
    persistent: ttlMs === null,
  });
}

// ---------------------------------------------------------------------------
// Typed cache helpers
// ---------------------------------------------------------------------------

const ENTITY_LIST_TTL_MS = 60 * 60 * 1000; // 1 hour
const HA_CONFIG_TTL_MS = 60 * 60 * 1000; // 1 hour

export function getCachedEntityList(): EnrichedEntity[] | undefined {
  return get<EnrichedEntity[]>("entity_list");
}

export function setCachedEntityList(list: EnrichedEntity[]): void {
  set("entity_list", list, ENTITY_LIST_TTL_MS);
}

export function getCachedHAConfig(): HAConfig | undefined {
  return get<HAConfig>("ha_config");
}

export function setCachedHAConfig(cfg: HAConfig): void {
  set("ha_config", cfg, HA_CONFIG_TTL_MS);
}

/**
 * Reloads the HA config when the cache entry is missing or expired (1 h TTL).
 * Without it, getTz() silently fell back to UTC one hour after startup and
 * every day boundary and day label shifted (Europe/Rome: values under the
 * previous day's date). Non-fatal: on failure the fallback stays in place.
 */
export async function ensureHAConfig(): Promise<void> {
  if (getCachedHAConfig()) return;
  const result = await fetchHAConfig();
  if (isError(result)) {
    logError("CACHE", "could not reload HA config", { error: result.text.split("\n")[0] });
    return;
  }
  setCachedHAConfig(result);
}

/** Cache for statistics API responses. Immutable for periods ending >48h ago. */
export function getCachedStats(key: string): unknown | undefined {
  return get(key);
}

export function setCachedStats(
  key: string,
  value: unknown,
  endTime: Date
): void {
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  const ttl = endTime.getTime() < cutoff
    ? null                    // historical data: never expires
    : 5 * 60 * 1000;          // recent data: 5-minute TTL
  set(key, value, ttl);
}

/** Cache for short-term history (binary sensors). Always 2-minute TTL. */
export function getCachedHistory(key: string): unknown | undefined {
  return get(key);
}

export function setCachedHistory(key: string, value: unknown): void {
  set(key, value, 2 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Discovery index cache
// ---------------------------------------------------------------------------

const DISCOVERY_INDEX_TTL_MS = 60 * 60 * 1000; // 1 hour

export function getCachedDiscoveryIndex(): DiscoveryIndex | undefined {
  return get<DiscoveryIndex>("discovery_index");
}

export function setCachedDiscoveryIndex(index: DiscoveryIndex): void {
  set("discovery_index", index, DISCOVERY_INDEX_TTL_MS);
}

export function cacheSize(): number {
  return store.size;
}

/** Removes every cached entry. Primarily used by tests. */
export function clearCache(): void {
  store.clear();
}

/** Generic put, used by tests and callers that manage their own key/TTL. */
export function setCached<T>(key: string, value: T, ttlMs: number | null): void {
  set(key, value, ttlMs);
}

/** Generic read, used by tests and callers that manage their own key/TTL. */
export function getCached<T>(key: string): T | undefined {
  return get<T>(key);
}

// ---------------------------------------------------------------------------
// Startup prefetch
// ---------------------------------------------------------------------------

let haReachable = false;

export function isHAReachable(): boolean {
  return haReachable;
}

/** Called at startup. Warms the HA config and discovery index caches. Derives entity list from the same snapshot. Non-fatal on failure. */
export async function prefetchStartupData(): Promise<void> {
  logInfo("STARTUP", "prefetching HA config and discovery index");

  const [cfgResult, discoveryResult] = await Promise.all([
    fetchHAConfig(),
    fetchDiscoveryIndex(),
  ]);

  if (isError(cfgResult)) {
    logError("STARTUP", "could not fetch HA config", { error: cfgResult.text.split("\n")[0] });
  } else {
    setCachedHAConfig(cfgResult);
    logInfo("STARTUP", "connected to HA", {
      location: cfgResult.locationName,
      version: cfgResult.version,
      timezone: cfgResult.timezone,
    });
    haReachable = true;
  }

  if (isError(discoveryResult)) {
    logError("STARTUP", "could not fetch discovery index", { error: discoveryResult.text.split("\n")[0] });
  } else {
    setCachedDiscoveryIndex(discoveryResult);
    // Derive entity list from the same snapshot — no extra HA calls needed
    setCachedEntityList(deriveEnrichedEntities(discoveryResult));
    logInfo("STARTUP", "discovery index cached", {
      areas: discoveryResult.areas.length,
      devices: discoveryResult.devices.length,
      entities: discoveryResult.entities.length,
    });
    haReachable = true;
  }
}
