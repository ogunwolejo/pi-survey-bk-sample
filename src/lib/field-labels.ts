/**
 * Human-readable field names and enum value labels.
 * Used by audit logs, activity feed, and any user-facing change summaries.
 */

const FIELD_LABELS: Record<string, string> = {
  lotSizeAcres: "Lot Size (Acres)",
  lotShape: "Lot Shape",
  drivewayType: "Driveway Type",
  waterFeatures: "Water Features",
  vegetationDensity: "Vegetation Density",
  subdivisionStatus: "Subdivision Status",
  structuresOnProperty: "Structures on Property",
  structuresOther: "Structures — Other Notes",
  accessIssues: "Access Issues",
  status: "Status",
  price: "Price",
  surveyType: "Survey Type",
  propertyType: "Property Type",
  customerType: "Customer Type",
  propertyCounty: "County",
  propertyAddressLine1: "Property Address Line 1",
  propertyAddressLine2: "Property Address Line 2",
  propertyCity: "City",
  propertyState: "State",
  propertyZip: "ZIP Code",
  pin: "PIN",
  additionalPins: "Additional PINs",
  closingDate: "Closing Date",
  onsiteContactFirstName: "Onsite Contact First Name",
  onsiteContactLastName: "Onsite Contact Last Name",
  onsiteContactPhone: "Onsite Contact Phone",
  lockedGates: "Locked Gates",
  deliveryPreference: "Delivery Preference",
  legalDescription: "Legal Description",
  estimatedTimeframe: "Estimated Timeframe",
  priority: "Priority",
  team: "Team",
  referralSource: "Referral Source",
  paymentTerms: "Payment Terms",
  billingAddressSameAsService: "Billing Same as Service",
  billingAddressLine1: "Billing Address Line 1",
  billingAddressLine2: "Billing Address Line 2",
  billingCity: "Billing City",
  billingState: "Billing State",
  billingZip: "Billing ZIP",
  internalNotes: "Internal Notes",
  rushFeeApplied: "Rush Fee Applied",
  rushFeeWaived: "Rush Fee Waived",
  rushFeeAmount: "Rush Fee Amount",
  altaTableASelections: "ALTA Table A Selections",
  preferenceFormSentAt: "Preference Form Sent",
  preferenceFormReceivedAt: "Preference Form Received",
  crossTeamRequested: "Cross-Team Quote Requested",
};

const ENUM_VALUE_LABELS: Record<string, Record<string, string>> = {
  lotShape: {
    regular_rectangular: "Regular / Rectangular",
    irregular: "Irregular",
    many_sided: "Many-Sided",
    curved_boundary: "Curved Boundary",
  },
  drivewayType: {
    standard_straight: "Standard / Straight",
    u_shaped_horseshoe: "U-Shaped / Horseshoe",
    long_curved: "Long / Curved",
    none: "None",
  },
  waterFeatures: {
    none: "None",
    pond_within_lot: "Pond Within Lot",
    boundary_water: "Boundary Water (River / Lake / Pond)",
  },
  vegetationDensity: {
    minimal: "Minimal",
    moderate: "Moderate",
    dense_obstructive: "Dense / Obstructive",
  },
  subdivisionStatus: {
    recorded_plat: "Recorded Plat (Lot & Block)",
    metes_and_bounds: "Metes & Bounds (Section Breakdown)",
  },
  status: {
    draft: "Draft",
    new: "New",
    pending_review: "Pending Review",
    quoted: "Quoted",
    sent: "Sent",
    accepted: "Accepted",
    declined: "Declined",
    expired: "Expired",
  },
  surveyType: {
    boundary: "Boundary Survey",
    alta: "ALTA/NSPS Land Title Survey",
    condominium: "Condominium Survey",
    topography: "Topographic Survey",
    other: "Other",
  },
  propertyType: {
    sfr: "Single Family Residence (Not Townhome)",
    sfr_townhome: "Single Family Residence (Townhome)",
    apartment: "Apartment (Multi-Unit) Building",
    commercial: "Commercial/Industrial Building",
    vacant_land: "Vacant Land",
    farm: "Farm",
    other: "Other",
  },
  customerType: {
    attorney_law_office: "Attorney/Law Office",
    individual_homeowner: "Individual/Homeowner",
    realtor: "Realtor",
    title_company: "Title Company",
    engineering_construction: "Engineering/Construction Firm",
    architecture_firm: "Architecture Firm",
    government_municipality: "Government/Municipality",
    other: "Other",
  },
  propertyCounty: {
    cook: "Cook",
    dupage: "DuPage",
    will: "Will",
    kane: "Kane",
    lake: "Lake",
    mchenry: "McHenry",
    kendall: "Kendall",
    dekalb: "DeKalb",
    kankakee: "Kankakee",
    iroquois: "Iroquois",
    lasalle: "LaSalle",
    grundy: "Grundy",
  },
  deliveryPreference: {
    pdf_only: "PDF Only (email delivery)",
    pdf_usps: "PDF + USPS Mail",
    pdf_fedex: "PDF + FedEx",
  },
  priority: {
    low: "Low",
    normal: "Normal",
    high: "High / Rush",
    urgent: "Urgent",
  },
  lockedGates: {
    yes: "Yes — property has locked gates",
    no: "No — no locked gates",
    na: "N/A",
  },
  paymentTerms: {
    pre_pay: "Pre-pay (full payment upfront)",
    fifty_fifty: "50/50 (half upfront, half on delivery)",
    full_with_discount: "Full with Discount",
    post_closing: "Post-Closing",
  },
  team: {
    residential: "Residential",
    public: "Public / Municipal",
  },
};

const STRUCTURE_LABELS: Record<string, string> = {
  pool: "Pool",
  walkway: "Walkway",
  concrete_features: "Concrete Features",
  garage: "Garage",
  additional_buildings: "Additional Buildings",
};

export function humanFieldName(field: string): string {
  return (
    FIELD_LABELS[field] ??
    field.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()).trim()
  );
}

export function humanValue(field: string, raw: unknown): string {
  if (raw === null || raw === undefined) return "—";
  if (typeof raw === "boolean") return raw ? "Yes" : "No";

  if (Array.isArray(raw)) {
    if (raw.length === 0) return "—";
    if (field === "structuresOnProperty") {
      return raw.map((v) => STRUCTURE_LABELS[String(v)] ?? String(v)).join(", ");
    }
    const map = ENUM_VALUE_LABELS[field];
    if (map) {
      return raw.map((v) => map[String(v)] ?? String(v)).join(", ");
    }
    return raw.join(", ");
  }

  const map = ENUM_VALUE_LABELS[field];
  if (map) {
    return map[String(raw)] ?? String(raw);
  }

  return String(raw);
}

export function humanizeChangeSummary(
  changes: Record<string, { old: unknown; new: unknown }>,
  prefix = "Updated",
): string {
  const fields = Object.keys(changes);
  if (fields.length === 0) return "No changes";

  const readableNames = fields.map(humanFieldName);

  if (fields.length === 1) {
    const f = fields[0]!;
    const c = changes[f]!;
    const oldLabel = humanValue(f, c.old);
    const newLabel = humanValue(f, c.new);
    return `${prefix} ${readableNames[0]}: ${oldLabel} → ${newLabel}`;
  }

  return `${prefix}: ${readableNames.join(", ")}`;
}
