import type { BillingNetwork, BillingToken } from './billing';

export type AdminUnmatchedStatus = 'open' | 'handled';

/** Admin-only view of a transfer that paid no invoice. Dates are ISO strings on the wire. */
export interface AdminUnmatchedTransfer<TDate = string> {
  id: string;
  status: AdminUnmatchedStatus;
  network: BillingNetwork;
  token: BillingToken;
  amount: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  /** Same abbreviated sender as the billing ledger logs; never an account identity lookup. */
  from: string;
  /** Unknown for older records, settlement repairs, or a failed optional timestamp lookup. */
  blockTime: TDate | null;
  detectedAt: TDate;
  reason: string;
  invoiceId: string | null;
  clerkId: string | null;
  handled: { at: TDate; by: string; note: string } | null;
}

/** `GET /api/admin/billing/unmatched?status=open|handled&cursor=`. */
export interface AdminUnmatchedListResponse<TDate = string> {
  transfers: AdminUnmatchedTransfer<TDate>[];
  /** Opaque cursor, newest detectedAt first, with id as the tie breaker. */
  nextCursor: string | null;
}

/** `POST /api/admin/billing/unmatched/:id/handle`; only the same admin and note replay successfully. */
export interface AdminHandleTransferRequest {
  note: string;
}

/** 409 when a transfer already has a different resolution; the caller's attempt is audited as failed. */
export interface AdminAlreadyHandledResponse {
  message: 'already_handled';
  details: {
    transferId: string;
    handledAt: string;
    handledBy: string | null;
    note: string | null;
  };
}
