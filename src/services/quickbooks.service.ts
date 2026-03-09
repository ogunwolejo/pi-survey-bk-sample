import QuickBooks from "quickbooks-node-promise";
import { getOrRefreshToken } from "../lib/quickbooks-auth";
import { prisma } from "../lib/prisma";
import { paymentLogger as logger } from "../lib/logger";
import { envStore } from "../env-store";
import type { QBCreateInvoiceParams, QBInvoice, QBCustomer } from "../types/quickbooks";

export async function getQBClient(): Promise<QuickBooks> {
  const { accessToken, refreshToken, realmId } = await getOrRefreshToken();

  return new QuickBooks(
    {
      appKey: envStore.QUICKBOOKS_CLIENT_ID,
      appSecret: envStore.QUICKBOOKS_CLIENT_SECRET,
      redirectUrl: envStore.QUICKBOOKS_REDIRECT_URL,
      accessToken,
      refreshToken,
      useProduction: envStore.QUICKBOOKS_ENVIRONMENT === "production",
      autoRefresh: false,
    },
    realmId,
  );
}

async function searchCustomerByEmail(
  qb: QuickBooks,
  email: string,
): Promise<QBCustomer | null> {
  const result = await qb.findCustomers({
    field: "PrimaryEmailAddr",
    value: email,
    operator: "=",
  });

  const customers = result.QueryResponse.Customer;
  if (!customers || customers.length === 0) return null;

  const match = customers[0];
  if (!match) return null;

  return {
    Id: match.Id,
    SyncToken: match.SyncToken,
    DisplayName: match.DisplayName,
    PrimaryEmailAddr: match.PrimaryEmailAddr
      ? { Address: match.PrimaryEmailAddr.Address }
      : undefined,
    GivenName: match.GivenName,
    FamilyName: match.FamilyName,
    CompanyName: match.CompanyName,
    Active: match.Active,
  };
}

async function updateLocalClient(email: string, qbCustomerId: string): Promise<void> {
  await prisma.client.updateMany({
    where: { email },
    data: { quickbooksCustomerId: qbCustomerId },
  });
}

export async function findOrCreateCustomer(
  email: string,
  displayName: string,
): Promise<string> {
  logger.info("Finding or creating QB customer", { email, displayName });
  const qb = await getQBClient();
  const existing = await searchCustomerByEmail(qb, email);

  if (existing) {
    logger.info("QB customer found", { qbCustomerId: existing.Id, email });
    await updateLocalClient(email, existing.Id);
    return existing.Id;
  }

  const created = await qb.createCustomer({
    DisplayName: displayName,
    PrimaryEmailAddr: { Address: email },
  });

  const qbCustomerId = created.Customer.Id;
  logger.info("QB customer created", { qbCustomerId, email });
  await updateLocalClient(email, qbCustomerId);
  return qbCustomerId;
}

function buildInvoiceLines(lineItems: QBCreateInvoiceParams["lineItems"]) {
  return lineItems.map((item) => ({
    Amount: item.amount * (item.quantity ?? 1),
    DetailType: "SalesItemLineDetail" as const,
    SalesItemLineDetail: {
      ItemRef: { value: "1", name: "Services" },
      Qty: item.quantity ?? 1,
      UnitPrice: item.amount,
    },
    Description: item.description,
  }));
}

export async function createInvoice(params: QBCreateInvoiceParams): Promise<QBInvoice> {
  logger.info("Creating QB invoice", { customerRef: params.customerRef, lineItemCount: params.lineItems.length });
  const qb = await getQBClient();

  const invoiceData = {
    CustomerRef: { value: params.customerRef },
    BillEmail: { Address: params.billEmail },
    Line: buildInvoiceLines(params.lineItems),
    AllowOnlineCreditCardPayment: params.allowCreditCard,
    AllowOnlineACHPayment: params.allowACH,
    ...(params.docNumber ? { DocNumber: params.docNumber } : {}),
    ...(params.dueDate ? { DueDate: params.dueDate } : {}),
  };

  const result = await qb.createInvoice(invoiceData);
  const inv = result.Invoice;
  logger.info("QB invoice created", { invoiceId: inv.Id });

  return mapInvoiceResult(inv);
}

function mapInvoiceResult(inv: {
  Id: string;
  SyncToken: string;
  DocNumber?: string;
  TxnDate: string;
  DueDate: string;
  TotalAmt: number;
  Balance: number;
  CustomerRef: { value: string; name?: string };
  BillEmail?: { Address: string };
  Line: { Amount: number; DetailType: string; Description?: string }[];
  AllowOnlineCreditCardPayment?: boolean;
  AllowOnlineACHPayment?: boolean;
}): QBInvoice {
  return {
    Id: inv.Id,
    SyncToken: inv.SyncToken,
    DocNumber: inv.DocNumber,
    TxnDate: inv.TxnDate,
    DueDate: inv.DueDate,
    TotalAmt: inv.TotalAmt,
    Balance: inv.Balance,
    CustomerRef: { value: inv.CustomerRef.value, name: inv.CustomerRef.name },
    BillEmail: inv.BillEmail ? { Address: inv.BillEmail.Address } : undefined,
    Line: inv.Line.map((l) => ({
      Amount: l.Amount,
      DetailType: l.DetailType as "SalesItemLineDetail" | "SubTotalLineDetail",
      Description: l.Description,
    })),
    AllowOnlineCreditCardPayment: inv.AllowOnlineCreditCardPayment,
    AllowOnlineACHPayment: inv.AllowOnlineACHPayment,
  };
}

export async function sendInvoice(invoiceId: string, email: string): Promise<void> {
  logger.info("Sending QB invoice via email", { invoiceId, email });
  const qb = await getQBClient();
  await qb.sendInvoicePdf(invoiceId, email);
  logger.info("QB invoice email sent", { invoiceId, email });
}

function getPaymentBaseUrl(): string {
  const isProduction = envStore.QUICKBOOKS_ENVIRONMENT === "production";
  return isProduction
    ? "https://app.qbo.intuit.com/app/pay"
    : "https://app.sandbox.qbo.intuit.com/app/pay";
}

export async function getInvoicePaymentUrl(invoiceId: string): Promise<string> {
  const realmId = envStore.QUICKBOOKS_REALM_ID;
  const paymentUrl = `${getPaymentBaseUrl()}?companyId=${realmId}&txnId=${invoiceId}`;
  logger.debug("QB payment URL generated", { invoiceId, paymentUrl });
  return paymentUrl;
}

export async function getInvoicePdf(invoiceId: string): Promise<Buffer> {
  logger.info("Fetching QB invoice PDF", { invoiceId });
  const qb = await getQBClient();
  const pdf = await qb.getInvoicePdf(invoiceId);
  return Buffer.from(pdf);
}
