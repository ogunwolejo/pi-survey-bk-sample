import { describe, it, expect } from "vitest";
import { haversineDistance } from "../haversine";

describe("haversineDistance", () => {
  it("returns ~195 mi for Austin→Dallas", () => {
    const d = haversineDistance(30.2672, -97.7431, 32.7767, -96.797);
    expect(d).not.toBeNull();
    expect(d!).toBeGreaterThan(180);
    expect(d!).toBeLessThan(210);
  });

  it("returns 0 for the same point", () => {
    const d = haversineDistance(30.0, -97.0, 30.0, -97.0);
    expect(d).toBe(0);
  });

  it("returns null when lat1 is null", () => {
    expect(haversineDistance(null, -97.0, 32.0, -96.0)).toBeNull();
  });

  it("returns null when lng1 is null", () => {
    expect(haversineDistance(30.0, null, 32.0, -96.0)).toBeNull();
  });

  it("returns null when lat2 is null", () => {
    expect(haversineDistance(30.0, -97.0, null, -96.0)).toBeNull();
  });

  it("returns null when lng2 is null", () => {
    expect(haversineDistance(30.0, -97.0, 32.0, null)).toBeNull();
  });

  it("returns null when all coordinates are undefined", () => {
    expect(haversineDistance(undefined, undefined, undefined, undefined)).toBeNull();
  });

  it("returns ~12,450 mi for antipodal points (0,0)→(0,180)", () => {
    const d = haversineDistance(0, 0, 0, 180);
    expect(d).not.toBeNull();
    expect(d!).toBeGreaterThan(12400);
    expect(d!).toBeLessThan(12500);
  });

  it("returns ~2,090 mi for New York→Miami", () => {
    const d = haversineDistance(40.7128, -74.006, 25.7617, -80.1918);
    expect(d).not.toBeNull();
    expect(d!).toBeGreaterThan(1000);
    expect(d!).toBeLessThan(1200);
  });

  it("handles small distances (<1 mi) accurately", () => {
    const d = haversineDistance(30.2672, -97.7431, 30.268, -97.744);
    expect(d).not.toBeNull();
    expect(d!).toBeGreaterThan(0);
    expect(d!).toBeLessThan(1);
  });
});
