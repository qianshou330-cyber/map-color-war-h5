import type { CommandResult, GameState } from "../types";

export function appendCommandLog(
  state: GameState,
  inputText: string,
  result: CommandResult,
  now = performance.now()
): void {
  state.commandLog.push({
    id: state.nextCommandLogId,
    input: inputText,
    ok: result.ok,
    message: result.message,
    createdAt: now
  });
  state.nextCommandLogId += 1;

  if (state.commandLog.length > 80) {
    state.commandLog.splice(0, state.commandLog.length - 80);
  }
}
