import "dotenv/config";

export interface Config {
  haUrl: string;
  haToken: string;
  haName: string;
  haTimezone: string | undefined;
  /** When true, TLS certificate verification against HA is disabled (self-signed certs). */
  haInsecureTls: boolean;
  port: number;
  /** Bind address for HTTP mode. Defaults to loopback. */
  host: string;
  /** Bearer token required on /mcp requests when set. */
  httpToken: string | undefined;
  maxResults: number; // default row cap for time-series responses
  cacheMaxEntries: number; // hard cap on in-memory cache entries
}

/** Thrown when required configuration is missing or malformed. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_CACHE_MAX_ENTRIES = 500;

function requiredEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    throw new ConfigError(
      `Missing required environment variable ${name}. ` +
        `Set it in the environment or in a .env file (see .env.example).`
    );
  }
  return val;
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ConfigError(
      `Environment variable ${name} must be a positive integer (got "${raw}").`
    );
  }
  return parsed;
}

function boolEnv(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * Lazily-evaluated configuration.
 *
 * Every property reads `process.env` on access, so importing this module has no
 * side effects and never terminates the process. Accessing a property backed by
 * a missing required variable throws a `ConfigError` — the CLI entry point
 * catches it and exits with a clean message; tests can import freely.
 */
export const config: Config = {
  get haUrl(): string {
    return requiredEnv("HA_URL").replace(/\/$/, ""); // strip trailing slash
  },
  get haToken(): string {
    return requiredEnv("HA_TOKEN");
  },
  get haName(): string {
    return process.env["HA_NAME"] ?? "Home";
  },
  get haTimezone(): string | undefined {
    return process.env["HA_TIMEZONE"];
  },
  get haInsecureTls(): boolean {
    return boolEnv("HA_INSECURE_TLS");
  },
  get port(): number {
    return intEnv("PORT", 3000);
  },
  get host(): string {
    const raw = process.env["HOST"]?.trim();
    return raw && raw.length > 0 ? raw : DEFAULT_HOST;
  },
  get httpToken(): string | undefined {
    const raw = process.env["MCP_HTTP_TOKEN"]?.trim();
    return raw && raw.length > 0 ? raw : undefined;
  },
  get maxResults(): number {
    return intEnv("MAX_RESULTS", 100);
  },
  get cacheMaxEntries(): number {
    return intEnv("CACHE_MAX_ENTRIES", DEFAULT_CACHE_MAX_ENTRIES);
  },
};

/**
 * Validates and snapshots the full configuration.
 * Throws `ConfigError` when a required variable is missing.
 * Call this once at startup to fail fast instead of on first use.
 */
export function getConfig(): Config {
  return {
    haUrl: config.haUrl,
    haToken: config.haToken,
    haName: config.haName,
    haTimezone: config.haTimezone,
    haInsecureTls: config.haInsecureTls,
    port: config.port,
    host: config.host,
    httpToken: config.httpToken,
    maxResults: config.maxResults,
    cacheMaxEntries: config.cacheMaxEntries,
  };
}
