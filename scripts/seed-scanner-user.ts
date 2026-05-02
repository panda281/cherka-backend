import "dotenv/config";
import bcrypt from "bcryptjs";
import { db } from "../src/db/client";
import { scannerUsers } from "../src/db/schema";
import { eq } from "drizzle-orm";
import type { ScannerRole } from "../src/modules/scanner/scanAuth";

const [, , rawUser, password, rawRole] = process.argv;

function parseRole(arg: string | undefined): ScannerRole | undefined {
  const r = arg?.trim().toLowerCase();
  if (r === "gate" || r === "finance" || r === "organizer_admin") return r;
  return undefined;
}

async function main() {
  if (!rawUser || !password) {
    // eslint-disable-next-line no-console
    console.error(
      "Usage: npx tsx scripts/seed-scanner-user.ts <username> <password> [gate|finance|organizer_admin]"
    );
    process.exit(1);
  }
  const username = rawUser.trim().toLowerCase();
  const roleFromArg = parseRole(rawRole);
  const role = roleFromArg ?? "organizer_admin";
  const hash = await bcrypt.hash(password, 12);
  const existing = await db.query.scannerUsers.findFirst({
    where: eq(scannerUsers.username, username)
  });
  if (existing) {
    await db
      .update(scannerUsers)
      .set({
        passwordHash: hash,
        ...(roleFromArg != null ? { role: roleFromArg } : {}),
        updatedAt: new Date()
      })
      .where(eq(scannerUsers.id, existing.id));
    // eslint-disable-next-line no-console
    console.log("Updated scanner user:", username, roleFromArg != null ? `(role → ${roleFromArg})` : "");
    return;
  }
  await db.insert(scannerUsers).values({ username, passwordHash: hash, role });
  // eslint-disable-next-line no-console
  console.log("Created scanner user:", username, "role:", role);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
