/**
 * Unit tests for the auth middleware.
 *
 * Tests cover all authentication edge cases:
 *   - Valid Bearer token → next() is called, no response sent
 *   - Missing Authorization header → 401
 *   - Wrong token value → 401
 *   - Malformed header (no "Bearer " prefix) → 401
 *   - Empty token after "Bearer " → 401
 *
 * Uses mock Express req/res/next objects — no real HTTP server needed.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { createAuthMiddleware } from "../auth.js";
import type { Request, Response, NextFunction } from "express";

/** The API key the middleware will validate against */
const TEST_API_KEY = "fc_test_key_12345";

/** Create a mock Express request with optional Authorization header */
function mockRequest(authHeader?: string): Request {
  return {
    headers: {
      ...(authHeader !== undefined ? { authorization: authHeader } : {}),
    },
  } as unknown as Request;
}

/** Create a mock Express response that captures status and JSON body */
function mockResponse(): Response & {
  _status: number | null;
  _body: unknown;
} {
  const res = {
    _status: null as number | null,
    _body: undefined as unknown,
    status(code: number) {
      res._status = code;
      return res;
    },
    json(body: unknown) {
      res._body = body;
      return res;
    },
  };
  return res as unknown as Response & { _status: number | null; _body: unknown };
}

describe("createAuthMiddleware", () => {
  let authMiddleware: ReturnType<typeof createAuthMiddleware>;

  beforeEach(() => {
    authMiddleware = createAuthMiddleware(TEST_API_KEY);
  });

  test("calls next() for a valid Bearer token", () => {
    const req = mockRequest(`Bearer ${TEST_API_KEY}`);
    const res = mockResponse();
    const next = mock(() => {}) as any as NextFunction;

    authMiddleware(req, res, next);

    // next() should have been called exactly once
    expect(next).toHaveBeenCalledTimes(1);
    // No response should have been sent
    expect(res._status).toBeNull();
    expect(res._body).toBeUndefined();
  });

  test("returns 401 when Authorization header is missing", () => {
    const req = mockRequest(); // no auth header
    const res = mockResponse();
    const next = mock(() => {}) as any as NextFunction;

    authMiddleware(req, res, next);

    expect(res._status).toBe(401);
    expect(res._body).toEqual({ error: "Missing or invalid API key" });
    expect(next).not.toHaveBeenCalled();
  });

  test("returns 401 when token is wrong", () => {
    const req = mockRequest("Bearer wrong_key_value");
    const res = mockResponse();
    const next = mock(() => {}) as any as NextFunction;

    authMiddleware(req, res, next);

    expect(res._status).toBe(401);
    expect(res._body).toEqual({ error: "Missing or invalid API key" });
    expect(next).not.toHaveBeenCalled();
  });

  test("returns 401 for malformed header without Bearer prefix", () => {
    const req = mockRequest(`Basic ${TEST_API_KEY}`);
    const res = mockResponse();
    const next = mock(() => {}) as any as NextFunction;

    authMiddleware(req, res, next);

    expect(res._status).toBe(401);
    expect(res._body).toEqual({ error: "Missing or invalid API key" });
    expect(next).not.toHaveBeenCalled();
  });

  test("returns 401 for header with just the token (no Bearer prefix)", () => {
    const req = mockRequest(TEST_API_KEY);
    const res = mockResponse();
    const next = mock(() => {}) as any as NextFunction;

    authMiddleware(req, res, next);

    expect(res._status).toBe(401);
    expect(res._body).toEqual({ error: "Missing or invalid API key" });
    expect(next).not.toHaveBeenCalled();
  });

  test("returns 401 for empty token after Bearer prefix", () => {
    const req = mockRequest("Bearer ");
    const res = mockResponse();
    const next = mock(() => {}) as any as NextFunction;

    authMiddleware(req, res, next);

    // Empty string token won't match the API key (different length)
    expect(res._status).toBe(401);
    expect(res._body).toEqual({ error: "Missing or invalid API key" });
    expect(next).not.toHaveBeenCalled();
  });

  test("returns 401 for empty Authorization header", () => {
    const req = mockRequest("");
    const res = mockResponse();
    const next = mock(() => {}) as any as NextFunction;

    authMiddleware(req, res, next);

    expect(res._status).toBe(401);
    expect(res._body).toEqual({ error: "Missing or invalid API key" });
    expect(next).not.toHaveBeenCalled();
  });
});
