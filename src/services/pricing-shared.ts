import { prisma } from "../lib/prisma";
import { generalLogger as logger } from "../lib/logger";

const DEFAULT_RUSH_FEE = 100;

export async function getRushFeeSetting(): Promise<number> {
  const row = await prisma.systemSetting.findUnique({ where: { key: "rush_fee" } });
  if (row !== null && typeof row.value === "number") return row.value;
  return DEFAULT_RUSH_FEE;
}

export interface PriceLineItem {
  key: string;
  label: string;
  amount: number;
}

export interface PriceBreakdown {
  basePrice: number;
  lineItems: PriceLineItem[];
  rushFee: number;
  totalPrice: number;
}

export interface ManualPriceInput {
  basePrice: number;
  lineItems: PriceLineItem[];
  rushFee: number;
}

export const COUNTY_BASE_PRICES: Record<string, number> = {
  cook: 595,
  dupage: 595,
  lake: 595,
  will: 495,
  kane: 495,
  mchenry: 495,
  kendall: 495,
  dekalb: 495,
  kankakee: 495,
  iroquois: 495,
  lasalle: 495,
  grundy: 495,
};

export const DEFAULT_BASE_PRICE = 495;

export const LABEL_MAP: Record<string, string> = {
  irregular: "Irregular",
  many_sided: "Many-Sided",
  curved_boundary: "Curved Boundary",
  u_shaped_horseshoe: "U-Shaped / Horseshoe",
  long_curved: "Long / Curved",
  pond_within_lot: "Pond Within Lot",
  boundary_water: "Boundary Water",
  moderate: "Moderate",
  dense_obstructive: "Dense / Obstructive",
  metes_and_bounds: "Metes & Bounds",
};

export function buildDefaultLineItems(entity: {
  lotSizeAcres?: number | { toNumber(): number } | null;
  lotShape?: string | null;
  drivewayType?: string | null;
  waterFeatures?: string | null;
  vegetationDensity?: string | null;
  subdivisionStatus?: string | null;
  structuresOnProperty?: string[];
  accessIssues?: string | null;
}): PriceLineItem[] {
  const items: PriceLineItem[] = [];

  const acres = entity.lotSizeAcres ? Number(entity.lotSizeAcres) : null;
  if (acres && acres > 0) {
    items.push({ key: "lot_size", label: `Lot size (${acres} acres)`, amount: 0 });
  }

  if (entity.lotShape && entity.lotShape !== "regular_rectangular") {
    items.push({ key: "lot_shape", label: `Lot shape — ${LABEL_MAP[entity.lotShape] ?? entity.lotShape}`, amount: 0 });
  }

  if (entity.drivewayType && entity.drivewayType !== "standard_straight" && entity.drivewayType !== "none") {
    items.push({ key: "driveway", label: `Driveway — ${LABEL_MAP[entity.drivewayType] ?? entity.drivewayType}`, amount: 0 });
  }

  if (entity.waterFeatures && entity.waterFeatures !== "none") {
    items.push({ key: "water_features", label: `Water features — ${LABEL_MAP[entity.waterFeatures] ?? entity.waterFeatures}`, amount: 0 });
  }

  if (entity.vegetationDensity && entity.vegetationDensity !== "minimal") {
    items.push({ key: "vegetation", label: `Vegetation — ${LABEL_MAP[entity.vegetationDensity] ?? entity.vegetationDensity}`, amount: 0 });
  }

  if (entity.subdivisionStatus && entity.subdivisionStatus !== "recorded_plat") {
    items.push({ key: "subdivision", label: `Subdivision — ${LABEL_MAP[entity.subdivisionStatus] ?? entity.subdivisionStatus}`, amount: 0 });
  }

  if (entity.structuresOnProperty && entity.structuresOnProperty.length > 0) {
    items.push({ key: "structures", label: `Structures on property (${entity.structuresOnProperty.length})`, amount: 0 });
  }

  if (entity.accessIssues && entity.accessIssues.trim() !== "") {
    items.push({ key: "access_issues", label: "Access issues", amount: 0 });
  }

  return items;
}
