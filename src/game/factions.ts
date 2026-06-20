import { REBEL_FACTION_START_ID } from "../constants";
import type { Country, GameState, RebelFaction } from "../types";

export function getRebelFaction(
  state: GameState,
  factionId: number
): RebelFaction | undefined {
  return state.rebelFactions.find((faction) => faction.id === factionId);
}

export function getFactionColor(
  state: GameState,
  controllerCountryId: number,
  fallbackCountry: Country
): number {
  if (controllerCountryId >= REBEL_FACTION_START_ID) {
    return getRebelFaction(state, controllerCountryId)?.color ?? fallbackCountry.color;
  }

  return fallbackCountry.color;
}
