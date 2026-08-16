import { timingSafeEqual } from "crypto";
import type { Request, Response, NextFunction } from "express";
import { ConfigError } from "./config.js";
import { logWarn } from "./logger.js";

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

export type TransportMode = "stdio" | "http";

/**
 * CLI contract:
 *   (no args)  → stdio transport (default)
 *   --stdio    → stdio transport (accepted no-op, kept for backward compat)
 *   --http     → streamable HTTP transport
 */
export function parseMode(argv: string[]): TransportMode {
  const args = argv.slice(2);
  if (args.includes("--http") || args.includes("http")) return "http";
  return "stdio";
}

// ---------------------------------------------------------------------------
// Bind-address policy
// ---------------------------------------------------------------------------

const LOOPBACK_HOSTS = new Set(["localhost", "::1", "[::1]", "::ffff:127.0.0.1"]);

/** True when `host` can only be reached from this machine. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (LOOPBACK_HOSTS.has(h)) return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * Binding to anything other than loopback exposes the server on the network,
 * which is only allowed when a bearer token is configured.
 */
export function assertHttpBindingAllowed(host: string, token: string | undefined): void {
  if (isLoopbackHost(host) || token) return;
  throw new ConfigError(
    `Refusing to start: HOST="${host}" is not a loopback address and MCP_HTTP_TOKEN is not set.\n` +
      `Binding to a non-loopback address exposes this server on the network, so a bearer token is required.\n` +
      `Either set MCP_HTTP_TOKEN=<a long random secret>, or leave HOST unset to bind to 127.0.0.1.`
  );
}

// ---------------------------------------------------------------------------
// Bearer-token authentication
// ---------------------------------------------------------------------------

export function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Extracts the token from an `Authorization: Bearer <token>` header. */
export function bearerToken(req: Pick<Request, "headers">): string | undefined {
  const header = req.headers["authorization"];
  if (typeof header !== "string") return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim();
}

/**
 * Extracts the token from a `?token=<token>` query parameter.
 *
 * Home Assistant's built-in `mcp` integration offers no token field in its
 * config flow (OAuth only) but passes the configured URL verbatim to its MCP
 * client, so the query parameter is the only way to authenticate that client.
 */
export function queryToken(req: Pick<Request, "query">): string | undefined {
  const raw = (req.query as Record<string, unknown> | undefined)?.["token"];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Rejects any request that presents neither the configured token as an
 * `Authorization: Bearer <token>` header nor as a `?token=<token>` query
 * parameter. Either form is sufficient.
 * No-op when no token is configured (only permitted on a loopback bind).
 */
export function requireAuth(token: string | undefined) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!token) {
      next();
      return;
    }
    const header = bearerToken(req);
    const query = queryToken(req);
    const ok =
      (header !== undefined && constantTimeEquals(header, token)) ||
      (query !== undefined && constantTimeEquals(query, token));
    if (!ok) {
      logWarn("HTTP", "unauthorized request rejected", {
        method: req.method,
        path: req.path,
        has_authorization: header !== undefined,
        has_query_token: query !== undefined,
      });
      res
        .status(401)
        .set("WWW-Authenticate", 'Bearer realm="mcp"')
        .json({
          error:
            "Unauthorized: valid 'Authorization: Bearer <token>' header or '?token=<token>' query parameter required",
        });
      return;
    }
    next();
  };
}
