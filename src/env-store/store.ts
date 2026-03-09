import { AppEnv, OPTIONAL_ENVS, type EnvStore } from "./types";

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

function setEnvStoreFromEnvironment(): void {
  for (const key of Object.keys(envStore) as (keyof EnvStore)[]) {
    const value = process.env[key];
    if (value !== undefined && value !== "") {
      envStore[key] = value;
    }
  }
}

function buildConnectionUrls(): void {
  // DATABASE_URL: use env var if set, otherwise build from components
  if (!envStore.DATABASE_URL) {
    const { DB_HOST, DB_PORT, DB_USERNAME, DB_PASSWORD, DB_NAME } = envStore;
    if (DB_HOST && DB_USERNAME && DB_PASSWORD && DB_NAME) {
      envStore.DATABASE_URL = `postgresql://${DB_USERNAME}:${encodeURIComponent(DB_PASSWORD)}@${DB_HOST}:${DB_PORT || "5432"}/${DB_NAME}`;
      console.log(`[env-store] DATABASE_URL built from components (host: ${DB_HOST})`);
    }
  } else {
    console.log(`[env-store] DATABASE_URL provided via environment`);
  }

  // REDIS_URL: use env var if set, otherwise build from components
  if (!envStore.REDIS_URL) {
    const { REDIS_HOST, REDIS_PORT } = envStore;
    envStore.REDIS_URL = `redis://${REDIS_HOST || "localhost"}:${REDIS_PORT || "6379"}`;
    console.log(`[env-store] REDIS_URL built from components (host: ${REDIS_HOST || "localhost"})`);
  } else {
    console.log(`[env-store] REDIS_URL provided via environment`);
  }
}

export async function configureEnv(): Promise<void> {
  const configStart = Date.now();

  console.log(
    `[env-store] Configuring environment (NODE_ENV=${process.env.NODE_ENV ?? "unset"})...`,
  );

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
