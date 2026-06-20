import {
  REBELLION_AREA_RATIO,
  REBELLION_CHANCE,
  REBELLION_CHECK_MS,
  REBEL_COLORS,
  REBEL_FACTION_MAX_ID,
  REBEL_FACTION_START_ID
} from "../constants";
import type { Country, GameState, RebelFaction } from "../types";
import { sample } from "../utils/random";
import { cancelAttacksForCountry } from "./battle";
import { normalizeCountryPaint } from "./provinces";

export function updateRebellion(state: GameState, now: number): void {
  if (now < state.nextRebellionCheckAt) {
    return;
  }

  state.nextRebellionCheckAt = now + REBELLION_CHECK_MS;
  const dominantControllerId = getDominantController(state);
  if (dominantControllerId === null || Math.random() >= REBELLION_CHANCE) {
    return;
  }

  triggerRebellion(state, dominantControllerId, now);
}

function getDominantController(state: GameState): number | null {
  const totalArea = state.countries.reduce((sum, country) => sum + country.area, 0);
  if (totalArea <= 0) {
    return null;
  }

  const areaByController = new Map<number, number>();
  for (const country of state.countries) {
    areaByController.set(
      country.controllerCountryId,
      (areaByController.get(country.controllerCountryId) ?? 0) + country.area
    );
  }

  let dominantControllerId: number | null = null;
  let dominantArea = 0;
  for (const [controllerId, area] of areaByController) {
    if (area > dominantArea) {
      dominantControllerId = controllerId;
      dominantArea = area;
    }
  }

  return dominantArea / totalArea > REBELLION_AREA_RATIO ? dominantControllerId : null;
}

function triggerRebellion(
  state: GameState,
  controllerCountryId: number,
  now: number
): RebelFaction | null {
  if (state.nextRebelFactionId > REBEL_FACTION_MAX_ID) {
    return null;
  }

  const candidates = state.countries.filter(
    (country) =>
      country.controllerCountryId === controllerCountryId &&
      (controllerCountryId > REBEL_FACTION_MAX_ID || country.id !== controllerCountryId)
  );
  if (candidates.length === 0) {
    return null;
  }

  return createRebelFaction(state, sample(candidates), now);
}

function createRebelFaction(
  state: GameState,
  country: Country,
  now: number
): RebelFaction | null {
  const factionId = state.nextRebelFactionId;
  if (factionId > REBEL_FACTION_MAX_ID) {
    return null;
  }

  const faction: RebelFaction = {
    id: factionId,
    originCountryId: country.id,
    color: REBEL_COLORS[(factionId - REBEL_FACTION_START_ID) % REBEL_COLORS.length],
    createdAt: now,
    active: true
  };

  state.nextRebelFactionId += 1;
  state.rebelFactions.push(faction);
  cancelAttacksForCountry(state, country.id);
  assignCountryToRebelFaction(state, country, faction);
  state.message = `${country.id} 号区域发生叛乱，成立 ${faction.id} 号电脑国家`;

  return faction;
}

function assignCountryToRebelFaction(
  state: GameState,
  country: Country,
  faction: RebelFaction
): void {
  country.controllerCountryId = faction.id;
  country.displayCountryId = faction.id;
  country.owner = "neutral";
  country.controller = "computer";
  normalizeCountryPaint(country);

  if (state.networkPlayers.length === 0) {
    state.playerCountryIds = state.playerCountryIds.filter((countryId) => countryId !== country.id);
    if (state.playerMainCountryId === country.id) {
      state.playerMainCountryId = state.playerCountryIds[0] ?? null;
    }
  }

  for (const soldier of state.soldiers) {
    if (soldier.countryId === country.id) {
      soldier.owner = "neutral";
    }
  }

  for (const dead of state.deadSoldiers) {
    if (dead.soldier.countryId === country.id) {
      dead.soldier.owner = "neutral";
    }
  }

  refreshRebelFactionActivity(state);
}

export function refreshRebelFactionActivity(state: GameState): void {
  for (const faction of state.rebelFactions) {
    faction.active = state.countries.some(
      (country) => country.controllerCountryId === faction.id
    );
  }
}
