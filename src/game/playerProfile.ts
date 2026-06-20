import type { PlayerProfile } from "../types";

const CUSTOM_NICKNAME_KEY = "map-color-war-h5:custom-nickname";
const FALLBACK_SEED_KEY = "map-color-war-h5:nickname-seed";
const IPIFY_URL = "https://api.ipify.org?format=json";
const MAX_NICKNAME_LENGTH = 8;

export function createPlayerProfile(): PlayerProfile {
  const defaultNickname = nicknameFromSeed(getStableFallbackSeed());
  const customNickname = loadCustomNickname();

  return {
    defaultNickname,
    customNickname,
    displayNickname: customNickname ?? defaultNickname,
    ipSeedStatus: "loading"
  };
}

export async function initDefaultNicknameFromPublicIp(
  profile: PlayerProfile
): Promise<void> {
  try {
    const response = await fetch(IPIFY_URL, {
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(`ipify responded ${response.status}`);
    }

    const data = (await response.json()) as { ip?: unknown };
    if (typeof data.ip !== "string" || data.ip.trim().length === 0) {
      throw new Error("ipify response missing ip");
    }

    profile.defaultNickname = nicknameFromSeed(data.ip.trim());
    profile.ipSeedStatus = "ready";
  } catch {
    profile.defaultNickname = nicknameFromSeed(getStableFallbackSeed());
    profile.ipSeedStatus = "fallback";
  }

  refreshDisplayNickname(profile);
}

export function setCustomNickname(profile: PlayerProfile, nickname: string): string {
  const normalized = normalizeNickname(nickname);
  profile.customNickname = normalized;
  saveCustomNickname(normalized);
  refreshDisplayNickname(profile);
  return normalized;
}

export function getDisplayNickname(profile: PlayerProfile): string {
  return profile.displayNickname || profile.defaultNickname;
}

export function normalizeNickname(nickname: string): string {
  return Array.from(nickname.trim()).slice(0, MAX_NICKNAME_LENGTH).join("");
}

function refreshDisplayNickname(profile: PlayerProfile): void {
  profile.displayNickname = profile.customNickname ?? profile.defaultNickname;
}

function nicknameFromSeed(seed: string): string {
  return (hashString(seed) % 10000).toString().padStart(4, "0");
}

function hashString(input: string): number {
  let hash = 2166136261;

  for (const char of input) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function loadCustomNickname(): string | null {
  const nickname = normalizeNickname(readStorage(CUSTOM_NICKNAME_KEY) ?? "");
  return nickname.length > 0 ? nickname : null;
}

function saveCustomNickname(nickname: string): void {
  writeStorage(CUSTOM_NICKNAME_KEY, nickname);
}

function getStableFallbackSeed(): string {
  const existing = readStorage(FALLBACK_SEED_KEY);
  if (existing) {
    return existing;
  }

  const seed = `local-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  writeStorage(FALLBACK_SEED_KEY, seed);
  return seed;
}

function readStorage(key: string): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(key, value);
    }
  } catch {
    // Storage can be unavailable in private contexts; gameplay should continue.
  }
}
