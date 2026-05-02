import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../db/client";
import { config } from "../../config";
import { scannerUsers } from "../../db/schema";

const loginSchema = z.object({
  username: z.string().min(2).max(64),
  password: z.string().min(1).max(200)
});

export const scannerAuthRouter = express.Router();

scannerAuthRouter.post("/scanner/auth/login", async (req, res) => {
  const body = loginSchema.parse(req.body);
  const username = body.username.trim().toLowerCase();

  const user = await db.query.scannerUsers.findFirst({
    where: eq(scannerUsers.username, username)
  });

  const ok = user ? await bcrypt.compare(body.password, user.passwordHash) : false;
  if (!user || !ok) {
    res.status(401).json({ error: "Invalid username or password." });
    return;
  }

  const expiresInSec = Math.floor(config.scannerSessionDays * 24 * 60 * 60);
  const token = jwt.sign(
    { typ: "scanner", sub: user.id, username: user.username },
    config.jwtSecret,
    { expiresIn: `${config.scannerSessionDays}d` }
  );

  res.json({
    token,
    expiresIn: expiresInSec,
    username: user.username
  });
});

scannerAuthRouter.get("/scanner/auth/me", async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing bearer token." });
    return;
  }
  const raw = auth.slice(7).trim();
  if (!raw) {
    res.status(401).json({ error: "Missing bearer token." });
    return;
  }
  try {
    const payload = jwt.verify(raw, config.jwtSecret) as {
      typ?: string;
      sub?: string;
      username?: string;
    };
    if (payload.typ !== "scanner" || !payload.sub) {
      res.status(401).json({ error: "Invalid session." });
      return;
    }
    res.json({ id: payload.sub, username: payload.username });
  } catch {
    res.status(401).json({ error: "Session expired or invalid." });
  }
});
