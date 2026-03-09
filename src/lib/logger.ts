import { createLogger, transports, format, Logger } from "winston";
import { consoleFormat } from "winston-console-format";
import { format as dateFormat } from "date-fns";
import { getCorrelationId } from "../middleware/correlation.middleware";
import { envStore, AppEnv } from "../env-store";

const baseFileOptions = {
  handleExceptions: true,
  json: true,
  maxsize: 5_242_880, // 5 MB
  maxFiles: 5,
  colorize: false,
};

function fileOptions(component: string) {
  const dateDir = dateFormat(new Date(), "yyyy-MM-dd");
  return {
    combined: {
      ...baseFileOptions,
      level: "info",
      filename: `./logs/${component}/${dateDir}/app_log.log`,
    },
    error: {
      ...baseFileOptions,
      level: "error",
      filename: `./logs/${component}/${dateDir}/error_logs.log`,
    },
  };
}

function consoleOptions() {
  const isLocal =
    envStore.NODE_ENV === AppEnv.DEVELOPMENT || envStore.NODE_ENV === AppEnv.TEST;

  if (isLocal) {
    return {
      level: "debug",
      handleExceptions: true,
      format: format.combine(
        format.colorize({ all: true }),
        format.padLevels(),
        consoleFormat({
          showMeta: true,
          metaStrip: ["timestamp", "service"],
          inspectOptions: {
            depth: Infinity,
            colors: true,
            maxArrayLength: Infinity,
            breakLength: 120,
            compact: Infinity,
          },
        }),
      ),
    };
  }

  // Production / staging — plain JSON for CloudWatch ingestion
  return {
    level: "info",
    handleExceptions: true,
  };
}

function createModuleLogger(component: string): Logger {
  const isLocal =
    envStore.NODE_ENV === AppEnv.DEVELOPMENT || envStore.NODE_ENV === AppEnv.TEST;

  const correlationFormat = format((info) => {
    const correlationId = getCorrelationId();
    if (correlationId) {
      info.correlationId = correlationId;
    }
    return info;
  });

  return createLogger({
    level: "info",
    format: format.combine(
      format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
      format.errors({ stack: true }),
      format.splat(),
      correlationFormat(),
      format.json(),
    ),
    defaultMeta: { service: "pi-surveying-backend", component },
    transports: [
      new transports.Console(consoleOptions()),
      ...(isLocal
        ? []
        : [
            new transports.File(fileOptions(component).combined),
            new transports.File(fileOptions(component).error),
          ]),
    ],
    exitOnError: false,
  });
}

// ─── Module loggers (harris-water pattern) ──────────────────────────────────

export const generalLogger = createModuleLogger("GENERAL");
export const authLogger = createModuleLogger("AUTH");
export const quoteLogger = createModuleLogger("QUOTE");
export const orderLogger = createModuleLogger("ORDER");
export const jobLogger = createModuleLogger("JOB");
export const paymentLogger = createModuleLogger("PAYMENT");
export const emailLogger = createModuleLogger("EMAIL");
export const webhookLogger = createModuleLogger("WEBHOOK");
export const workerLogger = createModuleLogger("WORKER");
export const socketLogger = createModuleLogger("SOCKET");
export const contactLogger = createModuleLogger("CONTACT");
export const invoiceLogger = createModuleLogger("INVOICE");
export const fileLogger = createModuleLogger("FILE");
export const pipelineLogger = createModuleLogger("PIPELINE");
export const settingsLogger = createModuleLogger("SETTINGS");
export const chatLogger = createModuleLogger("CHAT");

// Backward-compatible default export
export const logger = generalLogger;
