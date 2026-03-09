import { redis } from "./redis";
import { envStore } from "../env-store";
import { pipelineLogger as logger } from "./logger";
import crypto from "crypto";

export interface GeoCoords {
  lat: number;
  lng: number;
}

const CACHE_TTL = 30 * 24 * 60 * 60; // 30 days — addresses don't move
const MAX_CONCURRENT = 5;
const CACHE_PREFIX = "geo:addr:";

/**
 * Deterministic cache key from a normalized address string.
 * Normalisation: lowercase, collapse whitespace, strip trailing commas.
 * SHA-256 truncated to 16 hex chars keeps keys short while collision-safe.
 */
function cacheKey(raw: string): string {
  const normalized = raw
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/,\s*$/, "")
    .trim();
  const hash = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return `${CACHE_PREFIX}${hash}`;
}

/**
 * Geocode a single address via Google Geocoding API.
 * Returns null when the address can't be resolved.
 */
async function geocodeOne(address: string, apiKey: string): Promise<GeoCoords | null> {
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("address", address);
  url.searchParams.set("key", apiKey);

  const res = await fetch(url.toString());
  if (!res.ok) {
    logger.warn("Google Geocoding API HTTP error", { status: res.status, address });
    return null;
  }

  const data = (await res.json()) as {
    status: string;
    results?: Array<{
      geometry?: { location?: { lat: number; lng: number } };
    }>;
  };

  if (data.status !== "OK" || !data.results?.length) {
    logger.debug("Geocode returned no results", { status: data.status, address });
    return null;
  }

  const loc = data.results[0]?.geometry?.location;
  if (!loc) return null;

  return { lat: loc.lat, lng: loc.lng };
}

/**
 * Batch-geocode multiple addresses with:
 *  - Redis MGET for bulk cache lookup (single round-trip)
 *  - Bounded concurrency for API calls (semaphore pattern)
 *  - Redis pipeline for bulk cache writes
 *
 * Returns a Map<address, GeoCoords | null> for O(1) consumer lookups.
 */
export async function batchGeocode(
  addresses: string[]
): Promise<Map<string, GeoCoords | null>> {
  const results = new Map<string, GeoCoords | null>();
  if (addresses.length === 0) return results;

  const apiKey = envStore.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    logger.warn("GOOGLE_MAPS_API_KEY not configured — cannot geocode");
    for (const addr of addresses) results.set(addr, null);
    return results;
  }

  // De-duplicate addresses (same address from multiple jobs)
  const unique = [...new Set(addresses)];
  const keys = unique.map(cacheKey);

  // 1. Bulk cache lookup — single MGET round-trip
  const cached = await redis.mget(...keys);

  const uncached: Array<{ address: string; idx: number }> = [];
  for (let i = 0; i < unique.length; i++) {
    const raw = cached[i];
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as GeoCoords | null;
        results.set(unique[i]!, parsed);
        continue;
      } catch { /* corrupted — refetch */ }
    }
    uncached.push({ address: unique[i]!, idx: i });
  }

  if (uncached.length === 0) {
    logger.debug("All geocode results served from cache", { count: unique.length });
    return results;
  }

  logger.debug("Geocode cache stats", {
    total: unique.length,
    hits: unique.length - uncached.length,
    misses: uncached.length,
  });

  // 2. Fetch uncached with bounded concurrency (semaphore)
  let running = 0;
  const queue = [...uncached];
  const settled: Array<{ address: string; coords: GeoCoords | null }> = [];

  await new Promise<void>((resolve) => {
    function next() {
      if (settled.length === uncached.length) {
        resolve();
        return;
      }
      while (running < MAX_CONCURRENT && queue.length > 0) {
        const item = queue.shift()!;
        running++;
        geocodeOne(item.address, apiKey)
          .then((coords) => {
            settled.push({ address: item.address, coords });
            results.set(item.address, coords);
          })
          .catch(() => {
            settled.push({ address: item.address, coords: null });
            results.set(item.address, null);
          })
          .finally(() => {
            running--;
            next();
          });
      }
    }
    next();
  });

  // 3. Bulk cache write — single pipeline round-trip
  if (settled.length > 0) {
    const pipe = redis.pipeline();
    for (const { address, coords } of settled) {
      pipe.setex(cacheKey(address), CACHE_TTL, JSON.stringify(coords));
    }
    await pipe.exec();
  }

  return results;
}

/**
 * Build a full geocodable address string from component parts.
 * Returns null if the address is too incomplete to geocode.
 */
export function buildAddressString(parts: {
  line1?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}): string | null {
  const { line1, city, state } = parts;
  if (!line1 || !city) return null;
  const segments = [line1, city, state].filter(Boolean);
  return segments.join(", ");
}
