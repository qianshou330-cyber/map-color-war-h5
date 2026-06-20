import type { GameState, Point, SerializableGameState } from "../types";

export function createSerializableGameState(state: GameState): SerializableGameState {
  return {
    version: 1,
    round: state.round,
    mapSize: { ...state.mapSize },
    region: {
      id: state.region.id,
      name: state.region.name,
      landPartIds: state.region.landParts.map((part) => part.id),
      generationConfig: state.region.generationConfig
    },
    editableMapData: state.editableMapData,
    player: {
      mainCountryId: state.playerMainCountryId,
      countryIds: [...state.playerCountryIds],
      networkPlayers: state.networkPlayers.map((player) => ({
        ...player,
        countryIds: [...player.countryIds]
      })),
      allyCountryId: state.allyCountryId,
      alliance: state.alliance ? { ...state.alliance } : null,
      pendingAllianceRequest: state.pendingAllianceRequest
        ? { ...state.pendingAllianceRequest }
        : null,
      profile: { ...state.playerProfile }
    },
    time: {
      startedAt: roundNumber(state.startedAt),
      remainingMs: Math.round(state.remainingMs),
      isRoundEnding: state.isRoundEnding,
      nextRoundAt: state.nextRoundAt === null ? null : roundNumber(state.nextRoundAt)
    },
    countries: state.countries.map((country) => ({
      id: country.id,
      displayCountryId: country.displayCountryId,
      controllerCountryId: country.controllerCountryId,
      landPartId: country.landPartId,
      neighbors: [...country.neighbors],
      owner: country.owner,
      controller: country.controller,
      color: country.color,
      defaultSoldierCap: country.defaultSoldierCap,
      provincePaint: country.provinces.map((province) => ({
        id: province.id,
        paintCountryId: province.paintCountryId,
        isSpawnProvince: province.isSpawnProvince
        }))
    })),
    rebel: {
      nextRebelFactionId: state.nextRebelFactionId,
      nextRebellionCheckAt: roundNumber(state.nextRebellionCheckAt),
      factions: state.rebelFactions.map((faction) => ({ ...faction }))
    },
    soldiers: state.soldiers.map((soldier) => ({
      id: soldier.id,
      countryId: soldier.countryId,
      owner: soldier.owner,
      x: roundNumber(soldier.x),
      y: roundNumber(soldier.y),
      target: roundPoint(soldier.target),
      hp: soldier.hp,
      alive: soldier.alive,
      status: soldier.status
    })),
    deadSoldiers: state.deadSoldiers.map((dead) => ({
      soldier: {
        id: dead.soldier.id,
        countryId: dead.soldier.countryId,
        owner: dead.soldier.owner,
        status: dead.soldier.status
      },
      reviveAt: roundNumber(dead.reviveAt)
    })),
    activeAttacks: state.activeAttacks.map((attack) => ({
      id: attack.id,
      sourceTaskId: attack.sourceTaskId,
      kind: attack.kind,
      counterControllerCountryId: attack.counterControllerCountryId,
      counterTargetControllerCountryId: attack.counterTargetControllerCountryId,
      counterRootTargetCountryId: attack.counterRootTargetCountryId,
      targetCountryId: attack.targetCountryId,
      participantCountryIds: [...attack.participantCountryIds],
      conquerorCountryId: attack.conquerorCountryId,
      attackerSoldierIds: [...attack.attackerSoldierIds],
      aliveAttackerCount: attack.attackerSoldierIds.filter((soldierId) => {
        const soldier = state.soldiers.find((candidate) => candidate.id === soldierId);
        return soldier?.alive === true;
      }).length,
      startedAt: roundNumber(attack.startedAt),
      lastBattleAt: roundNumber(attack.lastBattleAt),
      phase: attack.phase
    })),
    commandLog: state.commandLog.map((entry) => ({ ...entry })),
    message: state.message
  };
}

export function serializeGameState(state: GameState): string {
  return JSON.stringify(createSerializableGameState(state), null, 2);
}

function roundPoint(point: Point): Point {
  return {
    x: roundNumber(point.x),
    y: roundNumber(point.y)
  };
}

function roundNumber(value: number): number {
  return Math.round(value * 100) / 100;
}
