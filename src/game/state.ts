import {
  GAME_DURATION_MS,
  MAP_HEIGHT,
  MAP_WIDTH,
  REBELLION_CHECK_MS,
  REBEL_FACTION_START_ID,
  SOLDIER_ATTACK_POWER,
  SOLDIER_CAP_MAX,
  SOLDIER_CAP_MIN,
  SOLDIER_MAX_HP
} from "../constants";
import { generateMap } from "../map/generateMap";
import type {
  Country,
  EditableMapData,
  GameState,
  Owner,
  PlayerProfile,
  Size,
  Soldier
} from "../types";
import { randomPointInPolygon } from "../utils/geometry";
import { randomInt } from "../utils/random";
import { randomBorderPatrolPoint } from "./patrol";
import { createPlayerProfile } from "./playerProfile";
import { getSpawnProvince, normalizeCountryPaint, randomPointInProvince } from "./provinces";

export function createGameState(
  round = 1,
  now = performance.now(),
  mapSize: Size = { width: MAP_WIDTH, height: MAP_HEIGHT },
  editableMapData?: EditableMapData,
  playerProfile: PlayerProfile = createPlayerProfile()
): GameState {
  const normalizedMapSize = normalizeMapSize(mapSize);
  const generatedMap = generateMap(
    normalizedMapSize.width,
    normalizedMapSize.height,
    editableMapData
  );
  const countries = generatedMap.countries;
  const soldiers = createInitialSoldiers(countries, now);

  return {
    stateRevision: 1,
    mapSize: normalizedMapSize,
    region: generatedMap.region,
    editableMapData,
    playerProfile,
    countries,
    soldiers,
    deadSoldiers: [],
    playerMainCountryId: null,
    playerCountryIds: [],
    networkPlayers: [],
    allyCountryId: null,
    alliance: null,
    pendingAllianceRequest: null,
    activeAttacks: [],
    autoAttackPlans: [],
    nextRebelFactionId: REBEL_FACTION_START_ID,
    nextRebellionCheckAt: now + REBELLION_CHECK_MS,
    rebelFactions: [],
    commandLog: [],
    nextCommandLogId: 1,
    startedAt: now,
    remainingMs: GAME_DURATION_MS,
    isRoundEnding: false,
    nextRoundAt: null,
    roundEndReason: null,
    winnerControllerCountryId: null,
    message: `本局地图：${generatedMap.region.name}`,
    round
  };
}

export function resetGameState(
  state: GameState,
  now = performance.now(),
  mapSize: Size = state.mapSize,
  editableMapData: EditableMapData | undefined = state.editableMapData
): void {
  const next = createGameState(state.round + 1, now, mapSize, editableMapData, state.playerProfile);
  Object.assign(state, next);
}

export function getCountry(state: GameState, countryId: number): Country | undefined {
  return state.countries[countryId - 1];
}

export function setCountryOwner(country: Country, owner: Owner): void {
  country.owner = owner;
  country.controller = owner === "player" ? "human" : "computer";
  country.controllerCountryId = country.id;
  country.displayCountryId = country.id;
  normalizeCountryPaint(country);
}

export function setCountryController(
  state: GameState,
  country: Country,
  controllerCountryId: number
): void {
  country.controllerCountryId = controllerCountryId;
  country.displayCountryId = controllerCountryId;

  const controlledByPlayer = isControllerOwnedByPlayer(state, controllerCountryId, country.id);
  country.owner = controlledByPlayer ? "player" : "neutral";
  country.controller = controlledByPlayer ? "human" : "computer";
  normalizeCountryPaint(country);

  if (state.networkPlayers.length === 0) {
    if (controlledByPlayer) {
      if (!state.playerCountryIds.includes(country.id)) {
        state.playerCountryIds.push(country.id);
      }
    } else {
      state.playerCountryIds = state.playerCountryIds.filter((id) => id !== country.id);
      if (state.playerMainCountryId === country.id) {
        state.playerMainCountryId = state.playerCountryIds[0] ?? null;
      }
    }
  }

  for (const soldier of state.soldiers) {
    if (soldier.countryId === country.id) {
      soldier.owner = country.owner;
    }
  }

  for (const dead of state.deadSoldiers) {
    if (dead.soldier.countryId === country.id) {
      dead.soldier.owner = country.owner;
    }
  }

  refreshRebelFactionActivity(state);
}

export function isControllerOwnedByPlayer(
  state: GameState,
  controllerCountryId: number,
  excludedCountryId?: number
): boolean {
  if (
    state.networkPlayers.some(
      (player) =>
        player.factionId === controllerCountryId ||
        player.controllerCountryId === controllerCountryId ||
        player.countryIds.some((countryId) => {
          if (countryId === excludedCountryId) {
            return false;
          }

          const country = getCountry(state, countryId);
          return country?.controllerCountryId === controllerCountryId;
        })
    )
  ) {
    return true;
  }

  return state.playerCountryIds.some((countryId) => {
    if (countryId === excludedCountryId) {
      return false;
    }

    const country = getCountry(state, countryId);
    return country?.controllerCountryId === controllerCountryId;
  });
}

export function getAliveSoldiersInCountry(
  state: GameState,
  countryId: number,
  owner?: Owner
): Soldier[] {
  return state.soldiers.filter(
    (soldier) =>
      soldier.alive &&
      soldier.countryId === countryId &&
      (owner ? soldier.owner === owner : true)
  );
}

export function getCountryPopulationCount(state: GameState, countryId: number): number {
  const aliveCount = state.soldiers.filter((soldier) => soldier.countryId === countryId).length;
  const deadCount = state.deadSoldiers.filter(
    (dead) => dead.soldier.countryId === countryId
  ).length;
  return aliveCount + deadCount;
}

function createInitialSoldiers(countries: Country[], now: number): Soldier[] {
  const soldiers: Soldier[] = [];

  for (const country of countries) {
    country.defaultSoldierCap = randomInt(SOLDIER_CAP_MIN, SOLDIER_CAP_MAX);
    const soldierCount = randomInt(SOLDIER_CAP_MIN, country.defaultSoldierCap);

    for (let index = 0; index < soldierCount; index += 1) {
      soldiers.push(createSoldier(country, "neutral", index + 1, now));
    }
  }

  return soldiers;
}

export function createSoldier(
  country: Country,
  owner: Owner,
  sequence: number,
  now = performance.now()
): Soldier {
  const spawnProvince = getSpawnProvince(country);
  const position = spawnProvince
    ? randomPointInProvince(spawnProvince)
    : randomPointInPolygon(country.polygon);
  return {
    id: `${country.id}-${sequence}-${Math.random().toString(36).slice(2, 8)}`,
    countryId: country.id,
    owner,
    x: position.x,
    y: position.y,
    target: randomBorderPatrolPoint(country),
    hp: SOLDIER_MAX_HP,
    maxHp: SOLDIER_MAX_HP,
    attackPower: SOLDIER_ATTACK_POWER,
    killCount: 0,
    rank: "normal",
    lastHpRegenAt: now,
    alive: true,
    status: "wandering"
  };
}

function normalizeMapSize(size: Size): Size {
  return {
    width: Math.max(320, Math.round(size.width || MAP_WIDTH)),
    height: Math.max(360, Math.round(size.height || MAP_HEIGHT))
  };
}

function refreshRebelFactionActivity(state: GameState): void {
  for (const faction of state.rebelFactions) {
    faction.active = state.countries.some((country) => country.controllerCountryId === faction.id);
  }
}
