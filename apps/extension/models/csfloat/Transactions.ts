export interface Transactions_csfloat {
  transactions: Transaction[];
  count: number;
}

export interface Transaction {
  id: string;
  created_at: string;
  user_id: string;
  type: string;
  details: Details;
  balance_offset: number;
  pending_offset: number;
}

export interface Details {
  contract_id?: string;
  trade_id?: string;
  fee_amount?: string;
  bid_id?: string;
  listing_id?: string;
}
