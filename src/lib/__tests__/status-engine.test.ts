import { describe, it, expect } from "vitest";
import { canTransition, getValidTransitions } from "../status-engine";

describe("canTransition", () => {
  describe("quote transitions", () => {
    it("allows new → pending_review", () => {
      expect(canTransition("quote", "new", "pending_review")).toBe(true);
    });

    it("allows sent → accepted", () => {
      expect(canTransition("quote", "sent", "accepted")).toBe(true);
    });

    it("rejects accepted → new (backward transition)", () => {
      expect(canTransition("quote", "accepted", "new")).toBe(false);
    });

    it("rejects new → accepted (skipping states)", () => {
      expect(canTransition("quote", "new", "accepted")).toBe(false);
    });

    it("returns false for unknown status", () => {
      expect(canTransition("quote", "nonexistent", "sent")).toBe(false);
    });
  });

  describe("order transitions", () => {
    it("allows draft → pending_contract", () => {
      expect(canTransition("order", "draft", "pending_contract")).toBe(true);
    });

    it("allows research_complete → ready_for_field", () => {
      expect(canTransition("order", "research_complete", "ready_for_field")).toBe(true);
    });

    it("rejects ready_for_field → draft", () => {
      expect(canTransition("order", "ready_for_field", "draft")).toBe(false);
    });
  });

  describe("job transitions", () => {
    it("allows unassigned → assigned", () => {
      expect(canTransition("job", "unassigned", "assigned")).toBe(true);
    });

    it("allows pls_review → drafting (revision cycle)", () => {
      expect(canTransition("job", "pls_review", "drafting")).toBe(true);
    });

    it("allows pls_review → complete", () => {
      expect(canTransition("job", "pls_review", "complete")).toBe(true);
    });

    it("rejects complete → in_progress", () => {
      expect(canTransition("job", "complete", "in_progress")).toBe(false);
    });
  });

  describe("invoice transitions", () => {
    it("allows draft → sent", () => {
      expect(canTransition("invoice", "draft", "sent")).toBe(true);
    });

    it("allows sent → paid", () => {
      expect(canTransition("invoice", "sent", "paid")).toBe(true);
    });

    it("allows paid → refunded", () => {
      expect(canTransition("invoice", "paid", "refunded")).toBe(true);
    });

    it("rejects cancelled → sent", () => {
      expect(canTransition("invoice", "cancelled", "sent")).toBe(false);
    });

    it("rejects refunded → paid", () => {
      expect(canTransition("invoice", "refunded", "paid")).toBe(false);
    });
  });
});

describe("getValidTransitions", () => {
  it("returns valid next states for quote: new", () => {
    expect(getValidTransitions("quote", "new")).toEqual(["pending_review", "expired"]);
  });

  it("returns empty array for terminal quote state: accepted", () => {
    expect(getValidTransitions("quote", "accepted")).toEqual([]);
  });

  it("returns empty array for terminal quote state: declined", () => {
    expect(getValidTransitions("quote", "declined")).toEqual([]);
  });

  it("returns empty array for terminal quote state: expired", () => {
    expect(getValidTransitions("quote", "expired")).toEqual([]);
  });

  it("returns valid next states for order: draft", () => {
    expect(getValidTransitions("order", "draft")).toEqual(["pending_contract", "pending_payment"]);
  });

  it("returns empty array for terminal order state: ready_for_field", () => {
    expect(getValidTransitions("order", "ready_for_field")).toEqual([]);
  });

  it("returns valid next states for job: pls_review", () => {
    expect(getValidTransitions("job", "pls_review")).toEqual(["drafting", "complete"]);
  });

  it("returns empty array for terminal job state: complete", () => {
    expect(getValidTransitions("job", "complete")).toEqual([]);
  });

  it("returns valid next states for invoice: sent", () => {
    expect(getValidTransitions("invoice", "sent")).toEqual(["paid", "partial", "overdue", "cancelled"]);
  });

  it("returns empty array for terminal invoice states", () => {
    expect(getValidTransitions("invoice", "cancelled")).toEqual([]);
    expect(getValidTransitions("invoice", "refunded")).toEqual([]);
  });

  it("returns empty array for unknown state", () => {
    expect(getValidTransitions("quote", "nonexistent")).toEqual([]);
  });
});
