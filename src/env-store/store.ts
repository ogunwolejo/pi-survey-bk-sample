import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm";
import { AppEnv, DcsEnv, OPTIONAL_ENVS, type EnvStore } from "./types";

const envStore: EnvStore = {
  NODE_ENV: "",

  DATABASE_URL: "",
  REDIS_URL: "",

  DB_HOST: "",
  DB_PORT: "",
  DB_USERNAME: "",
  DB_PASSWORD: "",
  DB_NAME: "",

  REDIS_HOST: "localhost",
  REDIS_PORT: "6379",

  JWT_SECRET: "",
  JWT_EXPIRY: "",
  REFRESH_TOKEN_EXPIRY: "",

  AWS_S3_BUCKET: "",
  AWS_ACCESS_KEY_ID: "",
  AWS_SECRET_ACCESS_KEY: "",
  AWS_REGION: "",

  SENDGRID_API_KEY: "",
  SENDGRID_FROM_EMAIL: "",
  SENDGRID_FROM_NAME: "",
  SENDGRID_MAGIC_LINK_TEMPLATE_ID: "",
  SENDGRID_OTP_TEMPLATE_ID: "",

  CUSTOMERIO_SITE_ID: "",
  CUSTOMERIO_API_KEY: "",
  CUSTOMERIO_REGION: "US",

  QUICKBOOKS_CLIENT_ID: "",
  QUICKBOOKS_CLIENT_SECRET: "",
  QUICKBOOKS_REALM_ID: "",
  QUICKBOOKS_ENVIRONMENT: "",
  QUICKBOOKS_REDIRECT_URL: "",

  GOOGLE_MAPS_API_KEY: "",

  FRONTEND_URL: "",
  MOBILE_SCHEME: "",

  PORT: "3000",

  STAGING_TRAP_EMAIL: "",
  STAGING_TRAP_EXCLUDED_EMAILS: "",

  SENTRY_DSN: "",

  HOLLY_EMAIL: "",
  RESEARCH_LEADER_EMAIL: "",
  ALEX_EMAIL: "",
  VAPID_PUBLIC_KEY: "",
  VAPID_PRIVATE_KEY: "",
  VAPID_SUBJECT: "",
  QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN: "",
};

async function setEnvStoreFromSSM(): Promise<void> {
  let ssmPrefix = "/projects/pisurveying/dev";
  const dcsEnv = process.env.DCS_ENV;

  if (dcsEnv === DcsEnv.PROD) {
    ssmPrefix = "/projects/pisurveying/production";
  } else if (dcsEnv === DcsEnv.STAGING) {
    ssmPrefix = "/projects/pisurveying/staging";
  }

  const ssm = new SSMClient({ region: process.env.AWS_REGION || "us-east-1" });
  const allNames = Object.keys(envStore).map((k) => `${ssmPrefix}/${k}`);
  const batchCount = Math.ceil(allNames.length / 10);

  console.log(
    `[env-store] Loading ${allNames.length} parameters from SSM (prefix: ${ssmPrefix}, ${batchCount} batches)...`,
  );
  const ssmStart = Date.now();

  const fetchPromises: Promise<{ params: Array<{ name: string; value: string }> }>[] = [];
  for (let i = 0; i < allNames.length; i += 10) {
    const batch = allNames.slice(i, i + 10);
    fetchPromises.push(
      ssm
        .send(new GetParametersCommand({ Names: batch, WithDecryption: true }))
        .then((result) => ({
          params: (result.Parameters ?? [])
            .filter((p) => p.Name && p.Value)
            .map((p) => ({ name: p.Name!, value: p.Value! })),
        })),
    );
  }

  const results = await Promise.all(fetchPromises);
  const parsed: Record<string, string> = {};
  for (const r of results) {
    for (const p of r.params) {
      parsed[p.name.replace(`${ssmPrefix}/`, "")] = p.value;
    }
  }

  let loadedCount = 0;
  for (const k of Object.keys(envStore) as (keyof EnvStore)[]) {
    if (parsed[k]) {
      envStore[k] = parsed[k]!;
      loadedCount++;
    }
  }

  const ssmDuration = Date.now() - ssmStart;
  const loadedKeys = Object.keys(envStore).filter((k) => parsed[k]);
  const missingKeys = Object.keys(envStore).filter((k) => !parsed[k]);
  console.log(
    `[env-store] SSM loading complete — ${loadedCount}/${allNames.length} parameters loaded in ${ssmDuration}ms`,
  );
  console.log(`[env-store] SSM loaded: ${loadedKeys.join(", ") || "(none)"}`);
  if (missingKeys.length > 0) {
    console.warn(`[env-store] SSM missing (will use defaults/env): ${missingKeys.join(", ")}`);
  }
}

function setEnvStoreFromEnvironment(): void {
  for (const key of Object.keys(envStore) as (keyof EnvStore)[]) {
    const value = process.env[key];
    if (value !== undefined && value !== "") {
      envStore[key] = value;
    }
  }
}

function buildConnectionUrls(): void {
  const { DB_HOST, DB_PORT, DB_USERNAME, DB_PASSWORD, DB_NAME } = envStore;
  envStore.DATABASE_URL = `postgresql://${DB_USERNAME}:${encodeURIComponent(DB_PASSWORD)}@${DB_HOST}:${DB_PORT}/${DB_NAME}`;
  console.log(`[env-store] DATABASE_URL built from components (host: ${DB_HOST})`);
  
  //   if (!envStore.DATABASE_URL) {
  //   const { DB_HOST, DB_PORT, DB_USERNAME, DB_PASSWORD, DB_NAME } = envStore;
  //   envStore.DATABASE_URL = `postgresql://${DB_USERNAME}:${encodeURIComponent(DB_PASSWORD)}@${DB_HOST}:${DB_PORT}/${DB_NAME}`;
  //   console.log(`[env-store] DATABASE_URL built from components (host: ${DB_HOST})`);
  // }

  if (!envStore.REDIS_URL) {
    const { REDIS_HOST, REDIS_PORT } = envStore;
    envStore.REDIS_URL = `redis://${REDIS_HOST}:${REDIS_PORT}`;
    console.log(`[env-store] REDIS_URL built from components (host: ${REDIS_HOST})`);
  }
}

export async function configureEnv(): Promise<void> {
  const configStart = Date.now();
  const dcsEnv = process.env.DCS_ENV;

  console.log(
    `[env-store] Configuring environment (DCS_ENV=${dcsEnv ?? "unset"}, NODE_ENV=${process.env.NODE_ENV ?? "unset"})...`,
  );

  if (
    dcsEnv &&
    [DcsEnv.DEV, DcsEnv.STAGING, DcsEnv.PROD].includes(dcsEnv as DcsEnv)
  ) {
    await setEnvStoreFromSSM();
  } else {
    console.log("[env-store] Skipping SSM — no DCS_ENV set, using local environment");
  }

  if (process.env.NODE_ENV === AppEnv.TEST) {
    for (const key of Object.keys(envStore) as (keyof EnvStore)[]) {
      if (envStore[key] === "") {
        envStore[key] = "test";
      }
    }
  }

  setEnvStoreFromEnvironment();
  buildConnectionUrls();

  const missing = (Object.keys(envStore) as (keyof EnvStore)[]).filter(
    (key) => !OPTIONAL_ENVS.includes(key) && envStore[key] === "",
  );

  if (missing.length > 0) {
    console.error(
      `[env-store] Missing required environment variables: ${missing.join(", ")}`,
    );
    console.error(
      "[env-store] Copy .env.example to .env and fill in the values, or set them in your environment.",
    );
    process.exit(1);
  }

  const configDuration = Date.now() - configStart;
  console.log(`[env-store] Environment configuration complete in ${configDuration}ms`);
}

setEnvStoreFromEnvironment();
buildConnectionUrls();

export default envStore;
