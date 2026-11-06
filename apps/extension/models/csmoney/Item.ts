export interface Items {
  items: Item[];
}

export interface Item {
  appId: number;
  assetId: number;
  float: null | string;
  hasHighDemand: boolean;
  hasTradeLock: boolean;
  id: number;
  img: string;
  nameId: number;
  price: number;
  quality: Quality | null;
  rarity: Rarity;
  steamId: string;
  steamImg: string;
  type: number;
  '3d'?: null | string;
  preview?: string;
  screenshot?: string;
  priceWithBonus: number;
  userId: null;
  pattern: number | null;
  rank: null | string;
  collection: null | string;
  collectionInfo: CollectionInfo;
  overpay: Overpay | null;
  stickers: Array<Sticker | null> | null;
  inspect: string;
  fullName: string;
  hasConcreteSkinPage: boolean;
  shortName: string;
  fullSlug: string;
  wiki: string;
  overprice?: number;
  tradeLock?: number;
  name?: string;
  stackId?: string;
  stackSize?: number;
  stackItems?: StackItem[];
  isStatTrak?: boolean;
  stickerType?: string;
  isSouvenir?: boolean;
}

export interface CollectionInfo {
  img?: string;
  name: null | string;
}

export interface Overpay {
  pattern?: number;
  float?: number;
  stickers?: number;
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
  Exotic = 'Exotic',
  Extraordinary = 'Extraordinary',
  Remarkable = 'Remarkable',
  Restricted = 'Restricted',
}

export interface StackItem {
  float: null | string;
  id: number;
  img: string;
  pattern: number | null;
  stackId: string;
  steamId: string;
  tradeLock: number | null;
  '3d'?: string;
  hasScreenshot?: boolean;
  preview?: string;
  screenshot?: string;
  screenshotStatus?: ScreenshotStatus;
  toDelete?: boolean;
}

export enum ScreenshotStatus {
  Created = 'CREATED',
  Creating = 'CREATING',
}

export interface Sticker {
  overprice: null;
  name: string;
  position: number;
  price: number;
  wear: number;
  img: string;
  wikiLink: string;
}
