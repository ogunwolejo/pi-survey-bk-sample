import { prisma } from "./prisma";
import { Prisma } from "@prisma/client";

type IsolationLevel = "ReadCommitted" | "RepeatableRead" | "Serializable";

export async function withTransaction<T>(
  fn: (tx: Omit<typeof prisma, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">) => Promise<T>,
  isolationLevel: IsolationLevel = "ReadCommitted"
): Promise<T> {
  const level = isolationLevel as Prisma.TransactionIsolationLevel;
  return prisma.$transaction(
    (tx) => fn(tx as Parameters<typeof fn>[0]),
    { isolationLevel: level, timeout: 15000 }
  );
}
