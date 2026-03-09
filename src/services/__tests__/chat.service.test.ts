import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChatEntityType } from "@prisma/client";

vi.mock("../../lib/prisma", () => ({
  prisma: {
    chatMessage: {
      create: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      deleteMany: vi.fn(),
    },
    user: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    notification: {
      createMany: vi.fn(),
    },
  },
}));

vi.mock("../../lib/logger", () => ({
  chatLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../lib/socket-rooms", () => ({
  ROOM_PREFIXES: {
    USER: (id: string) => `user:${id}`,
    ENTITY_CHAT: (type: string, id: string) => `chat:${type}:${id}`,
  },
}));

vi.mock("../email.service", () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../email-templates", () => ({
  chatMentionPLSAssistantHtml: vi.fn().mockReturnValue("<html>mention</html>"),
}));

import { getMessages, postMessage, createSystemEvent, deleteByEntity } from "../chat.service";
import { prisma } from "../../lib/prisma";

const mockPrisma = vi.mocked(prisma, true);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getMessages", () => {
  it("returns messages in chronological order with pagination meta", async () => {
    const now = new Date();
    const messages = [
      { id: "m-2", content: "Second", createdAt: now, entityType: "order", entityId: "ord-1" },
      { id: "m-1", content: "First", createdAt: new Date(now.getTime() - 1000), entityType: "order", entityId: "ord-1" },
    ];
    mockPrisma.chatMessage.findMany.mockResolvedValue(messages as never);
    mockPrisma.chatMessage.count.mockResolvedValue(5);

    const result = await getMessages(ChatEntityType.order, "ord-1", 50);

    expect(mockPrisma.chatMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          entityType: ChatEntityType.order,
          entityId: "ord-1",
          deletedAt: null,
        }),
        orderBy: { createdAt: "desc" },
        take: 50,
      })
    );
    expect(result.data).toHaveLength(2);
    expect(result.data[0]!.id).toBe("m-1");
    expect(result.meta.total).toBe(5);
    expect(result.meta.limit).toBe(50);
  });

  it("applies 'before' cursor filter when provided", async () => {
    mockPrisma.chatMessage.findMany.mockResolvedValue([]);
    mockPrisma.chatMessage.count.mockResolvedValue(0);

    const before = "2026-02-01T00:00:00.000Z";
    await getMessages(ChatEntityType.quote, "q-1", 25, before);

    expect(mockPrisma.chatMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: { lt: new Date(before) },
        }),
      })
    );
  });

  it("sets hasMore to true when results equal limit and total exceeds limit", async () => {
    const msgs = Array.from({ length: 50 }, (_, i) => ({
      id: `m-${i}`,
      content: `Message ${i}`,
      createdAt: new Date(),
    }));
    mockPrisma.chatMessage.findMany.mockResolvedValue(msgs as never);
    mockPrisma.chatMessage.count.mockResolvedValue(100);

    const result = await getMessages(ChatEntityType.job, "job-1", 50);

    expect(result.meta.hasMore).toBe(true);
  });

  it("sets hasMore to false when results are less than limit", async () => {
    mockPrisma.chatMessage.findMany.mockResolvedValue([
      { id: "m-1", content: "Only one", createdAt: new Date() },
    ] as never);
    mockPrisma.chatMessage.count.mockResolvedValue(1);

    const result = await getMessages(ChatEntityType.order, "ord-1", 50);

    expect(result.meta.hasMore).toBe(false);
  });
});

describe("createSystemEvent", () => {
  it("creates a system event ChatMessage with isSystemEvent=true", async () => {
    const mockEntry = {
      id: "msg-1",
      entityType: ChatEntityType.order,
      entityId: "ord-1",
      authorId: "user-1",
      content: "Status changed to research_in_progress",
      isSystemEvent: true,
      eventType: "status_change",
      metadata: { from: "draft", to: "research_in_progress" },
      createdAt: new Date(),
      author: { id: "user-1", name: "Test User", role: "admin", image: null },
    };
    mockPrisma.chatMessage.create.mockResolvedValue(mockEntry as never);

    const result = await createSystemEvent({
      entityType: ChatEntityType.order,
      entityId: "ord-1",
      eventType: "status_change",
      content: "Status changed to research_in_progress",
      metadata: { from: "draft", to: "research_in_progress" },
      userId: "user-1",
    });

    expect(mockPrisma.chatMessage.create).toHaveBeenCalledWith({
      data: {
        entityType: ChatEntityType.order,
        entityId: "ord-1",
        authorId: "user-1",
        content: "Status changed to research_in_progress",
        isSystemEvent: true,
        eventType: "status_change",
        metadata: { from: "draft", to: "research_in_progress" },
        mentionedUserIds: [],
      },
      include: { author: { select: { id: true, name: true, role: true, image: true } } },
    });
    expect(result.id).toBe("msg-1");
    expect(result.isSystemEvent).toBe(true);
  });

  it("sets authorId to null when userId is not provided", async () => {
    mockPrisma.chatMessage.create.mockResolvedValue({
      id: "msg-2",
      authorId: null,
      isSystemEvent: true,
    } as never);

    await createSystemEvent({
      entityType: ChatEntityType.order,
      entityId: "ord-1",
      eventType: "auto_transition",
      content: "Auto-transitioned",
    });

    expect(mockPrisma.chatMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ authorId: null }),
      })
    );
  });

  it("emits chat:message:new via socket when io is provided", async () => {
    const mockEntry = { id: "msg-3", entityType: "order", entityId: "ord-1" };
    mockPrisma.chatMessage.create.mockResolvedValue(mockEntry as never);

    const mockTo = vi.fn().mockReturnValue({ emit: vi.fn() });
    const mockIo = { to: mockTo } as unknown as import("socket.io").Server;

    await createSystemEvent({
      entityType: ChatEntityType.order,
      entityId: "ord-1",
      eventType: "test",
      content: "Test event",
      io: mockIo,
    });

    expect(mockTo).toHaveBeenCalledWith("chat:order:ord-1");
    expect(mockTo("chat:order:ord-1").emit).toHaveBeenCalledWith("chat:message:new", mockEntry);
  });

  it("does not emit when io is undefined", async () => {
    mockPrisma.chatMessage.create.mockResolvedValue({ id: "msg-4" } as never);

    await createSystemEvent({
      entityType: ChatEntityType.quote,
      entityId: "q-1",
      eventType: "test",
      content: "No socket",
    });

    // No error thrown = success (no io to call)
  });

  it("creates events for all entity types", async () => {
    for (const entityType of [ChatEntityType.quote, ChatEntityType.order, ChatEntityType.job]) {
      mockPrisma.chatMessage.create.mockResolvedValue({
        id: `msg-${entityType}`,
        entityType,
      } as never);

      await createSystemEvent({
        entityType,
        entityId: `entity-${entityType}`,
        eventType: "status_change",
        content: `Event for ${entityType}`,
      });

      expect(mockPrisma.chatMessage.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ entityType }),
        })
      );
    }
  });

  it("omits metadata when not provided", async () => {
    mockPrisma.chatMessage.create.mockResolvedValue({ id: "msg-5" } as never);

    await createSystemEvent({
      entityType: ChatEntityType.order,
      entityId: "ord-1",
      eventType: "note",
      content: "No metadata",
    });

    expect(mockPrisma.chatMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ metadata: undefined }),
      })
    );
  });
});

describe("postMessage", () => {
  it("creates a user message with content and mentions", async () => {
    const mockMessage = {
      id: "msg-1",
      entityType: "order",
      entityId: "ord-1",
      authorId: "user-1",
      content: "Hello @Admin User",
      mentionedUserIds: ["user-2"],
      createdAt: new Date(),
      author: { id: "user-1", name: "Poster", role: "admin", image: null },
    };
    mockPrisma.chatMessage.create.mockResolvedValue(mockMessage as never);
    mockPrisma.user.findUnique.mockResolvedValue({ name: "Poster" } as never);
    mockPrisma.user.findMany.mockResolvedValue([
      { id: "user-2", name: "Admin User" },
    ] as never);
    mockPrisma.notification.createMany.mockResolvedValue({ count: 1 } as never);

    const result = await postMessage(
      ChatEntityType.order, "ord-1", "user-1", "Hello @Admin User", ["user-2"]
    );

    expect(mockPrisma.chatMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          entityType: ChatEntityType.order,
          entityId: "ord-1",
          authorId: "user-1",
          content: "Hello @Admin User",
          mentionedUserIds: ["user-2"],
        }),
      })
    );
    expect(result.id).toBe("msg-1");
  });

  it("creates notifications for mentioned users", async () => {
    mockPrisma.chatMessage.create.mockResolvedValue({
      id: "msg-1",
      content: "Hey @Bob",
    } as never);
    mockPrisma.user.findUnique.mockResolvedValue({ name: "Alice" } as never);
    mockPrisma.user.findMany.mockResolvedValue([
      { id: "user-bob", role: "crew_lead" },
    ] as never);
    mockPrisma.notification.createMany.mockResolvedValue({ count: 1 } as never);

    await postMessage(
      ChatEntityType.order, "ord-1", "user-alice", "Hey @Bob", ["user-bob"]
    );

    expect(mockPrisma.notification.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          userId: "user-bob",
          type: "chat_mention",
          title: "Alice mentioned you",
        }),
      ],
    });
  });

  it("filters out 'everyone' from mention processing — no notifications created", async () => {
    mockPrisma.chatMessage.create.mockResolvedValue({ id: "msg-1" } as never);
    mockPrisma.user.findUnique.mockResolvedValue({ name: "Poster" } as never);

    await postMessage(
      ChatEntityType.order, "ord-1", "user-1", "Hello @everyone", ["everyone"]
    );

    expect(mockPrisma.notification.createMany).not.toHaveBeenCalled();
  });

  it("emits chat:message:new to the entity chat room", async () => {
    const mockMessage = { id: "msg-1", content: "Test" };
    mockPrisma.chatMessage.create.mockResolvedValue(mockMessage as never);
    mockPrisma.user.findUnique.mockResolvedValue({ name: "Poster" } as never);

    const mockEmit = vi.fn();
    const mockTo = vi.fn().mockReturnValue({ emit: mockEmit });
    const mockIo = { to: mockTo } as unknown as import("socket.io").Server;

    await postMessage(
      ChatEntityType.order, "ord-1", "user-1", "Test", ["user-1"], mockIo
    );

    expect(mockTo).toHaveBeenCalledWith("chat:order:ord-1");
    expect(mockEmit).toHaveBeenCalledWith("chat:message:new", mockMessage);
  });

  it("skips notification creation when no mentions", async () => {
    mockPrisma.chatMessage.create.mockResolvedValue({ id: "msg-1" } as never);
    mockPrisma.user.findUnique.mockResolvedValue({ name: "Poster" } as never);

    await postMessage(
      ChatEntityType.order, "ord-1", "user-1", "No mentions here", []
    );

    expect(mockPrisma.notification.createMany).not.toHaveBeenCalled();
  });
});

describe("deleteByEntity", () => {
  it("deletes all messages for the given entity", async () => {
    mockPrisma.chatMessage.deleteMany.mockResolvedValue({ count: 5 } as never);

    const count = await deleteByEntity(ChatEntityType.order, "ord-1");

    expect(mockPrisma.chatMessage.deleteMany).toHaveBeenCalledWith({
      where: { entityType: ChatEntityType.order, entityId: "ord-1" },
    });
    expect(count).toBe(5);
  });

  it("returns 0 when no messages exist", async () => {
    mockPrisma.chatMessage.deleteMany.mockResolvedValue({ count: 0 } as never);

    const count = await deleteByEntity(ChatEntityType.quote, "q-999");
    expect(count).toBe(0);
  });
});
