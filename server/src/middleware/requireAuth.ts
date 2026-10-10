import type { Request, Response, NextFunction } from "express";
import { verifyAccessToken } from "../services/authService.js";
import { isDevAccountId, isLocalRequest, rejectDevAccount } from "./devAccountLocalOnly.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

/**
 * Every /api/sync/* and account route requires a valid, unexpired access
 * token. This never touches the database - it's a pure signature check -
 * which keeps sync requests cheap even with many devices polling frequently.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "missing_token", message: "Authorization header required" });
    return;
  }

  let userId: string;
  try {
    userId = verifyAccessToken(header.slice("Bearer ".length)).userId;
  } catch {
    res.status(401).json({ error: "invalid_token", message: "Access token is invalid or expired" });
    return;
  }
  if (isDevAccountId(userId) && !isLocalRequest(req)) {
    rejectDevAccount(res);
    return;
  }
  req.userId = userId;
  next();
}
