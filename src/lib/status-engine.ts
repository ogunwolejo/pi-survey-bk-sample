import {
  QuoteStatus,
  OrderStatus,
  JobStatus,
  InvoiceStatus,
  PaymentStatus,
} from "@prisma/client";

type EntityType = "quote" | "order" | "job" | "invoice" | "payment";

type StatusEnumMap = {
  quote: QuoteStatus;
  order: OrderStatus;
  job: JobStatus;
  invoice: InvoiceStatus;
  payment: PaymentStatus;
};

const QUOTE_TRANSITIONS: Record<QuoteStatus, QuoteStatus[]> = {
  [QuoteStatus.draft]: [QuoteStatus.new],
  [QuoteStatus.new]: [QuoteStatus.pending_review, QuoteStatus.expired],
  [QuoteStatus.pending_review]: [QuoteStatus.quoted, QuoteStatus.sent, QuoteStatus.expired],
  [QuoteStatus.quoted]: [QuoteStatus.sent, QuoteStatus.pending_review],
  [QuoteStatus.sent]: [QuoteStatus.accepted, QuoteStatus.declined, QuoteStatus.expired],
  [QuoteStatus.accepted]: [],
  [QuoteStatus.declined]: [],
  [QuoteStatus.expired]: [],
};

const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  [OrderStatus.draft]: [OrderStatus.new],
  [OrderStatus.new]: [OrderStatus.pending_review],
  [OrderStatus.pending_review]: [OrderStatus.pending_contract, OrderStatus.research_queued],
  [OrderStatus.pending_contract]: [OrderStatus.pending_payment, OrderStatus.research_queued],
  [OrderStatus.pending_payment]: [OrderStatus.research_queued],
  [OrderStatus.research_queued]: [OrderStatus.research_in_progress],
  [OrderStatus.research_in_progress]: [OrderStatus.research_complete],
  [OrderStatus.research_complete]: [OrderStatus.ready_for_field],
  [OrderStatus.ready_for_field]: [],
};

const JOB_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  [JobStatus.unassigned]: [JobStatus.assigned],
  [JobStatus.assigned]: [JobStatus.assigned, JobStatus.in_progress, JobStatus.unassigned],
  [JobStatus.in_progress]: [JobStatus.field_complete],
  [JobStatus.field_complete]: [JobStatus.ready_for_drafting],
  [JobStatus.ready_for_drafting]: [JobStatus.drafting],
  [JobStatus.drafting]: [JobStatus.drafted],
  [JobStatus.drafted]: [JobStatus.pls_review],
  [JobStatus.pls_review]: [JobStatus.ready_for_delivery, JobStatus.awaiting_corrections],
  [JobStatus.awaiting_corrections]: [JobStatus.drafting],
  [JobStatus.ready_for_delivery]: [JobStatus.complete],
  [JobStatus.complete]: [],
};

const INVOICE_TRANSITIONS: Record<InvoiceStatus, InvoiceStatus[]> = {
  [InvoiceStatus.draft]: [InvoiceStatus.sent, InvoiceStatus.cancelled],
  [InvoiceStatus.sent]: [InvoiceStatus.paid, InvoiceStatus.partial, InvoiceStatus.overdue, InvoiceStatus.cancelled],
  [InvoiceStatus.paid]: [InvoiceStatus.refunded],
  [InvoiceStatus.partial]: [InvoiceStatus.paid, InvoiceStatus.overdue],
  [InvoiceStatus.overdue]: [InvoiceStatus.paid, InvoiceStatus.partial],
  [InvoiceStatus.cancelled]: [],
  [InvoiceStatus.refunded]: [],
};

const PAYMENT_TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  [PaymentStatus.pending]: [PaymentStatus.completed, PaymentStatus.failed, PaymentStatus.voided],
  [PaymentStatus.completed]: [PaymentStatus.refunded, PaymentStatus.voided],
  [PaymentStatus.failed]: [],
  [PaymentStatus.refunded]: [],
  [PaymentStatus.voided]: [],
};

const TRANSITIONS = {
  quote: QUOTE_TRANSITIONS,
  order: ORDER_TRANSITIONS,
  job: JOB_TRANSITIONS,
  invoice: INVOICE_TRANSITIONS,
  payment: PAYMENT_TRANSITIONS,
} as const;

export function canTransition<T extends EntityType>(
  type: T,
  from: StatusEnumMap[T],
  to: StatusEnumMap[T]
): boolean {
  const transitions = TRANSITIONS[type] as Record<StatusEnumMap[T], StatusEnumMap[T][]>;
  return transitions[from]?.includes(to) ?? false;
}

export function getValidTransitions<T extends EntityType>(
  type: T,
  from: StatusEnumMap[T]
): StatusEnumMap[T][] {
  const transitions = TRANSITIONS[type] as Record<StatusEnumMap[T], StatusEnumMap[T][]>;
  return transitions[from] ?? [];
}

export { QuoteStatus, OrderStatus, JobStatus, InvoiceStatus, PaymentStatus };
