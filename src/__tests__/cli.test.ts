import { describe, it, expect, vi } from "vitest";
import type { Request, Response, NextFunction } from "express";
import {
  parseMode,
  isLoopbackHost,
  assertHttpBindingAllowed,
  constantTimeEquals,
  bearerToken,
  queryToken,
  requireAuth,
} from "../cli.js";
import { ConfigError } from "../config.js";

describe("parseMode", () => {
  it("defaults to stdio with no arguments", () => {
    expect(parseMode(["node", "index.js"])).toBe("stdio");
  });

  it("accepts --stdio as a no-op (still stdio)", () => {
    expect(parseMode(["node", "index.js", "--stdio"])).toBe("stdio");
    expect(parseMode(["node", "index.js", "stdio"])).toBe("stdio");
  });

  it("selects http for --http", () => {
    expect(parseMode(["node", "index.js", "--http"])).toBe("http");
    expect(parseMode(["node", "index.js", "http"])).toBe("http");
  });

  it("ignores unrelated arguments", () => {
    expect(parseMode(["node", "index.js", "--verbose"])).toBe("stdio");
  });
});

describe("isLoopbackHost", () => {
  it("recognises loopback addresses", () => {
    for (const host of ["127.0.0.1", "127.1.2.3", "localhost", "LOCALHOST", "::1", "[::1]"]) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
  });

  it("rejects non-loopback addresses", () => {
    for (const host of ["0.0.0.0", "::", "192.168.1.10", "10.0.0.5", "example.com", "128.0.0.1"]) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });
});

describe("assertHttpBindingAllowed", () => {
  it("allows loopback without a token", () => {
    expect(() => assertHttpBindingAllowed("127.0.0.1", undefined)).not.toThrow();
  });

  it("refuses a non-loopback bind without a token", () => {
    expect(() => assertHttpBindingAllowed("0.0.0.0", undefined)).toThrow(ConfigError);
    expect(() => assertHttpBindingAllowed("0.0.0.0", undefined)).toThrow(/MCP_HTTP_TOKEN/);
  });

  it("allows a non-loopback bind when a token is set", () => {
    expect(() => assertHttpBindingAllowed("0.0.0.0", "secret")).not.toThrow();
  });
});

describe("constantTimeEquals", () => {
  it("matches identical strings and rejects others", () => {
    expect(constantTimeEquals("abc", "abc")).toBe(true);
    expect(constantTimeEquals("abc", "abd")).toBe(false);
    expect(constantTimeEquals("abc", "abcd")).toBe(false);
    expect(constantTimeEquals("", "")).toBe(true);
  });
});

describe("bearerToken", () => {
  it("extracts the token, case-insensitively on the scheme", () => {
    expect(bearerToken({ headers: { authorization: "Bearer s3cret" } } as unknown as Request)).toBe("s3cret");
    expect(bearerToken({ headers: { authorization: "bearer s3cret" } } as unknown as Request)).toBe("s3cret");
  });

  it("returns undefined for missing or non-bearer headers", () => {
    expect(bearerToken({ headers: {} } as unknown as Request)).toBeUndefined();
    expect(bearerToken({ headers: { authorization: "Basic abc" } } as unknown as Request)).toBeUndefined();
  });
});

describe("queryToken", () => {
  it("extracts a ?token= query parameter", () => {
    expect(queryToken({ query: { token: "s3cret" } } as unknown as Request)).toBe("s3cret");
    expect(queryToken({ query: { token: "  s3cret  " } } as unknown as Request)).toBe("s3cret");
  });

  it("returns undefined for missing, empty, or repeated parameters", () => {
    expect(queryToken({ query: {} } as unknown as Request)).toBeUndefined();
    expect(queryToken({ query: { token: "" } } as unknown as Request)).toBeUndefined();
    expect(queryToken({ query: { token: "   " } } as unknown as Request)).toBeUndefined();
    // express parses ?token=a&token=b into an array — not a usable credential
    expect(queryToken({ query: { token: ["a", "b"] } } as unknown as Request)).toBeUndefined();
    expect(queryToken({} as unknown as Request)).toBeUndefined();
  });
});

function mockRes(): Response & { statusCode?: number; body?: unknown } {
  const res = {
    statusCode: undefined as number | undefined,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    set() {
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as Response & { statusCode?: number; body?: unknown };
}

describe("requireAuth", () => {
  const req = (headers: Record<string, string> = {}, query: Record<string, unknown> = {}) =>
    ({ headers, query, method: "POST", path: "/mcp" }) as unknown as Request;

  const run = (token: string | undefined, request: Request) => {
    const next = vi.fn() as unknown as NextFunction;
    const res = mockRes();
    requireAuth(token)(request, res, next);
    return { next, res };
  };

  it("passes everything through when no token is configured", () => {
    const { next, res } = run(undefined, req());
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBeUndefined();
  });

  it("rejects requests presenting no credential at all with 401", () => {
    const { next, res } = run("s3cret", req());
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it("rejects a wrong bearer token with 401", () => {
    const { next, res } = run("s3cret", req({ authorization: "Bearer wrong" }));
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it("accepts the correct bearer token", () => {
    const { next, res } = run("s3cret", req({ authorization: "Bearer s3cret" }));
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBeUndefined();
  });

  it("accepts the correct token as a ?token= query parameter", () => {
    const { next, res } = run("s3cret", req({}, { token: "s3cret" }));
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBeUndefined();
  });

  it("rejects a wrong query token with 401", () => {
    const { next, res } = run("s3cret", req({}, { token: "wrong" }));
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it("accepts when either form is correct, even if the other is wrong", () => {
    const headerOk = run("s3cret", req({ authorization: "Bearer s3cret" }, { token: "wrong" }));
    expect(headerOk.next).toHaveBeenCalledOnce();
    const queryOk = run("s3cret", req({ authorization: "Bearer wrong" }, { token: "s3cret" }));
    expect(queryOk.next).toHaveBeenCalledOnce();
  });

  it("rejects with 401 when both forms are wrong", () => {
    const { next, res } = run("s3cret", req({ authorization: "Bearer nope" }, { token: "wrong" }));
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ error: expect.stringContaining("token") });
  });
});
