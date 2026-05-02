import "dotenv/config";
import bcrypt from "bcryptjs";
import { db } from "../src/db/client";
import { scannerUsers } from "../src/db/schema";
import { eq } from "drizzle-orm";

const [, , rawUser, password] = process.argv;

async function main() {
  if (!rawUser || !password) {
    // eslint-disable-next-line no-console
    console.error("Usage: npx tsx scripts/seed-scanner-user.ts <username> <password>");
    process.exit(1);
  }
  const username = rawUser.trim().toLowerCase();
  const hash = await bcrypt.hash(password, 12);
  const existing = await db.query.scannerUsers.findFirst({
    where: eq(scannerUsers.username, username)
  });
  if (existing) {
    await db
      .update(scannerUsers)
      .set({ passwordHash: hash, updatedAt: new Date() })
      .where(eq(scannerUsers.id, existing.id));
    // eslint-disable-next-line no-console
    console.log("Updated password for scanner user:", username);
    return;
  }
  await db.insert(scannerUsers).values({ username, passwordHash: hash });
  // eslint-disable-next-line no-console
  console.log("Created scanner user:", username);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
