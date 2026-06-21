import {
  GAME_DURATION_MS,
  ROUND_RESTART_DELAY_MS,
  SYSTEM_MESSAGES
} from "../constants";
import type { GameState, Size } from "../types";
import { resetGameState } from "./state";
import { assignRevivedSoldiersToLatestBattles, updateBattle } from "./battle";
import { updateRebellion } from "./rebellion";
import { regenerateSoldiers, reviveSoldiers, updateSoldiers } from "./soldiers";

export function tickGame(
  state: GameState,
  deltaMs: number,
  now = performance.now(),
  mapSize?: Size
): void {
  if (state.isRoundEnding) {
    if (state.nextRoundAt && now >= state.nextRoundAt) {
      resetGameState(state, now, mapSize ?? state.mapSize, state.editableMapData);
    }
    return;
  }

  state.remainingMs = Math.max(0, GAME_DURATION_MS - (now - state.startedAt));
  if (state.remainingMs <= 0) {
    finishRound(state, now, "time", null, SYSTEM_MESSAGES.roundEnding);
    return;
  }

  updateSoldiers(state, deltaMs);
  regenerateSoldiers(state, now);
  updateBattle(state, now);
  const revivedSoldiers = reviveSoldiers(state, now);
  assignRevivedSoldiersToLatestBattles(state, revivedSoldiers);
  if (finishRoundIfUnified(state, now)) {
    return;
  }
  updateRebellion(state, now);
  finishRoundIfUnified(state, now);
}

function finishRoundIfUnified(state: GameState, now: number): boolean {
  const winnerControllerCountryId = getUnifiedControllerCountryId(state);
  if (winnerControllerCountryId === null) {
    return false;
  }

  finishRound(
    state,
    now,
    "unified",
    winnerControllerCountryId,
    `${winnerControllerCountryId} 号国家统一全图，本局结束，正在开始下一局`
  );
  return true;
}

function getUnifiedControllerCountryId(state: GameState): number | null {
  if (state.countries.length === 0) {
    return null;
  }

  const firstControllerCountryId = state.countries[0].controllerCountryId;
  return state.countries.every(
    (country) => country.controllerCountryId === firstControllerCountryId
  )
    ? firstControllerCountryId
    : null;
}

function finishRound(
  state: GameState,
  now: number,
  reason: GameState["roundEndReason"],
  winnerControllerCountryId: number | null,
  message: string
): void {
  state.isRoundEnding = true;
  state.nextRoundAt = now + ROUND_RESTART_DELAY_MS;
  state.roundEndReason = reason;
  state.winnerControllerCountryId = winnerControllerCountryId;
  state.message = message;
}
