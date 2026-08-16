/**
 * Error formatting for MCP tool responses.
 *
 * Rules:
 * - Never throw. Always return a readable string the LLM can relay to the user.
 * - Say what went wrong, why it probably happened, and what to do next.
 * - Keep messages under ~80 words so they stay in active context.
 */

export interface McpError {
  isError: true;
  text: string;
}

export function isError(v: unknown): v is McpError {
  return typeof v === "object" && v !== null && (v as McpError).isError === true;
}

/** HA instance is not reachable (network, DNS, wrong URL). */
export function errUnreachable(url: string): McpError {
  return {
    isError: true,
    text:
      `ERROR: Cannot connect to Home Assistant at ${url}.\n` +
      `Check that HA_URL is correct and the instance is running.\n` +
      `Tell the user: "I cannot reach the Home Assistant instance right now."`,
  };
}

/** HA returned 401. */
export function errUnauthorized(): McpError {
  return {
    isError: true,
    text:
      `ERROR: Home Assistant returned 401 Unauthorized.\n` +
      `The HA_TOKEN is invalid or expired.\n` +
      `Tell the user: "The Home Assistant API token is invalid. ` +
      `Please generate a new Long-Lived Access Token from the HA Profile page."`,
  };
}

/** HA request timed out. */
export function errTimeout(url: string): McpError {
  return {
    isError: true,
    text:
      `ERROR: Home Assistant did not respond within 30 seconds (${url}).\n` +
      `The recorder query may be too large. Try a shorter time range.\n` +
      `Tell the user: "Home Assistant is taking too long to respond."`,
  };
}

/** Generic HA HTTP error. */
export function errHttp(status: number, url: string): McpError {
  return {
    isError: true,
    text:
      `ERROR: Home Assistant returned HTTP ${status} for ${url}.\n` +
      (status === 404
        ? `The entity may not exist or the endpoint is unavailable on this HA version. ` +
          `Verify the entity_id with ha_history_list_entities.\n`
        : `Retry once; if it persists, the HA instance may be misbehaving.\n`) +
      `Tell the user: "Unexpected error from Home Assistant (HTTP ${status})."`,
  };
}

/** Convert any caught error into a readable McpError. */
export function errFromCaught(err: unknown, context: string): McpError {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    text:
      `ERROR during ${context}: ${msg}\n` +
      `The call did not produce a result. Retry once; if it persists, ` +
      `try a shorter period or fewer entities, and report the message above to the user.`,
  };
}
