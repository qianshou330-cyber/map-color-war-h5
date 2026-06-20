import type { CommandLogEntry, CommandResult, GameState } from "../types";

type CommandLogSource = Pick<CommandLogEntry, "clientId" | "nickname" | "factionId">;

export function appendCommandLog(
  state: GameState,
  inputText: string,
  result: CommandResult,
  now = performance.now(),
  source: CommandLogSource = {}
): void {
  state.commandLog.push({
    id: state.nextCommandLogId,
    input: inputText,
    ok: result.ok,
    message: result.message,
    createdAt: now,
    ...source
  });
  state.nextCommandLogId += 1;

  if (state.commandLog.length > 80) {
    state.commandLog.splice(0, state.commandLog.length - 80);
  }
}
