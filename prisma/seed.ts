/**
 * Thin wrapper for `npx prisma db seed` (local development via tsx).
 * Core logic lives in src/seed.ts so it compiles to dist/seed.js for production.
 */
import "dotenv/config";
import { runSeed } from "../src/seed";

runSeed()
  .then(() => {
    console.log("Seed completed.");
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
