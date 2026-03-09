import { prisma } from "../lib/prisma";
import { redis } from "../lib/redis";
import { JobStatus, RouteStatus, Team } from "@prisma/client";
import { pipelineLogger as logger } from "../lib/logger";
import { envStore } from "../env-store";
import sgMail from "@sendgrid/mail";
import { scheduleSiteAccessEmail, cancelSiteAccessEmail, rescheduleSiteAccessEmails } from "./site-access.service";
import { routePublishedNotificationHtml, routeCancelledNotificationHtml, routeUpdatedNotificationHtml } from "./email-templates";
import { haversineDistance } from "../lib/haversine";
import { getRouteNotificationQueue, type RouteNotificationPayload } from "../workers/route-notification.worker";
import { batchGeocode, buildAddressString } from "../lib/geocode";

const DIRECTIONS_CACHE_TTL = 15 * 60; // 15 minutes

interface LatLng {
  lat: number;
  lng: number;
}

interface DirectionsLeg {
  durationSeconds: number;
  distanceMeters: number;
}

interface DirectionsResult {
  totalDriveTimeMinutes: number;
  totalDistanceMeters: number;
  polyline: string | null;
  legs: DirectionsLeg[];
}

async function fetchGoogleDirections(
  waypoints: LatLng[]
): Promise<DirectionsResult | null> {
  if (waypoints.length < 2) return null;

  const apiKey = envStore.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    logger.warn("GOOGLE_MAPS_API_KEY not configured — skipping directions calculation");
    return null;
  }

  const origin = waypoints[0]!;
  const destination = waypoints[waypoints.length - 1]!;
  const intermediates = waypoints.slice(1, -1);

  const url = new URL("https://routes.googleapis.com/directions/v2:computeRoutes");
  const body = {
    origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
    destination: { location: { latLng: { latitude: destination.lat, longitude: destination.lng } } },
    intermediates: intermediates.map((w) => ({
      location: { latLng: { latitude: w.lat, longitude: w.lng } },
    })),
    travelMode: "DRIVE",
    routingPreference: "TRAFFIC_AWARE",
    computeAlternativeRoutes: false,
    polylineQuality: "OVERVIEW",
  };

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "routes.duration,routes.distanceMeters,routes.polyline,routes.legs",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    logger.warn("Google Routes API error", { status: response.status });
    return null;
  }

  const data = (await response.json()) as {
    routes?: Array<{
      duration?: string;
      distanceMeters?: number;
      polyline?: { encodedPolyline?: string };
      legs?: Array<{ duration?: string; distanceMeters?: number }>;
    }>;
  };

  const route = data.routes?.[0];
  if (!route) return null;

  const totalDriveTimeMinutes = route.duration
    ? Math.ceil(parseInt(route.duration.replace("s", ""), 10) / 60)
    : 0;

  const legs: DirectionsLeg[] = (route.legs ?? []).map((leg) => ({
    durationSeconds: leg.duration ? parseInt(leg.duration.replace("s", ""), 10) : 0,
    distanceMeters: leg.distanceMeters ?? 0,
  }));

  return {
    totalDriveTimeMinutes,
    totalDistanceMeters: route.distanceMeters ?? 0,
    polyline: route.polyline?.encodedPolyline ?? null,
    legs,
  };
}

export interface DistanceMatrixEntry {
  jobId: string;
  distanceKm: number;
  durationMinutes: number;
}

const PAIR_CACHE_TTL = 30 * 60; // 30 min — longer than route-level cache since pairs are stable
const MATRIX_BATCH_SIZE = 25; // Google API maximum per request

function pairKey(origin: LatLng, dest: { lat: number; lng: number }): string {
  return `dp:${origin.lat.toFixed(5)},${origin.lng.toFixed(5)}>${dest.lat.toFixed(5)},${dest.lng.toFixed(5)}`;
}

function haversineFallback(
  origin: LatLng,
  destinations: Array<{ jobId: string; lat: number; lng: number }>
): DistanceMatrixEntry[] {
  return destinations.map((d) => {
    const miles = haversineDistance(origin.lat, origin.lng, d.lat, d.lng);
    return {
      jobId: d.jobId,
      distanceKm: miles != null ? Math.round(miles * 1.60934 * 10) / 10 : 0,
      durationMinutes: 0,
    };
  });
}

/**
 * Per-pair cached distance matrix.
 *
 * Strategy:
 *  1. Build Redis keys for every origin→dest pair
 *  2. MGET all at once — O(1) network round-trip
 *  3. Partition into cache-hits vs cache-misses
 *  4. Call Google only for misses (in batches of 25)
 *  5. MSET new results back into Redis
 *
 * Falls back to haversine if API key is missing or API fails.
 */
export async function fetchDistanceMatrix(
  origin: LatLng,
  destinations: Array<{ jobId: string; lat: number; lng: number }>
): Promise<DistanceMatrixEntry[]> {
  if (destinations.length === 0) return [];

  const apiKey = envStore.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    logger.warn("GOOGLE_MAPS_API_KEY not configured — using haversine fallback");
    return haversineFallback(origin, destinations);
  }

  // ── 1. Check per-pair cache with a single MGET ──────────────────────────────
  const keys = destinations.map((d) => pairKey(origin, d));
  const cachedValues = await redis.mget(...keys);

  const results: DistanceMatrixEntry[] = [];
  const uncached: Array<{ jobId: string; lat: number; lng: number; idx: number }> = [];

  for (let i = 0; i < destinations.length; i++) {
    const raw = cachedValues[i];
    if (raw) {
      try {
        results.push(JSON.parse(raw) as DistanceMatrixEntry);
        continue;
      } catch { /* corrupted entry — refetch */ }
    }
    uncached.push({ ...destinations[i]!, idx: i });
  }

  if (uncached.length === 0) {
    logger.debug("Distance matrix served entirely from cache", { hitCount: results.length });
    return results;
  }

  logger.debug("Distance matrix cache stats", {
    total: destinations.length,
    hits: destinations.length - uncached.length,
    misses: uncached.length,
  });

  // ── 2. Fetch uncached pairs in batches of MATRIX_BATCH_SIZE ─────────────────
  try {
    for (let start = 0; start < uncached.length; start += MATRIX_BATCH_SIZE) {
      const batch = uncached.slice(start, start + MATRIX_BATCH_SIZE);
      const batchResults = await fetchMatrixBatch(apiKey, origin, batch);

      // ── 3. Write new pairs into Redis pipeline (single round-trip) ────────
      if (batchResults.length > 0) {
        const pipeline = redis.pipeline();
        for (const entry of batchResults) {
          const dest = batch.find((b) => b.jobId === entry.jobId);
          if (dest) {
            pipeline.setex(pairKey(origin, dest), PAIR_CACHE_TTL, JSON.stringify(entry));
          }
          results.push(entry);
        }
        await pipeline.exec();
      }
    }
  } catch (err) {
    logger.warn("Google distance matrix failed — filling misses with haversine", { error: err });
    const fallback = haversineFallback(
      origin,
      uncached.map(({ jobId, lat, lng }) => ({ jobId, lat, lng }))
    );
    results.push(...fallback);
  }

  return results;
}

async function fetchMatrixBatch(
  apiKey: string,
  origin: LatLng,
  batch: Array<{ jobId: string; lat: number; lng: number }>
): Promise<DistanceMatrixEntry[]> {
  const url = "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix";
  const body = {
    origins: [
      { waypoint: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } } },
    ],
    destinations: batch.map((d) => ({
      waypoint: { location: { latLng: { latitude: d.lat, longitude: d.lng } } },
    })),
    travelMode: "DRIVE",
    routingPreference: "TRAFFIC_AWARE",
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "originIndex,destinationIndex,duration,distanceMeters,status",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    logger.warn("Google Route Matrix API error", { status: response.status, batch: batch.length });
    return haversineFallback(origin, batch);
  }

  const data = (await response.json()) as Array<{
    originIndex?: number;
    destinationIndex?: number;
    duration?: string;
    distanceMeters?: number;
    status?: { code?: number };
  }>;

  const entries: DistanceMatrixEntry[] = [];
  const resolved = new Set<number>();

  for (const element of data) {
    const destIdx = element.destinationIndex;
    if (destIdx == null || destIdx >= batch.length) continue;
    if (element.status?.code && element.status.code !== 0) continue;

    const dest = batch[destIdx]!;
    const distanceKm = (element.distanceMeters ?? 0) / 1000;
    const durationSeconds = element.duration
      ? parseInt(element.duration.replace("s", ""), 10)
      : 0;

    entries.push({
      jobId: dest.jobId,
      distanceKm: Math.round(distanceKm * 10) / 10,
      durationMinutes: Math.ceil(durationSeconds / 60),
    });
    resolved.add(destIdx);
  }

  // Fill any destinations the API didn't return (partial failure) with haversine
  for (let i = 0; i < batch.length; i++) {
    if (resolved.has(i)) continue;
    const d = batch[i]!;
    const miles = haversineDistance(origin.lat, origin.lng, d.lat, d.lng);
    entries.push({
      jobId: d.jobId,
      distanceKm: miles != null ? Math.round(miles * 1.60934 * 10) / 10 : 0,
      durationMinutes: 0,
    });
  }

  return entries;
}

export async function getPendingJobs(team?: Team) {
  return prisma.job.findMany({
    where: {
      deletedAt: null,
      ...(team ? { team } : {}),
      OR: [
        { status: JobStatus.unassigned },
        {
          status: JobStatus.assigned,
          routeJobs: { none: {} },
        },
      ],
    },
    select: {
      id: true,
      jobNumber: true,
      status: true,
      propertyLat: true,
      propertyLng: true,
      internalDueDate: true,
      fieldDate: true,
      stakingRequired: true,
      specialNotes: true,
      isAlta: true,
      team: true,
      complexityTag: true,
      assignedCrew: { select: { id: true, name: true } },
      order: {
        select: {
          propertyAddressLine1: true,
          propertyAddressLine2: true,
          propertyCity: true,
          propertyState: true,
          propertyZip: true,
          surveyType: true,
          orderNumber: true,
        },
      },
    },
    orderBy: { internalDueDate: "asc" },
  });
}

// ─── Route Builder Service Functions ─────────────────────────────────────────

export async function getCalendarCounts(
  crewId: string,
  monthStart: Date,
  monthEnd: Date
): Promise<Record<string, number>> {
  const rows = await prisma.$queryRaw<Array<{ date: string; count: number }>>`
    SELECT j.field_date::text as date, COUNT(*)::int as count
    FROM jobs j
    WHERE j.assigned_crew_id = ${crewId}
      AND j.status = 'assigned'
      AND j.field_date IS NOT NULL
      AND j.field_date >= ${monthStart}
      AND j.field_date <= ${monthEnd}
      AND j.deleted_at IS NULL
      AND j.id NOT IN (
        SELECT rj.job_id FROM route_jobs rj
        INNER JOIN routes r ON rj.route_id = r.id
        WHERE r.status IN ('draft', 'published')
      )
    GROUP BY j.field_date
    ORDER BY j.field_date
  `;

  const result: Record<string, number> = {};
  for (const row of rows) {
    result[row.date] = row.count;
  }
  return result;
}

export async function getAvailableJobs(
  crewId: string,
  date: Date,
  refLat?: number,
  refLng?: number,
  excludeRouteId?: string
) {
  const jobs = await prisma.job.findMany({
    where: {
      assignedCrewId: crewId,
      fieldDate: date,
      status: JobStatus.assigned,
      deletedAt: null,
      routeJobs: {
        none: {
          route: {
            status: { in: [RouteStatus.draft, RouteStatus.published] },
            ...(excludeRouteId ? { id: { not: excludeRouteId } } : {}),
          },
        },
      },
    },
    select: {
      id: true,
      jobNumber: true,
      status: true,
      propertyLat: true,
      propertyLng: true,
      fieldDate: true,
      stakingRequired: true,
      isAlta: true,
      specialNotes: true,
      complexityTag: true,
      assignedCrew: { select: { id: true, name: true } },
      order: {
        select: {
          propertyAddressLine1: true,
          propertyAddressLine2: true,
          propertyCity: true,
          propertyState: true,
          propertyZip: true,
          surveyType: true,
          orderNumber: true,
        },
      },
    },
    orderBy: { jobNumber: "asc" },
  });

  // ── Geocode jobs missing coordinates ──────────────────────────────────────
  // Build a Map<address, jobId[]> so multiple jobs at the same address share
  // one geocode call, and an index Map<jobId, address> for the reverse lookup.
  const missingCoords: Array<{ jobId: string; address: string }> = [];
  for (const job of jobs) {
    if (job.propertyLat != null && job.propertyLng != null) continue;
    const addr = buildAddressString({
      line1: job.order?.propertyAddressLine1,
      city: job.order?.propertyCity,
      state: job.order?.propertyState,
      zip: job.order?.propertyZip,
    });
    if (addr) missingCoords.push({ jobId: job.id, address: addr });
  }

  // O(1) lookup of geocoded coords by jobId
  const geocodedByJobId = new Map<string, { lat: number; lng: number }>();

  if (missingCoords.length > 0) {
    const uniqueAddresses = [...new Set(missingCoords.map((m) => m.address))];
    const geocodeMap = await batchGeocode(uniqueAddresses);

    for (const { jobId, address } of missingCoords) {
      const coords = geocodeMap.get(address);
      if (coords) geocodedByJobId.set(jobId, coords);
    }

    // Persist geocoded coordinates back to DB in a single transaction
    // (fire-and-forget so it doesn't block the response)
    if (geocodedByJobId.size > 0) {
      const entries = [...geocodedByJobId.entries()];
      prisma.$transaction(
        entries.map(([id, { lat, lng }]) =>
          prisma.job.update({ where: { id }, data: { propertyLat: lat, propertyLng: lng } })
        )
      ).catch((err) =>
        logger.warn("Failed to persist geocoded coords", { error: err })
      );
    }
  }

  // ── Build response with resolved coordinates ──────────────────────────────
  const withDistance = jobs.map((job) => {
    const geo = geocodedByJobId.get(job.id);
    const jobLat = job.propertyLat ? Number(job.propertyLat) : geo?.lat ?? null;
    const jobLng = job.propertyLng ? Number(job.propertyLng) : geo?.lng ?? null;

    const distanceMiles =
      refLat != null && refLng != null
        ? haversineDistance(refLat, refLng, jobLat, jobLng)
        : null;

    return {
      ...job,
      propertyLat: jobLat,
      propertyLng: jobLng,
      distanceMiles,
    };
  });

  if (refLat != null && refLng != null) {
    withDistance.sort((a, b) => {
      if (a.distanceMiles == null && b.distanceMiles == null) return 0;
      if (a.distanceMiles == null) return 1;
      if (b.distanceMiles == null) return -1;
      return a.distanceMiles - b.distanceMiles;
    });
  } else {
    withDistance.sort((a, b) => {
      const addrA = a.order?.propertyAddressLine1 ?? "";
      const addrB = b.order?.propertyAddressLine1 ?? "";
      return addrA.localeCompare(addrB);
    });
  }

  return withDistance;
}

export async function checkDoubleBooking(
  jobIds: string[]
): Promise<Array<{ jobId: string; existingRouteId: string }>> {
  if (jobIds.length === 0) return [];

  const conflicts = await prisma.routeJob.findMany({
    where: {
      jobId: { in: jobIds },
      route: {
        status: { in: [RouteStatus.draft, RouteStatus.published] },
      },
    },
    select: {
      jobId: true,
      routeId: true,
    },
  });

  return conflicts.map((c) => ({ jobId: c.jobId, existingRouteId: c.routeId }));
}

export async function createRoute(routeDate: Date, crewId: string, jobIds: string[], createdBy: string) {
  logger.info("Creating route", { routeDate, crewId, jobCount: jobIds.length, createdBy });
  return prisma.route.create({
    data: {
      routeDate,
      crewId,
      createdBy,
      routeJobs: {
        create: jobIds.map((jobId, index) => ({ jobId, sortOrder: index })),
      },
    },
    include: {
      crew: { select: { id: true, name: true, crewNumber: true } },
      routeJobs: { orderBy: { sortOrder: "asc" } },
    },
  });
}

export async function calculateDirections(routeId: string): Promise<DirectionsResult | null> {
  logger.info("Calculating route directions", { routeId });
  const cacheKey = `directions:${routeId}`;
  const cached = await redis.get(cacheKey);
  if (cached) {
    try {
      return JSON.parse(cached) as DirectionsResult;
    } catch {
      // ignore
    }
  }

  const route = await prisma.route.findUnique({
    where: { id: routeId },
    include: {
      routeJobs: {
        orderBy: { sortOrder: "asc" },
        include: {
          job: { select: { propertyLat: true, propertyLng: true } },
        },
      },
    },
  });

  if (!route) return null;

  const waypoints: LatLng[] = route.routeJobs
    .map((rj) => {
      const lat = rj.job.propertyLat ? Number(rj.job.propertyLat) : null;
      const lng = rj.job.propertyLng ? Number(rj.job.propertyLng) : null;
      if (lat === null || lng === null) return null;
      return { lat, lng };
    })
    .filter((w): w is LatLng => w !== null);

  if (waypoints.length < 2) return null;

  const result = await fetchGoogleDirections(waypoints);
  if (!result) return null;

  // Persist totals back to the route
  await prisma.route.update({
    where: { id: routeId },
    data: {
      totalDriveTimeMinutes: result.totalDriveTimeMinutes,
      totalDistanceMeters: result.totalDistanceMeters,
      directionsPolyline: result.polyline,
    },
  });

  // Update per-leg times on each RouteJob
  for (let i = 0; i < Math.min(route.routeJobs.length, result.legs.length); i++) {
    const rj = route.routeJobs[i]!;
    const leg = result.legs[i]!;
    await prisma.routeJob.update({
      where: { id: rj.id },
      data: {
        legDriveTimeMinutes: Math.ceil(leg.durationSeconds / 60),
        legDistanceMeters: leg.distanceMeters,
      },
    });
  }

  // Cache result
  await redis.setex(cacheKey, DIRECTIONS_CACHE_TTL, JSON.stringify(result));

  return result;
}

// ─── Route Notification Scheduling ───────────────────────────────────────────

export async function scheduleRouteNotification(routeId: string): Promise<void> {
  const route = await prisma.route.findUnique({
    where: { id: routeId },
    include: {
      crew: { select: { name: true, members: { select: { email: true } } } },
      routeJobs: {
        orderBy: { sortOrder: "asc" },
        include: {
          job: {
            select: {
              jobNumber: true,
              order: { select: { propertyAddressLine1: true, propertyCity: true, propertyState: true } },
            },
          },
        },
      },
    },
  });
  if (!route) return;

  const queue = getRouteNotificationQueue();
  const jobIdKey = `route-notify:${routeId}`;

  const routeDateStr = route.routeDate.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  // 24 hours before 8:00 AM CT on the route date
  const targetDate = new Date(route.routeDate);
  targetDate.setHours(8, 0, 0, 0); // 8 AM local
  const sendAt = new Date(targetDate.getTime() - 24 * 60 * 60 * 1000);
  const delay = Math.max(0, sendAt.getTime() - Date.now());

  const payload: RouteNotificationPayload = {
    routeId,
    crewName: route.crew?.name ?? "Team",
    routeDate: routeDateStr,
    jobs: route.routeJobs.map((rj) => ({
      jobNumber: rj.job.jobNumber,
      address: rj.job.order
        ? `${rj.job.order.propertyAddressLine1}, ${rj.job.order.propertyCity}, ${rj.job.order.propertyState}`
        : "No address",
    })),
    estimatedDriveTime: route.totalDriveTimeMinutes,
    recipientEmails: route.crew?.members.map((m) => m.email) ?? [],
  };

  await queue.add("send-crew-notification", payload, {
    delay,
    jobId: jobIdKey,
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
  });

  await prisma.route.update({
    where: { id: routeId },
    data: { notificationJobId: jobIdKey },
  });

  logger.info("Route notification scheduled", { routeId, delay, jobIdKey });
}

export async function cancelRouteNotification(routeId: string): Promise<void> {
  const route = await prisma.route.findUnique({
    where: { id: routeId },
    select: { notificationJobId: true },
  });

  if (!route?.notificationJobId) return;

  const queue = getRouteNotificationQueue();
  try {
    const job = await queue.getJob(route.notificationJobId);
    if (job) {
      await job.remove();
    }
  } catch (err) {
    logger.warn("Failed to remove route notification job", { routeId, error: err });
  }

  await prisma.route.update({
    where: { id: routeId },
    data: { notificationJobId: null },
  });

  logger.info("Route notification cancelled", { routeId });
}

export async function publishRoute(routeId: string, publishedById: string) {
  logger.info("Publishing route", { routeId, publishedById });
  const route = await prisma.route.findUnique({
    where: { id: routeId },
    include: {
      routeJobs: {
        select: {
          id: true,
          jobId: true,
          siteContactName: true,
          siteContactEmail: true,
          siteContactPhone: true,
          job: {
            select: {
              jobNumber: true,
              order: { select: { propertyAddressLine1: true, propertyCity: true, propertyState: true } },
            },
          },
        },
      },
      crew: { select: { id: true, name: true, members: { select: { id: true, email: true, name: true } } } },
    },
  });
  if (!route) throw new Error("Route not found");
  if (route.status !== RouteStatus.draft) throw new Error(`Route is already ${route.status}`);

  const updated = await prisma.$transaction(async (tx) => {
    const r = await tx.route.update({
      where: { id: routeId },
      data: { status: RouteStatus.published, publishedAt: new Date(), publishedById },
    });
    await tx.job.updateMany({
      where: { id: { in: route.routeJobs.map((rj) => rj.jobId) } },
      data: { assignedCrewId: route.crewId, status: JobStatus.assigned },
    });
    return r;
  });

  // Send crew notification emails
  const crewUsers = route.crew?.members ?? [];
  const routeDateStr = route.routeDate.toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric",
  });
  const jobList = route.routeJobs.map((rj) => ({
    jobNumber: rj.job.jobNumber,
    address: rj.job.order
      ? `${rj.job.order.propertyAddressLine1}, ${rj.job.order.propertyCity}`
      : "No address",
  }));

  if (envStore.SENDGRID_API_KEY && crewUsers.length > 0) {
    sgMail.setApiKey(envStore.SENDGRID_API_KEY);
    const html = routePublishedNotificationHtml({
      crewName: route.crew?.name ?? "Team",
      routeDate: routeDateStr,
      jobs: jobList,
    });
    await sgMail.sendMultiple({
      to: crewUsers.map((u) => u.email),
      from: { email: envStore.SENDGRID_FROM_EMAIL ?? "noreply@pisurveying.com", name: "Pi Surveying" },
      subject: `Your Route is Ready — ${routeDateStr}`,
      html,
    }).catch((err) => logger.warn("Crew route email failed", { error: err }));
  }

  // Schedule site access emails for each RouteJob that has a site contact
  for (const rj of route.routeJobs) {
    if (!rj.siteContactEmail) continue;
    const propertyAddress = rj.job.order
      ? `${rj.job.order.propertyAddressLine1}, ${rj.job.order.propertyCity}, ${rj.job.order.propertyState}`
      : "Address on file";

    await scheduleSiteAccessEmail(rj.id, {
      routeJobId: rj.id,
      jobId: rj.jobId,
      jobNumber: rj.job.jobNumber,
      propertyAddress,
      fieldDate: route.routeDate.toISOString(),
      visitWindowStart: "8:00 AM",
      visitWindowEnd: "5:00 PM",
      siteContactName: rj.siteContactName ?? "Site Contact",
      siteContactEmail: rj.siteContactEmail,
      siteContactPhone: rj.siteContactPhone ?? undefined,
    }).catch((err) => logger.warn("Failed to schedule site access email", { error: err }));
  }

  // Schedule 24h-before reminder email via BullMQ
  await scheduleRouteNotification(routeId).catch((err) =>
    logger.warn("Failed to schedule route notification", { error: err })
  );

  return updated;
}

export async function cancelRoute(routeId: string, reason: string) {
  logger.info("Cancelling route", { routeId, reason });
  const route = await prisma.route.findUnique({
    where: { id: routeId },
    include: {
      routeJobs: { select: { id: true, jobId: true, siteContactEmail: true } },
      crew: { select: { name: true, members: { select: { email: true } } } },
    },
  });
  if (!route) throw new Error("Route not found");

  await prisma.$transaction(async (tx) => {
    await tx.route.update({
      where: { id: routeId },
      data: { status: RouteStatus.cancelled, cancelledAt: new Date(), cancelReason: reason },
    });
    await tx.job.updateMany({
      where: { id: { in: route.routeJobs.map((rj) => rj.jobId) } },
      data: { assignedCrewId: null, status: JobStatus.unassigned },
    });
  });

  // Cancel site access emails
  for (const rj of route.routeJobs) {
    if (rj.siteContactEmail) {
      await cancelSiteAccessEmail(rj.id).catch(() => null);
    }
  }

  // Notify crew
  const crewUsers = route.crew?.members ?? [];
  if (envStore.SENDGRID_API_KEY && crewUsers.length > 0) {
    sgMail.setApiKey(envStore.SENDGRID_API_KEY);
    const routeDateStr = route.routeDate.toLocaleDateString("en-US", {
      weekday: "long", month: "long", day: "numeric",
    });
    const html = routeCancelledNotificationHtml({
      crewName: route.crew?.name ?? "Team",
      routeDate: routeDateStr,
      reason,
    });
    await sgMail.sendMultiple({
      to: crewUsers.map((u) => u.email),
      from: { email: envStore.SENDGRID_FROM_EMAIL ?? "noreply@pisurveying.com", name: "Pi Surveying" },
      subject: `Route Cancelled — ${routeDateStr}`,
      html,
    }).catch((err) => logger.warn("Crew cancellation email failed", { error: err }));
  }

  // Cancel scheduled route notification
  await cancelRouteNotification(routeId).catch((err) =>
    logger.warn("Failed to cancel route notification", { error: err })
  );
}

export async function rescheduleRoute(routeId: string, newDate: Date, reason: string) {
  logger.info("Rescheduling route", { routeId, newDate, reason });
  const updated = await prisma.route.update({
    where: { id: routeId },
    data: { routeDate: newDate, cancelReason: reason, status: RouteStatus.draft },
  });

  // Reschedule site access emails for the new date
  await rescheduleSiteAccessEmails(routeId, newDate).catch((err) =>
    logger.warn("Failed to reschedule site access emails", { error: err })
  );

  // Reschedule route notification: cancel old, schedule new
  await cancelRouteNotification(routeId).catch(() => null);
  await scheduleRouteNotification(routeId).catch((err) =>
    logger.warn("Failed to reschedule route notification", { error: err })
  );

  return updated;
}

// ─── Published Route Editing ─────────────────────────────────────────────────

interface UpdatePublishedRouteParams {
  routeId: string;
  jobIds?: string[];
  siteContacts?: Array<{
    routeJobId: string;
    siteContactName?: string;
    siteContactEmail?: string;
    siteContactPhone?: string;
  }>;
}

/**
 * Edits a published route with full side-effect management.
 *
 * When the job list changes on a published route:
 *  1. Compute the delta (added / removed / retained jobs)
 *  2. Within a transaction:
 *     - Replace RouteJob rows
 *     - Mark added jobs as assigned to this crew
 *     - Mark removed jobs as unassigned
 *  3. Cancel site-access emails for removed jobs
 *  4. Schedule site-access emails for newly added jobs (if they have contacts)
 *  5. Invalidate directions cache
 *  6. Reschedule the crew reminder notification
 *  7. Send a "route updated" email to the crew
 */
export async function updatePublishedRoute(params: UpdatePublishedRouteParams) {
  const { routeId, jobIds, siteContacts } = params;

  const route = await prisma.route.findUnique({
    where: { id: routeId },
    include: {
      routeJobs: {
        orderBy: { sortOrder: "asc" },
        select: {
          id: true,
          jobId: true,
          siteContactEmail: true,
          siteContactName: true,
          siteContactPhone: true,
          job: {
            select: {
              jobNumber: true,
              order: { select: { propertyAddressLine1: true, propertyCity: true, propertyState: true } },
            },
          },
        },
      },
      crew: { select: { id: true, name: true, members: { select: { email: true } } } },
    },
  });
  if (!route) throw new Error("Route not found");

  const oldJobIds = new Set(route.routeJobs.map((rj) => rj.jobId));
  let jobsChanged = false;

  // ── 1. Update job list if provided ────────────────────────────────────────
  if (jobIds) {
    const newJobSet = new Set(jobIds);
    const addedJobIds = jobIds.filter((id) => !oldJobIds.has(id));
    const removedJobIds = [...oldJobIds].filter((id) => !newJobSet.has(id));
    jobsChanged = addedJobIds.length > 0 || removedJobIds.length > 0;

    // Double-booking check for newly added jobs
    if (addedJobIds.length > 0) {
      const conflicts = await checkDoubleBooking(addedJobIds);
      const realConflicts = conflicts.filter((c) => c.existingRouteId !== routeId);
      if (realConflicts.length > 0) {
        throw Object.assign(
          new Error("One or more jobs are already on an active route"),
          { code: "CONFLICT", details: realConflicts }
        );
      }
    }

    await prisma.$transaction(async (tx) => {
      // Replace RouteJob rows
      await tx.routeJob.deleteMany({ where: { routeId } });
      await tx.routeJob.createMany({
        data: jobIds.map((jobId, index) => ({ routeId, jobId, sortOrder: index })),
      });

      // Mark added jobs as assigned to this crew
      if (addedJobIds.length > 0) {
        await tx.job.updateMany({
          where: { id: { in: addedJobIds } },
          data: { assignedCrewId: route.crewId, status: JobStatus.assigned },
        });
      }

      // Mark removed jobs as unassigned
      if (removedJobIds.length > 0) {
        await tx.job.updateMany({
          where: { id: { in: removedJobIds } },
          data: { assignedCrewId: null, status: JobStatus.unassigned },
        });
      }
    });

    // Cancel site-access emails for removed RouteJobs
    for (const rj of route.routeJobs) {
      if (!newJobSet.has(rj.jobId) && rj.siteContactEmail) {
        await cancelSiteAccessEmail(rj.id).catch(() => null);
      }
    }

    // Schedule site-access emails for newly added jobs that inherit contacts
    // (Contacts will be set on the new RouteJob rows via siteContacts below or a follow-up call)

    logger.info("Published route jobs updated", {
      routeId,
      added: addedJobIds.length,
      removed: removedJobIds.length,
      total: jobIds.length,
    });
  }

  // ── 2. Update site contacts ───────────────────────────────────────────────
  if (siteContacts && siteContacts.length > 0) {
    for (const sc of siteContacts) {
      await prisma.routeJob.update({
        where: { id: sc.routeJobId },
        data: {
          siteContactName: sc.siteContactName,
          siteContactEmail: sc.siteContactEmail,
          siteContactPhone: sc.siteContactPhone,
        },
      });
    }
  }

  // ── 3. Post-edit side effects (only when jobs actually changed) ───────────
  if (jobsChanged) {
    // Invalidate directions cache
    await redis.del(`directions:${routeId}`);

    // Clear stale drive-time totals (will be recalculated on demand)
    await prisma.route.update({
      where: { id: routeId },
      data: {
        totalDriveTimeMinutes: null,
        totalDistanceMeters: null,
        directionsPolyline: null,
      },
    });

    // Reschedule crew reminder notification with updated job list
    await cancelRouteNotification(routeId).catch(() => null);
    await scheduleRouteNotification(routeId).catch((err) =>
      logger.warn("Failed to reschedule route notification after edit", { error: err })
    );

    // Notify crew of the change
    const crewUsers = route.crew?.members ?? [];
    if (envStore.SENDGRID_API_KEY && crewUsers.length > 0) {
      sgMail.setApiKey(envStore.SENDGRID_API_KEY);
      const routeDateStr = route.routeDate.toLocaleDateString("en-US", {
        weekday: "long", month: "long", day: "numeric",
      });
      const html = routeUpdatedNotificationHtml({
        crewName: route.crew?.name ?? "Team",
        routeDate: routeDateStr,
        changeDescription: `Route jobs have been updated (${jobIds?.length ?? 0} jobs in updated route).`,
        frontendUrl: `${envStore.FRONTEND_URL}/routes/${routeId}`,
      });
      await sgMail.sendMultiple({
        to: crewUsers.map((u) => u.email),
        from: { email: envStore.SENDGRID_FROM_EMAIL ?? "noreply@pisurveying.com", name: "Pi Surveying" },
        subject: `Route Updated — ${routeDateStr}`,
        html,
      }).catch((err) => logger.warn("Crew route-updated email failed", { error: err }));
    }
  }

  // Return the updated route
  return prisma.route.findUnique({
    where: { id: routeId },
    include: {
      crew: { select: { id: true, name: true, crewNumber: true } },
      routeJobs: { orderBy: { sortOrder: "asc" } },
    },
  });
}
