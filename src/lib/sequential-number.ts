import { prisma } from "./prisma";
import { withTransaction } from "./transaction";

type Prefix = "QUOTE" | "ORDER" | "JOB" | "INV" | "PAY";

function parseLastNum(value: string | null | undefined, prefix: string, year: string): number {
  if (!value?.startsWith(`${prefix}-${year}`)) return 0;
  const n = parseInt(value.slice(-4), 10);
  return Number.isNaN(n) ? 0 : n;
}

export async function getNextSequence(prefix: Prefix): Promise<string> {
  return withTransaction(async (tx) => {
    const year = new Date().getFullYear().toString().slice(-2);
    let lastNum = 0;
    if (prefix === "QUOTE") {
      const last = await tx.quote.findFirst({ orderBy: { createdAt: "desc" }, select: { quoteNumber: true } });
      lastNum = parseLastNum(last?.quoteNumber, prefix, year);
    } else if (prefix === "ORDER") {
      const last = await tx.order.findFirst({ orderBy: { createdAt: "desc" }, select: { orderNumber: true } });
      lastNum = parseLastNum(last?.orderNumber, prefix, year);
    } else if (prefix === "JOB") {
      const last = await tx.job.findFirst({ orderBy: { createdAt: "desc" }, select: { jobNumber: true } });
      lastNum = parseLastNum(last?.jobNumber, prefix, year);
    } else if (prefix === "INV") {
      const last = await tx.invoice.findFirst({ orderBy: { createdAt: "desc" }, select: { invoiceNumber: true } });
      lastNum = parseLastNum(last?.invoiceNumber, prefix, year);
    } else if (prefix === "PAY") {
      const last = await tx.payment.findFirst({ orderBy: { createdAt: "desc" }, select: { paymentNumber: true } });
      lastNum = parseLastNum(last?.paymentNumber, prefix, year);
    }
    return `${prefix}-${year}${(lastNum + 1).toString().padStart(4, "0")}`;
  }, "Serializable");
}
