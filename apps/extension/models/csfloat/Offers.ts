export interface Offers_csfloat {
  offers: Offer[];
  count: number;
}

export interface Offer {
  id: string;
  created_at: string;
  expires_at: string;
  contract_id: string;
  contract_price: number;
  buyer_id: string;
  buyer: Buyer;
  price: number;
  type: OfferType;
  state: OfferState;
  contract: Contract;
}

export interface Buyer {
  avatar: string;
  away: boolean;
  flags: number;
  has_valid_steam_api_key: boolean;
  online: boolean;
  stall_public: boolean;
  statistics: Statistics;
  steam_id: string;
  username: string;
  verification_mode?: VerificationMode;
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
  min_offer_price?: number;
  max_offer_discount?: number;
  is_watchlisted: boolean;
  watchers: number;
  sold_at?: string;
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
  low_rank?: number;
  tradable: number;
  inspect_link: string;
  has_screenshot: boolean;
  is_commodity: boolean;
  type: ItemType;
  rarity_name: string;
  type_name: TypeName;
  item_name: string;
  wear_name?: string;
  phase?: string;
  description?: string;
  stickers?: Sticker[];
  cs2_screenshot_id?: string;
  cs2_screenshot_at?: string;
  collection?: string;
  badges?: string[];
}

export interface Sticker {
  stickerId: number;
  slot: number;
  icon_url: string;
  name: string;
  reference: StickerReference;
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
  Delisted = 'delisted',
  Listed = 'listed',
  Sold = 'sold',
}

export enum ContractType {
  BuyNow = 'buy_now',
}

export enum OfferState {
  Accepted = 'accepted',
  Canceled = 'canceled',
  Declined = 'declined',
}

export enum OfferType {
  BuyerOffer = 'buyer_offer',
  SellerOffer = 'seller_offer',
}
