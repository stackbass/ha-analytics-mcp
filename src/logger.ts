type LogDetails = Record<string, unknown> | undefined;

function formatDetails(details: LogDetails): string {
  if (!details || Object.keys(details).length === 0) return "";
  try {
    return ` ${JSON.stringify(details)}`;
  } catch {
    return ` ${String(details)}`;
  }
}

// All log output goes to stderr: in stdio transport mode stdout carries the
// JSON-RPC stream and any stray write to it corrupts the protocol.
function log(level: "INFO" | "WARN" | "ERROR", scope: string, message: string, details?: LogDetails): void {
  const line = `${new Date().toISOString()} [${level}] [${scope}] ${message}${formatDetails(details)}`;
  if (level === "WARN") {
    console.warn(line);
  } else {
    console.error(line);
  }
}

function summarizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value.length > 120 ? `${value.slice(0, 117)}...` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    if (value.length <= 5) return value.map(summarizeValue);
    return [...value.slice(0, 5).map(summarizeValue), `…+${value.length - 5} more`];
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 12);
    return Object.fromEntries(entries.map(([k, v]) => [k, summarizeValue(v)]));
  }
  return String(value);
}

export function summarizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, summarizeValue(v)]));
}

export function summarizeCacheKey(key: string): string {
  if (key.length <= 120) return key;
  return `${key.slice(0, 70)}...${key.slice(-35)}`;
}

export function logInfo(scope: string, message: string, details?: LogDetails): void {
  log("INFO", scope, message, details);
}

export function logWarn(scope: string, message: string, details?: LogDetails): void {
  log("WARN", scope, message, details);
}

export function logError(scope: string, message: string, details?: LogDetails): void {
  log("ERROR", scope, message, details);
}
