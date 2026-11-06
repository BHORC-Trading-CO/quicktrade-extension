/**
 * Public Steam profiles (persona name and avatar) by SteamID64, for the trade-history counterparties Steam's own pages
 * name without a picture (an item received from a Steam user). The QTS server asks Steam's Web API
 * (`ISteamUser/GetPlayerSummaries/v2`, `STEAM_API_KEY`) and caches the answer. Display only.
 */

/** SteamID64s per `POST /api/steam/profiles` (and per Steam call). */
export const STEAM_PROFILES_MAX_IDS = 100;

/**
 * Individual-account SteamID64s: `76561197960265728` + account id, seventeen digits. The source string is exported
 * too: the server imports this package as types only and repeats it as `typeof STEAM_ID64_PATTERN_SOURCE`, which
 * fails the type check when the two drift apart.
 */
export const STEAM_ID64_PATTERN_SOURCE = '^7656119\\d{10}$';
export const STEAM_ID64_PATTERN = new RegExp(STEAM_ID64_PATTERN_SOURCE);

/** 1–{@link STEAM_PROFILES_MAX_IDS} distinct ids matching {@link STEAM_ID64_PATTERN}. */
export interface SteamProfilesRequest {
  steamIds: string[];
}

export interface SteamProfile {
  steamId: string;
  personaName?: string;
  /** `avatarfull`, on a Steam avatar CDN host only. */
  avatarUrl?: string;
}

/** Only the ids Steam answered with a usable profile. */
export interface SteamProfilesResponse {
  profiles: SteamProfile[];
}
