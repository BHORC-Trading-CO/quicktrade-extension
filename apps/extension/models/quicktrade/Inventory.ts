export interface Item {
  id: number;
  assetId: number;
  price: number;
  float: string;
  stickers?: Stickers;
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
  overprice: number | null;
  name: string;
  position: number;
  price: number;
  wear: number;
  img: string;
  wikiLink: string;
}
