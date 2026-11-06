export interface Trades_csfloat {
  trades: Trade[];
  count: number;
}

export interface Trade {
  id: string;
  created_at: string;
  buyer_id: string;
  buyer: Buyer;
  seller_id: string;
  seller: Buyer;
  contract_id: string;
  accepted_at: string;
  state: TradeState;
  verification_mode: VerificationMode;
  steam_offer: SteamOffer;
  manual_verification: boolean;
  manual_verification_at: null;
  verified_at: string;
  contract: Contract;
  trade_url: string;
  expires_at?: string;
  grace_period_start?: string;
}

export interface Buyer {
  avatar?: string;
  away: boolean;
  flags: number;
  has_valid_steam_api_key: boolean;
  online: boolean;
  stall_public: boolean;
  statistics: Statistics;
  steam_id?: string;
  username?: string;
  verification_mode?: VerificationMode;
  obfuscated_id?: string;
}

export interface Statistics {
  median_trade_time: number;
  total_avoided_trades: number;
  total_failed_trades: number;
  total_trades: number;
  total_verified_trades: number;
}

export enum VerificationMode {
  Inventory = 'inventory',
  Key = 'key',
}

export interface Contract {
  id: string;
  created_at: string;
  type: ContractType;
  price: number;
  state: ContractState;
  seller: Buyer;
  reference: ContractReference;
  item: Item;
  is_seller: boolean;
  is_watchlisted: boolean;
  watchers: number;
  sold_at: string;
  min_offer_price?: number;
  max_offer_discount?: number;
}

export interface Item {
  asset_id: string;
  def_index: number;
  paint_index?: number;
  paint_seed?: number;
  float_value?: number;
  icon_url: string;
  d_param?: string;
  is_stattrak?: boolean;
  is_souvenir?: boolean;
  rarity: number;
  quality?: number;
  market_hash_name: string;
  stickers?: Sticker[];
  tradable: number;
  inspect_link: string;
  has_screenshot: boolean;
  cs2_screenshot_id?: string;
  cs2_screenshot_at?: string;
  is_commodity: boolean;
  type: ItemType;
  rarity_name: string;
  type_name: TypeName;
  item_name: string;
  wear_name?: string;
  description?: string;
  collection?: string;
  badges?: string[];
}

export interface Sticker {
  stickerId: number;
  slot: number;
  icon_url: string;
  name: string;
  reference: StickerReference;
  wear?: number;
}

export interface StickerReference {
  price: number;
  quantity: number;
  updated_at: string;
}

export enum ItemType {
  Agent = 'agent',
  Skin = 'skin',
}

export enum TypeName {
  Agent = 'Agent',
  Skin = 'Skin',
}

export interface ContractReference {
  base_price: number;
  float_factor?: number;
  predicted_price: number;
  quantity: number;
  last_updated: string;
}

export enum ContractState {
  Sold = 'sold',
}

export enum ContractType {
  BuyNow = 'buy_now',
}

export enum TradeState {
  Verified = 'verified',
}

export interface SteamOffer {
  id?: string;
  state: number;
  is_from_seller: boolean;
  can_cancel_at: string;
  sent_at: string;
  deadline_at: string;
}
