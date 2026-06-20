import type { CommandLogEntry, GameState } from "../types";
import { getDisplayNickname } from "../game/playerProfile";

const MAX_DESKTOP_ROWS = 8;
const MAX_MOBILE_ROWS = 2;

export function renderCommandChat(
  root: HTMLElement,
  state: GameState,
  selfClientId?: string | null
): void {
  const maxRows = isCompactViewport() ? MAX_MOBILE_ROWS : MAX_DESKTOP_ROWS;
  const entries = state.commandLog.slice(-maxRows);

  if (entries.length === 0) {
    root.innerHTML = `<div class="command-chat-empty">等待玩家指令...</div>`;
    return;
  }

  root.innerHTML = entries.map((entry) => renderEntry(entry, state, selfClientId)).join("");
  root.scrollTop = root.scrollHeight;
}

function renderEntry(
  entry: CommandLogEntry,
  state: GameState,
  selfClientId?: string | null
): string {
  const ownClass = selfClientId && entry.clientId === selfClientId ? " is-self" : "";
  const toneClass = entry.ok ? " is-success" : " is-error";
  return `
    <div class="command-chat-entry${ownClass}${toneClass}">
      <div class="command-chat-line command-chat-player">
        <span class="command-chat-name">${escapeHtml(getSpeakerLabel(entry, state))}</span>
        <span class="command-chat-input">${escapeHtml(entry.input)}</span>
      </div>
      <div class="command-chat-line command-chat-system">
        <span>系统：</span>${escapeHtml(entry.message)}
      </div>
    </div>
  `;
}

function getSpeakerLabel(entry: CommandLogEntry, state: GameState): string {
  const nickname = entry.nickname || getDisplayNickname(state.playerProfile) || "玩家";
  return entry.factionId ? `${nickname}(${entry.factionId})：` : `${nickname}：`;
}

function isCompactViewport(): boolean {
  return window.matchMedia("(max-width: 860px), (pointer: coarse)").matches;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
