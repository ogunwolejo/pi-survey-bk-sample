import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChatEntityType } from "@prisma/client";

const { mockGetMessages, mockPostMessage, mockCreateSystemEvent } = vi.hoisted(() => ({
  mockGetMessages: vi.fn(),
  mockPostMessage: vi.fn(),
  mockCreateSystemEvent: vi.fn(),
}));

vi.mock("../chat.service", () => ({
  getMessages: mockGetMessages,
  postMessage: mockPostMessage,
  createSystemEvent: mockCreateSystemEvent,
}));

vi.mock("../../lib/logger", () => ({
  orderLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  quoteLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  jobLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import * as orderActivity from "../order-activity.service";
import * as quoteActivity from "../quote-activity.service";
import * as jobActivity from "../job-activity.service";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("order-activity.service delegation", () => {
  it("getActivityFeed delegates to chat.getMessages with order entity type", async () => {
    mockGetMessages.mockResolvedValue({
      data: [{ id: "m-1" }],
      meta: { limit: 50, total: 1, hasMore: false, oldestCursor: null },
    });

    const result = await orderActivity.getActivityFeed("ord-1", 1, 50);

    expect(mockGetMessages).toHaveBeenCalledWith(ChatEntityType.order, "ord-1", 50);
    expect(result.data).toHaveLength(1);
    expect(result.total).toBe(1);
  });

  it("postMessage delegates to chat.postMessage with order entity type", async () => {
    const mockResult = { id: "msg-1", content: "Hello" };
    mockPostMessage.mockResolvedValue(mockResult);
    const mockIo = {} as import("socket.io").Server;

    const result = await orderActivity.postMessage("ord-1", "user-1", "Hello", ["user-2"], mockIo);

    expect(mockPostMessage).toHaveBeenCalledWith(
      ChatEntityType.order, "ord-1", "user-1", "Hello", ["user-2"], mockIo
    );
    expect(result).toEqual(mockResult);
  });

  it("createSystemEvent delegates to chat.createSystemEvent with order entity type", async () => {
    mockCreateSystemEvent.mockResolvedValue({ id: "sys-1" });
    const mockIo = {} as import("socket.io").Server;

    await orderActivity.createSystemEvent(
      "ord-1", "status_change", "Status changed", { from: "draft" }, "user-1", mockIo
    );

    expect(mockCreateSystemEvent).toHaveBeenCalledWith({
      entityType: ChatEntityType.order,
      entityId: "ord-1",
      eventType: "status_change",
      content: "Status changed",
      metadata: { from: "draft" },
      userId: "user-1",
      io: mockIo,
    });
  });

  it("createSystemEvent passes undefined userId and io correctly", async () => {
    mockCreateSystemEvent.mockResolvedValue({ id: "sys-2" });

    await orderActivity.createSystemEvent(
      "ord-1", "auto_transition", "Auto", undefined, undefined, undefined
    );

    expect(mockCreateSystemEvent).toHaveBeenCalledWith({
      entityType: ChatEntityType.order,
      entityId: "ord-1",
      eventType: "auto_transition",
      content: "Auto",
      metadata: undefined,
      userId: undefined,
      io: undefined,
    });
  });
});

describe("quote-activity.service delegation", () => {
  it("getActivityFeed delegates to chat.getMessages with quote entity type", async () => {
    mockGetMessages.mockResolvedValue({
      data: [{ id: "m-1" }],
      meta: { limit: 25, total: 3, hasMore: false, oldestCursor: null },
    });

    const result = await quoteActivity.getActivityFeed("q-1", 1, 25);

    expect(mockGetMessages).toHaveBeenCalledWith(ChatEntityType.quote, "q-1", 25);
    expect(result.data).toHaveLength(1);
    expect(result.total).toBe(3);
  });

  it("postMessage delegates to chat.postMessage with quote entity type", async () => {
    mockPostMessage.mockResolvedValue({ id: "msg-1" });

    await quoteActivity.postMessage("q-1", "user-1", "Note", [], undefined);

    expect(mockPostMessage).toHaveBeenCalledWith(
      ChatEntityType.quote, "q-1", "user-1", "Note", [], undefined
    );
  });

  it("createSystemEvent delegates to chat.createSystemEvent with quote entity type", async () => {
    mockCreateSystemEvent.mockResolvedValue({ id: "sys-1" });

    await quoteActivity.createSystemEvent(
      "q-1", "price_generated", "Price set to $1500", { price: 1500 }, "user-1", undefined
    );

    expect(mockCreateSystemEvent).toHaveBeenCalledWith({
      entityType: ChatEntityType.quote,
      entityId: "q-1",
      eventType: "price_generated",
      content: "Price set to $1500",
      metadata: { price: 1500 },
      userId: "user-1",
      io: undefined,
    });
  });
});

describe("job-activity.service delegation", () => {
  it("getActivityFeed delegates to chat.getMessages with job entity type", async () => {
    mockGetMessages.mockResolvedValue({
      data: [{ id: "m-1" }, { id: "m-2" }],
      meta: { limit: 50, total: 2, hasMore: false, oldestCursor: null },
    });

    const result = await jobActivity.getActivityFeed("job-1", 1, 50);

    expect(mockGetMessages).toHaveBeenCalledWith(ChatEntityType.job, "job-1", 50);
    expect(result.data).toHaveLength(2);
    expect(result.total).toBe(2);
  });

  it("postActivityMessage delegates to chat.postMessage with job entity type", async () => {
    mockPostMessage.mockResolvedValue({ id: "msg-1" });
    const mockIo = {} as import("socket.io").Server;

    await jobActivity.postActivityMessage("job-1", "user-1", "Field note", ["user-2"], mockIo);

    expect(mockPostMessage).toHaveBeenCalledWith(
      ChatEntityType.job, "job-1", "user-1", "Field note", ["user-2"], mockIo
    );
  });

  it("createSystemEvent delegates to chat.createSystemEvent with job entity type", async () => {
    mockCreateSystemEvent.mockResolvedValue({ id: "sys-1" });

    await jobActivity.createSystemEvent(
      "job-1", "status_change", "Status changed to assigned",
      { from: "unassigned", to: "assigned" }, "user-1", undefined
    );

    expect(mockCreateSystemEvent).toHaveBeenCalledWith({
      entityType: ChatEntityType.job,
      entityId: "job-1",
      eventType: "status_change",
      content: "Status changed to assigned",
      metadata: { from: "unassigned", to: "assigned" },
      userId: "user-1",
      io: undefined,
    });
  });
});
