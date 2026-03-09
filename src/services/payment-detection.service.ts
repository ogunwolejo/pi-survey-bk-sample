export interface PaymentDetectionInput {
  /** Client-level customer type — used as legacy fallback for non-quote callers */
  customerType: string;
  /** Client-level payment terms — used for B2B established-terms logic */
  paymentTerms: string | null;
  quotePrice: number;
  /**
   * Quote-level customer type (QuoteCustomerType enum).
   * When provided (even as null), activates the new priority-based detection.
   * undefined = legacy caller → fall back to customerType
   * null = not set on the quote → check surveyType next
   */
  quoteCustomerType?: string | null;
  /**
   * Quote-level survey type (SurveyType enum).
   * Used as the secondary signal when quoteCustomerType is null.
   * undefined = legacy caller; null = not set on the quote
   */
  surveyType?: string | null;
}

export type DetectionSource =
  | "quote_customer_type"
  | "survey_type"
  | "client_customer_type"
  | "none";

export interface PaymentDetectionResult {
  paymentRequired: boolean;
  reason: string;
  paymentTerms: string;
  depositPercentage: number;
  depositAmount: number;
  /** True when neither quoteCustomerType nor surveyType is set and the UI should prompt the user */
  needsSelection: boolean;
  detectionSource: DetectionSource;
}

const ESTABLISHED_TERMS = new Set(["post_closing", "net_30", "net_60"]);
const HIGH_VALUE_THRESHOLD = 5000;

function buildResult(
  paymentRequired: boolean,
  terms: string,
  depositPercentage: number,
  quotePrice: number,
  reason: string,
  detectionSource: DetectionSource = "client_customer_type",
  needsSelection = false,
): PaymentDetectionResult {
  return {
    paymentRequired,
    paymentTerms: terms,
    depositPercentage,
    depositAmount: Math.round(quotePrice * (depositPercentage / 100) * 100) / 100,
    reason,
    needsSelection,
    detectionSource,
  };
}

// ─── QuoteCustomerType detection ──────────────────────────────────────────────

function detectFromQuoteCustomerType(
  quoteCustomerType: string,
  clientPaymentTerms: string | null,
  quotePrice: number,
): PaymentDetectionResult {
  const hasEstablishedTerms =
    clientPaymentTerms !== null && ESTABLISHED_TERMS.has(clientPaymentTerms);

  switch (quoteCustomerType) {
    case "individual_homeowner":
      return buildResult(true, "pre_pay", 100, quotePrice, "Homeowner — 100% upfront required", "quote_customer_type");

    case "attorney_law_office":
      if (hasEstablishedTerms && quotePrice >= HIGH_VALUE_THRESHOLD) {
        return buildResult(true, "fifty_fifty", 50, quotePrice, "Attorney — project $5,000+ — 50% deposit required", "quote_customer_type");
      }
      if (hasEstablishedTerms) {
        return buildResult(false, "post_closing", 0, quotePrice, "Established attorney — payment at closing", "quote_customer_type");
      }
      return buildResult(true, "fifty_fifty", 50, quotePrice, "Attorney — 50% deposit required", "quote_customer_type");

    case "title_company":
      if (hasEstablishedTerms && quotePrice >= HIGH_VALUE_THRESHOLD) {
        return buildResult(true, "fifty_fifty", 50, quotePrice, "Title company — project $5,000+ — 50% deposit required", "quote_customer_type");
      }
      if (hasEstablishedTerms) {
        return buildResult(false, "post_closing", 0, quotePrice, "Established title company — payment at closing", "quote_customer_type");
      }
      return buildResult(true, "fifty_fifty", 50, quotePrice, "Title company — 50% deposit required", "quote_customer_type");

    case "realtor":
      return buildResult(true, "fifty_fifty", 50, quotePrice, "Realtor — 50% deposit required", "quote_customer_type");

    case "engineering_construction":
      return buildResult(true, "fifty_fifty", 50, quotePrice, "Engineering/construction — 50% deposit required", "quote_customer_type");

    case "architecture_firm":
      return buildResult(true, "fifty_fifty", 50, quotePrice, "Architecture firm — 50% deposit required", "quote_customer_type");

    case "government_municipality":
      return buildResult(false, "post_closing", 0, quotePrice, "Government/municipality — payment at closing", "quote_customer_type");

    default:
      return buildResult(true, "fifty_fifty", 50, quotePrice, "Commercial client — 50% deposit required", "quote_customer_type");
  }
}

// ─── SurveyType detection ─────────────────────────────────────────────────────

function detectFromSurveyType(surveyType: string, quotePrice: number): PaymentDetectionResult {
  switch (surveyType) {
    case "alta":
      return buildResult(true, "fifty_fifty", 50, quotePrice, "ALTA survey — commercial client, 50% deposit required", "survey_type");
    case "condominium":
      return buildResult(true, "fifty_fifty", 50, quotePrice, "Condominium survey — 50% deposit required", "survey_type");
    case "topography":
      return buildResult(true, "fifty_fifty", 50, quotePrice, "Topography survey — 50% deposit required", "survey_type");
    case "boundary":
      return buildResult(true, "fifty_fifty", 50, quotePrice, "Boundary survey — 50% deposit required", "survey_type");
    default:
      return buildResult(true, "fifty_fifty", 50, quotePrice, "Survey — 50% deposit required", "survey_type");
  }
}

// ─── Legacy client-level detection ───────────────────────────────────────────

function detectFromClientCustomerType(
  customerType: string,
  paymentTerms: string | null,
  quotePrice: number,
): PaymentDetectionResult {
  if (customerType === "homeowner") {
    return buildResult(true, "pre_pay", 100, quotePrice, "Homeowner — 100% upfront required", "client_customer_type");
  }

  const hasEstablishedTerms = paymentTerms !== null && ESTABLISHED_TERMS.has(paymentTerms);

  if (hasEstablishedTerms && quotePrice >= HIGH_VALUE_THRESHOLD) {
    return buildResult(true, "fifty_fifty", 50, quotePrice, "Project value $5,000+ — 50% deposit required", "client_customer_type");
  }

  if (paymentTerms === null || paymentTerms === "pre_pay") {
    return buildResult(true, "fifty_fifty", 50, quotePrice, "New commercial client — 50% deposit required", "client_customer_type");
  }

  const B2B_CUSTOMER_TYPES = new Set(["attorney", "title_company"]);
  if (B2B_CUSTOMER_TYPES.has(customerType) && hasEstablishedTerms && quotePrice < HIGH_VALUE_THRESHOLD) {
    return buildResult(false, "post_closing", 0, quotePrice, "Established B2B client — payment at closing", "client_customer_type");
  }

  return buildResult(true, "pre_pay", 100, quotePrice, "Default — full payment required", "client_customer_type");
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export function detectPaymentRequirement(
  input: PaymentDetectionInput,
): PaymentDetectionResult {
  const { customerType, paymentTerms, quotePrice, quoteCustomerType, surveyType } = input;

  // New priority-based flow: activated when either new field is present (even as null)
  const isNewFlow = quoteCustomerType !== undefined || surveyType !== undefined;

  if (isNewFlow) {
    if (quoteCustomerType != null) {
      return detectFromQuoteCustomerType(quoteCustomerType, paymentTerms, quotePrice);
    }
    if (surveyType != null) {
      return detectFromSurveyType(surveyType, quotePrice);
    }
    // Neither is set — UI should prompt the user to select a customer type
    return {
      paymentRequired: true,
      paymentTerms: "pre_pay",
      depositPercentage: 100,
      depositAmount: quotePrice,
      reason: "Select customer type to auto-detect payment settings",
      needsSelection: true,
      detectionSource: "none",
    };
  }

  // Legacy fallback for proposal/quote-service callers
  return detectFromClientCustomerType(customerType, paymentTerms, quotePrice);
}

export function getPaymentDetectionReasoning(
  client: { customerType: string; paymentTerms: string | null },
  quotePrice: number,
): PaymentDetectionResult {
  return detectPaymentRequirement({
    customerType: client.customerType,
    paymentTerms: client.paymentTerms,
    quotePrice,
  });
}
