export const STRUCTURES_CHECKLIST = [
  { value: "pool", label: "Pool" },
  { value: "walkway", label: "Walkway" },
  { value: "concrete_features", label: "Concrete Features" },
  { value: "garage", label: "Garage" },
  { value: "additional_buildings", label: "Additional Buildings" },
] as const;

export type StructureValue = (typeof STRUCTURES_CHECKLIST)[number]["value"];

export const COUNTY_PRICING: Record<string, number> = {
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
} as const;

export interface AltaTableAItem {
  id: string;
  label: string;
  description: string;
  hasSubItems?: boolean;
  subItems?: Array<{ id: string; label: string; description: string }>;
  hasFillIn?: boolean;
  fillInLabel?: string;
}

export const ALTA_TABLE_A_ITEMS: AltaTableAItem[] = [
  {
    id: "1",
    label: "Item 1",
    description:
      "Monuments placed (or reference monument/witness) at all major corners of the boundary",
  },
  {
    id: "2",
    label: "Item 2",
    description: "Address(es) of the surveyed property",
  },
  {
    id: "3",
    label: "Item 3",
    description:
      "Flood zone classification based on federal Flood Insurance Rate Maps (FIRM)",
  },
  {
    id: "4",
    label: "Item 4",
    description: "Gross land area (and other areas if specified by the client)",
  },
  {
    id: "5",
    label: "Item 5",
    description:
      "Vertical relief with source of information, contour interval, datum, and originating benchmark",
  },
  {
    id: "6",
    label: "Item 6 — Zoning",
    description: "Zoning classification and related information",
    hasSubItems: true,
    subItems: [
      {
        id: "6a",
        label: "Item 6(a)",
        description:
          "List zoning classification, setback requirements, height/floor space restrictions, and parking requirements on the plat/map",
      },
      {
        id: "6b",
        label: "Item 6(b)",
        description:
          "Graphically depict zoning setback requirements on the plat/map",
      },
    ],
  },
  {
    id: "7",
    label: "Item 7 — Building Dimensions",
    description: "Building dimensions and square footage",
    hasSubItems: true,
    subItems: [
      {
        id: "7a",
        label: "Item 7(a)",
        description: "Exterior dimensions of all buildings at ground level",
      },
      {
        id: "7b1",
        label: "Item 7(b)(1)",
        description:
          "Square footage of exterior footprint of all buildings at ground level",
      },
      {
        id: "7b2",
        label: "Item 7(b)(2)",
        description: "Square footage of other areas as specified by the client",
      },
      {
        id: "7c",
        label: "Item 7(c)",
        description:
          "Measured height of all buildings above grade at a client-specified location",
      },
    ],
  },
  {
    id: "8",
    label: "Item 8",
    description:
      "Substantial features observed during fieldwork (e.g., parking lots, billboards, signs, swimming pools, landscaped areas, refuse areas)",
  },
  {
    id: "9",
    label: "Item 9",
    description:
      "Parking spaces — number and type (disabled, motorcycle, regular, specialized) and striping",
  },
  {
    id: "10",
    label: "Item 10",
    description:
      "Division/party walls — determination of relationship and location with respect to adjoining properties",
  },
  {
    id: "11",
    label: "Item 11 — Underground Utilities",
    description: "Evidence of underground utilities",
    hasSubItems: true,
    subItems: [
      {
        id: "11a",
        label: "Item 11(a)",
        description:
          "Underground utilities as determined by plans and/or reports provided by client",
      },
      {
        id: "11b",
        label: "Item 11(b)",
        description:
          "Underground utilities as determined by markings coordinated by the surveyor (utility locate request)",
      },
    ],
  },
  {
    id: "12",
    label: "Item 12",
    description:
      "Governmental agency survey-related requirements (e.g., HUD surveys, BLM lease surveys) as specified by the client",
  },
  {
    id: "13",
    label: "Item 13",
    description: "Names of adjoining owners per current tax records",
  },
  {
    id: "14",
    label: "Item 14",
    description:
      "Distance to nearest intersecting street, as specified by the client",
  },
  {
    id: "15",
    label: "Item 15",
    description:
      "Rectified orthophotography, photogrammetric mapping, airborne/mobile laser scanning, or remote sensing",
  },
  {
    id: "16",
    label: "Item 16",
    description:
      "Evidence of recent earth moving work, building construction, or building additions observed during fieldwork",
  },
  {
    id: "17",
    label: "Item 17",
    description:
      "Proposed changes in street right-of-way lines and evidence of recent street/sidewalk construction or repairs",
  },
  {
    id: "18",
    label: "Item 18",
    description:
      "Offsite (appurtenant) easements — plottable offsite easements disclosed in documents as part of the survey",
  },
  {
    id: "19",
    label: "Item 19",
    description: "Professional liability insurance coverage",
    hasFillIn: true,
    fillInLabel: "Minimum insurance amount ($)",
  },
];
