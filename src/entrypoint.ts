/**
 * Container startup orchestrator: migrate → seed → server.
 *
 * Replaces the Dockerfile CMD shell chain. Each phase emits colored,
 * labeled log output (ANSI) to stdout for easy identification in CloudWatch.
 */
import "dotenv/config";
import { spawnSync } from "child_process";
import { migrationLog, seedLog, appLog, errorLog, successLog } from "./lib/deploy-logger";
import { envStore, configureEnv } from "./env-store";

async function ensureDatabaseUrl(): Promise<void> {
  await configureEnv();

  process.env.DATABASE_URL = envStore.DATABASE_URL;
  migrationLog(`DATABASE_URL loaded from env-store (host: ${envStore.DB_HOST})`);
}

function isProductionEnv(): boolean {
  return process.env.NODE_ENV === "production" || process.env.DCS_ENV === "production";
}

function shouldSeed(): boolean {
  if (!isProductionEnv()) return true;
  return process.env.SEED_EMPLOYEES === "true";
}

async function runMigration(): Promise<void> {
  migrationLog("Starting database migration...");
  const start = Date.now();

  const result = spawnSync("npx", ["prisma", "migrate", "deploy"], {
    stdio: ["inherit", "pipe", "pipe"],
    encoding: "utf-8",
    env: process.env,
  });

  if (result.stdout) {
    for (const line of result.stdout.split("\n").filter(Boolean)) {
      migrationLog(line);
    }
  }

  if (result.stderr) {
    for (const line of result.stderr.split("\n").filter(Boolean)) {
      migrationLog(line);
    }
  }

  if (result.status !== 0) {
    errorLog("Migration", result.stderr?.trim() || `exited with code ${String(result.status)}`);
    process.exit(1);
  }

  successLog("Migration", `completed in ${Date.now() - start}ms`);
}

async function runSeedPhase(): Promise<void> {
  if (!shouldSeed()) {
    seedLog("Seed skipped (production environment)");
    return;
  }

  seedLog("Starting database seed...");
  const start = Date.now();

  try {
    const { runSeed } = await import("./seed");
    await runSeed();
    successLog("Seed", `completed in ${Date.now() - start}ms`);
  } catch (err) {
    errorLog("Seed", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

async function startServer(): Promise<void> {
  appLog("Starting application server...");
  await import("./server");
}

async function main(): Promise<void> {
  await ensureDatabaseUrl();
  await runMigration();
  await runSeedPhase();
  await startServer();
}

main().catch((err) => {
  errorLog("Entrypoint", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
