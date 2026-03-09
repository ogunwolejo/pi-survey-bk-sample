export interface QBCustomerRef {
  value: string;
  name?: string;
}

export interface QBEmailAddress {
  Address: string;
}

export interface QBInvoiceLine {
  Amount: number;
  DetailType: "SalesItemLineDetail" | "SubTotalLineDetail";
  SalesItemLineDetail?: {
    ItemRef: { value: string; name?: string };
    Qty: number;
    UnitPrice: number;
    TaxCodeRef?: { value: string };
  };
  Description?: string;
}

export interface QBInvoice {
  Id: string;
  SyncToken: string;
  DocNumber?: string;
  TxnDate: string;
  DueDate: string;
  TotalAmt: number;
  Balance: number;
  CustomerRef: QBCustomerRef;
  BillEmail?: QBEmailAddress;
  Line: QBInvoiceLine[];
  AllowOnlineCreditCardPayment?: boolean;
  AllowOnlineACHPayment?: boolean;
  EmailStatus?: "NotSet" | "NeedToSend" | "EmailSent";
  LinkedTxn?: { TxnType: string; TxnId: string }[];
  MetaData?: { CreateTime: string; LastUpdatedTime: string };
}

export interface QBPaymentLine {
  Amount: number;
  LinkedTxn?: { TxnId: string; TxnType: string }[];
}

export interface QBPayment {
  Id: string;
  SyncToken: string;
  TotalAmt: number;
  TxnDate: string;
  PaymentType?: string;
  PaymentMethodRef?: { value: string; name?: string };
  PaymentRefNum?: string;
  CustomerRef: QBCustomerRef;
  Line: QBPaymentLine[];
  UnappliedAmt?: number;
  ProcessPayment?: boolean;
  MetaData?: { CreateTime: string; LastUpdatedTime: string };
}

export interface QBCustomer {
  Id: string;
  SyncToken: string;
  DisplayName: string;
  PrimaryEmailAddr?: QBEmailAddress;
  GivenName?: string;
  FamilyName?: string;
  CompanyName?: string;
  Active: boolean;
}

export interface QBTokenData {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  x_refresh_token_expires_in: number;
  token_type: string;
}

export interface QBCreateInvoiceParams {
  customerRef: string;
  lineItems: { description: string; amount: number; quantity?: number }[];
  docNumber?: string;
  billEmail: string;
  allowCreditCard: boolean;
  allowACH: boolean;
  dueDate?: string;
}

export interface QBCreateCustomerParams {
  displayName: string;
  email: string;
  givenName?: string;
  familyName?: string;
}
