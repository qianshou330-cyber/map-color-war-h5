import {
  GAME_DURATION_MS,
  ROUND_RESTART_DELAY_MS,
  SYSTEM_MESSAGES
} from "../constants";
import type { GameState, Size } from "../types";
import { resetGameState } from "./state";
import { updateBattle } from "./battle";
import { updateRebellion } from "./rebellion";
import { reviveSoldiers, updateSoldiers } from "./soldiers";

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
    state.isRoundEnding = true;
    state.nextRoundAt = now + ROUND_RESTART_DELAY_MS;
    state.message = SYSTEM_MESSAGES.roundEnding;
    return;
  }

  updateSoldiers(state, deltaMs);
  updateBattle(state, now);
  reviveSoldiers(state, now);
  updateRebellion(state, now);
}
