import type { GameState, HudSnapshot } from "../types";

export function createHudSnapshot(state: GameState): HudSnapshot {
  return {
    remainingTime: formatTime(state.remainingMs)
  };
}

export function renderHud(root: HTMLElement, state: GameState): void {
  const hud = createHudSnapshot(state);
  root.innerHTML = `
    <section class="hud-panel hud-panel-time">
      <strong class="hud-time">${hud.remainingTime}</strong>
      <div class="hud-guide" aria-label="\u6e38\u620f\u6559\u5b66">
        <span>\u52a0\u516512</span>
        <span>\u8fdb\u653b13</span>
        <span>\u8fdb\u653b\u5168\u90e8</span>
        <span>\u505c\u621813</span>
        <span>\u505c\u6218\u5168\u90e8</span>
        <span>\u7ed3\u76df14</span>
        <span>\u9000\u51fa\u7ed3\u76df14</span>
      </div>
    </section>
  `;
}

function formatTime(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, "0")}:${seconds
    .toString()
    .padStart(2, "0")}`;
}
