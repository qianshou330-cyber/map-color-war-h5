import type { GameState, GameStatePatch } from "../types";

export function createGameStatePatch(state: GameState): GameStatePatch {
  return {
    version: 1,
    round: state.round,
    stateRevision: state.stateRevision,
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
      startedAt: state.startedAt,
      remainingMs: state.remainingMs,
      isRoundEnding: state.isRoundEnding,
      nextRoundAt: state.nextRoundAt,
      roundEndReason: state.roundEndReason,
      winnerControllerCountryId: state.winnerControllerCountryId
    },
    countries: state.countries.map((country) => ({
      id: country.id,
      displayCountryId: country.displayCountryId,
      controllerCountryId: country.controllerCountryId,
      owner: country.owner,
      controller: country.controller,
      defaultSoldierCap: country.defaultSoldierCap,
      provincePaint: country.provinces.map((province) => ({
        id: province.id,
        paintCountryId: province.paintCountryId
      }))
    })),
    rebel: {
      nextRebelFactionId: state.nextRebelFactionId,
      nextRebellionCheckAt: state.nextRebellionCheckAt,
      factions: state.rebelFactions.map((faction) => ({ ...faction }))
    },
    soldiers: state.soldiers.map((soldier) => ({
      ...soldier,
      target: { ...soldier.target }
    })),
    deadSoldiers: state.deadSoldiers.map((dead) => ({
      reviveAt: dead.reviveAt,
      soldier: {
        ...dead.soldier,
        target: { ...dead.soldier.target }
      }
    })),
    activeAttacks: state.activeAttacks.map((attack) => ({
      ...attack,
      participantCountryIds: [...attack.participantCountryIds],
      attackerSoldierIds: [...attack.attackerSoldierIds]
    })),
    commandLog: state.commandLog.map((entry) => ({ ...entry })),
    nextCommandLogId: state.nextCommandLogId,
    message: state.message
  };
}

export function applyGameStatePatch(state: GameState, patch: GameStatePatch): boolean {
  if (patch.version !== 1 || patch.round !== state.round) {
    return false;
  }

  state.stateRevision = patch.stateRevision;
  state.playerMainCountryId = patch.player.mainCountryId;
  state.playerCountryIds = [...patch.player.countryIds];
  state.networkPlayers = patch.player.networkPlayers.map((player) => ({
    ...player,
    countryIds: [...player.countryIds]
  }));
  state.allyCountryId = patch.player.allyCountryId;
  state.alliance = patch.player.alliance ? { ...patch.player.alliance } : null;
  state.pendingAllianceRequest = patch.player.pendingAllianceRequest
    ? { ...patch.player.pendingAllianceRequest }
    : null;
  state.playerProfile = { ...patch.player.profile };
  state.startedAt = patch.time.startedAt;
  state.remainingMs = patch.time.remainingMs;
  state.isRoundEnding = patch.time.isRoundEnding;
  state.nextRoundAt = patch.time.nextRoundAt;
  state.roundEndReason = patch.time.roundEndReason;
  state.winnerControllerCountryId = patch.time.winnerControllerCountryId;
  state.nextRebelFactionId = patch.rebel.nextRebelFactionId;
  state.nextRebellionCheckAt = patch.rebel.nextRebellionCheckAt;
  state.rebelFactions = patch.rebel.factions.map((faction) => ({ ...faction }));
  state.soldiers = patch.soldiers.map((soldier) => ({
    ...soldier,
    target: { ...soldier.target }
  }));
  state.deadSoldiers = patch.deadSoldiers.map((dead) => ({
    reviveAt: dead.reviveAt,
    soldier: {
      ...dead.soldier,
      target: { ...dead.soldier.target }
    }
  }));
  state.activeAttacks = patch.activeAttacks.map((attack) => ({
    ...attack,
    participantCountryIds: [...attack.participantCountryIds],
    attackerSoldierIds: [...attack.attackerSoldierIds]
  }));
  state.commandLog = patch.commandLog.map((entry) => ({ ...entry }));
  state.nextCommandLogId = patch.nextCommandLogId;
  state.message = patch.message;

  const countriesById = new Map(state.countries.map((country) => [country.id, country]));
  for (const countryPatch of patch.countries) {
    const country = countriesById.get(countryPatch.id);
    if (!country) {
      return false;
    }

    country.displayCountryId = countryPatch.displayCountryId;
    country.controllerCountryId = countryPatch.controllerCountryId;
    country.owner = countryPatch.owner;
    country.controller = countryPatch.controller;
    country.defaultSoldierCap = countryPatch.defaultSoldierCap;

    const provincePaintById = new Map(
      countryPatch.provincePaint.map((province) => [province.id, province.paintCountryId])
    );
    for (const province of country.provinces) {
      const paintCountryId = provincePaintById.get(province.id);
      if (paintCountryId === undefined) {
        return false;
      }
      province.paintCountryId = paintCountryId;
    }
  }

  return true;
}
