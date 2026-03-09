declare module "quickbooks-node-promise" {
  interface TokenResponse {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    x_refresh_token_expires_in?: number;
    token_type?: string;
    realmID?: number | string;
    access_expire_timestamp?: number | Date;
    refresh_expire_timestamp?: number | Date;
  }

  interface AppConfig {
    appKey?: string;
    appSecret?: string;
    redirectUrl?: string;
    accessToken?: string;
    refreshToken?: string;
    useProduction?: boolean | string;
    autoRefresh?: boolean;
    debug?: boolean | string;
    minorversion?: number | null;
  }

  interface QBRef {
    value: string;
    name?: string;
  }

  interface QBEmailAddr {
    Address: string;
  }

  interface QBCustomerResult {
    Id: string;
    SyncToken: string;
    DisplayName: string;
    PrimaryEmailAddr?: QBEmailAddr;
    GivenName?: string;
    FamilyName?: string;
    CompanyName?: string;
    Active: boolean;
  }

  interface QBInvoiceLineDetail {
    ItemRef: QBRef;
    Qty: number;
    UnitPrice: number;
  }

  interface QBInvoiceLine {
    Amount: number;
    DetailType: string;
    SalesItemLineDetail?: QBInvoiceLineDetail;
    Description?: string;
  }

  interface QBInvoiceResult {
    Id: string;
    SyncToken: string;
    DocNumber?: string;
    TxnDate: string;
    DueDate: string;
    TotalAmt: number;
    Balance: number;
    CustomerRef: QBRef;
    BillEmail?: QBEmailAddr;
    Line: QBInvoiceLine[];
    AllowOnlineCreditCardPayment?: boolean;
    AllowOnlineACHPayment?: boolean;
    EmailStatus?: string;
  }

  class QuickBooks {
    constructor(appConfig: AppConfig, realmID: string | number);

    refreshAcessTokenWithToken(refreshToken: string): Promise<TokenResponse>;
    refreshAccessToken(): Promise<TokenResponse>;

    findCustomers(criteria: {
      field: string;
      value: string;
      operator?: string;
    }): Promise<{
      QueryResponse: { Customer?: QBCustomerResult[] };
      time: string;
    }>;

    createCustomer(customer: {
      DisplayName: string;
      PrimaryEmailAddr?: QBEmailAddr;
      GivenName?: string;
      FamilyName?: string;
    }): Promise<{ Customer: QBCustomerResult; time: string }>;

    createInvoice(invoice: {
      CustomerRef: QBRef;
      BillEmail?: QBEmailAddr;
      Line: QBInvoiceLine[];
      AllowOnlineCreditCardPayment?: boolean;
      AllowOnlineACHPayment?: boolean;
      DocNumber?: string;
      DueDate?: string;
    }): Promise<{ Invoice: QBInvoiceResult; time: string }>;

    sendInvoicePdf(id: string, sendTo: string): Promise<void>;

    getInvoice(
      id: string,
    ): Promise<{ Invoice: QBInvoiceResult; time: string }>;

    getInvoicePdf(id: string): Promise<ArrayBuffer>;

    static createToken(
      appConfig: AppConfig,
      authCode: string,
      realmID: string | number,
    ): Promise<TokenResponse>;
  }

  export = QuickBooks;
}
