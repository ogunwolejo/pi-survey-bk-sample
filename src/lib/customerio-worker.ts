import { Worker, type Job } from "bullmq";
import { TrackClient, RegionUS } from "customerio-node";
import { getBullMQConnection } from "./bullmq-connection";
import { envStore } from "../env-store";
import { workerLogger as logger } from "./logger";

const QUEUE_NAME = "customerio-events";

interface IdentifyJob {
  type: "identify";
  contactId: string;
  attributes: Record<string, unknown>;
  enqueuedAt: string;
}

interface TrackJob {
  type: "track";
  contactId: string;
  eventName: string;
  attributes: Record<string, unknown>;
  enqueuedAt: string;
}

type CustomerIoJob = IdentifyJob | TrackJob;

let worker: Worker<CustomerIoJob> | null = null;
let cioClient: TrackClient | null = null;

function getClient(): TrackClient | null {
  if (cioClient) return cioClient;

  const siteId = envStore.CUSTOMERIO_SITE_ID;
  const apiKey = envStore.CUSTOMERIO_API_KEY;

  if (!siteId || !apiKey) {
    logger.warn("CustomerIO credentials not configured, worker will skip jobs");
    return null;
  }

  cioClient = new TrackClient(siteId, apiKey, { region: RegionUS });
  return cioClient;
}

async function processJob(job: Job<CustomerIoJob>): Promise<void> {
  const client = getClient();
  if (!client) {
    logger.debug("CustomerIO disabled, skipping job", { jobId: job.id });
    return;
  }

  const data = job.data;

  if (data.type === "identify") {
    await client.identify(data.contactId, data.attributes);
    logger.debug("CustomerIO identify sent", { contactId: data.contactId });
  } else if (data.type === "track") {
    await client.track(data.contactId, {
      name: data.eventName,
      data: data.attributes,
    });
    logger.debug("CustomerIO track sent", {
      contactId: data.contactId,
      eventName: data.eventName,
    });
  }
}

export function startCustomerIoWorker(): void {
  if (worker) return;

  worker = new Worker<CustomerIoJob>(QUEUE_NAME, processJob, {
    connection: getBullMQConnection(),
    concurrency: 5,
  });

  worker.on("failed", (job, err) => {
    logger.error("CustomerIO worker job failed", {
      jobId: job?.id,
      type: job?.data?.type,
      error: err.message,
    });
  });

  worker.on("error", (err) => {
    logger.error("CustomerIO worker error", { error: err.message });
  });

  logger.info("CustomerIO event worker started");
}
