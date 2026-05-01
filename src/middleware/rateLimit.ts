import type { Request, Response, NextFunction } from "express";

type Counter = { count: number; resetAt: number };

export function rateLimit(limit: number, windowMs: number) {
  const counters = new Map<string, Counter>();

  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip ?? "unknown";
    const now = Date.now();
    const current = counters.get(key);

    if (!current || now > current.resetAt) {
      counters.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }

    if (current.count >= limit) {
      res.status(429).json({ error: "Too many requests, please try again later." });
      return;
    }

    current.count += 1;
    counters.set(key, current);
    next();
  };
}
