export interface Inventory_csmoney {
  items: Item[];
  total: number;
  cost: number;
}

export interface Item {
  id: number;
  assetId: number;
  nameId: number;
  appId: number;
  price: number;
  float: string;
  type: number;
  quality: Quality;
  rarity: Rarity;
  hasHighDemand: boolean;
  img: string;
  steamImg: string;
  overprice?: number;
  defaultPrice: number;
  hasTradeLock: boolean;
  steamId: string;
  buyOrder: BuyOrder | null;
  recommendedPrice: RecommendedPrice;
  commission: number;
  isUnavailable: boolean;
  onSale: boolean;
  sellPrice: number;
  createdAt: number;
  botPrice: number;
  overstockDiff: number;
  isAClass: boolean;
  pattern: number;
  overpay?: Overpay;
  inspect: string;
  fullName: string;
  wiki: string;
  collection: null | string;
  isStatTrak?: boolean;
  blue?: number;
  backSide?: number;
  playSide?: number;
  stickers?: Stickers;
  rank?: string;
}

export interface BuyOrder {
  id: number;
  nameId: number;
  maxPrice: number;
  quantity: number;
  quantityLeft: number;
  creationTime: number;
}

export interface Overpay {
  float?: number;
  pattern?: number;
}

export enum Quality {
  Bs = 'bs',
  Fn = 'fn',
  Ft = 'ft',
  Mw = 'mw',
  Ww = 'ww',
}

export enum Rarity {
  Classified = 'Classified',
  Covert = 'Covert',
  IndustrialGrade = 'Industrial Grade',
  MilSpecGrade = 'Mil-Spec Grade',
  Restricted = 'Restricted',
}

export interface RecommendedPrice {
  best: number;
  decreased: number;
  lowest: number;
}

export type Stickers = Array<Sticker | null>;

export interface Sticker {
  overprice: number;
  name: string;
  position: number;
  price: number;
  wear: number;
  img: string;
  wikiLink: string;
}
