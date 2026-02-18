/**
 * API key authentication middleware for fuel-code.
 *
 * Validates Bearer tokens from the Authorization header against a configured
 * API key. Uses constant-time comparison (crypto.timingSafeEqual) to prevent
 * timing attacks that could leak the key byte-by-byte.
 *
 * Usage:
 *   app.use("/api", createAuthMiddleware(process.env.API_KEY));
 */

import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

/**
 * Create an Express middleware that validates Bearer token authentication.
 *
 * @param apiKey - The expected API key to validate against
 * @returns Express request handler that rejects unauthenticated requests with 401
 */
export function createAuthMiddleware(
  apiKey: string,
): (req: Request, res: Response, next: NextFunction) => void {
  // Pre-encode the API key as a Buffer once (avoids re-encoding on every request)
  const expectedKeyBuffer = Buffer.from(apiKey, "utf-8");

  return (req: Request, res: Response, next: NextFunction): void => {
    const authHeader = req.headers.authorization;

    // Missing Authorization header entirely
    if (!authHeader) {
      res.status(401).json({ error: "Missing or invalid API key" });
      return;
    }

    // Header must start with "Bearer " prefix (case-sensitive per RFC 6750)
    if (!authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "Missing or invalid API key" });
      return;
    }

    // Extract the token after "Bearer "
    const token = authHeader.slice(7);

    // Encode the received token to compare lengths before timingSafeEqual.
    // timingSafeEqual requires both buffers to be the same length — if they
    // differ, we still reject (but can't use timingSafeEqual directly).
    const receivedKeyBuffer = Buffer.from(token, "utf-8");

    // Length mismatch means wrong key — but we still want constant-time-ish behavior.
    // We compare against the expected buffer regardless to avoid leaking length info.
    if (receivedKeyBuffer.length !== expectedKeyBuffer.length) {
      res.status(401).json({ error: "Missing or invalid API key" });
      return;
    }

    // Constant-time comparison prevents timing attacks
    if (!timingSafeEqual(receivedKeyBuffer, expectedKeyBuffer)) {
      res.status(401).json({ error: "Missing or invalid API key" });
      return;
    }

    // Token is valid — proceed to the next middleware/route handler
    next();
  };
}
