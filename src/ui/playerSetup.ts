import { getDisplayNickname, normalizeNickname } from "../game/playerProfile";
import type { PlayerProfile, PlayerSetupData } from "../types";

type PlayerSetupOptions = {
  root: HTMLElement;
  onConfirm: (data: PlayerSetupData) => void;
  onBack: () => void;
  allowBackToEditor?: boolean;
};

export type PlayerSetupController = {
  show: (profile: PlayerProfile) => void;
  hide: () => void;
  setProfile: (profile: PlayerProfile) => void;
};

export function mountPlayerSetup({
  root,
  onConfirm,
  onBack,
  allowBackToEditor = false
}: PlayerSetupOptions): PlayerSetupController {
  root.innerHTML = markup();

  const form = requiredElement<HTMLFormElement>(root, ".player-setup-form");
  const nicknameInput = requiredElement<HTMLInputElement>(root, "[data-field='nickname']");
  const status = requiredElement<HTMLDivElement>(root, ".player-setup-status");
  const backButton = requiredElement<HTMLButtonElement>(root, "[data-action='back']");

  let userTouchedNickname = false;

  backButton.hidden = !allowBackToEditor;

  nicknameInput.addEventListener("input", () => {
    userTouchedNickname = true;
  });

  backButton.addEventListener("click", () => {
    hide();
    onBack();
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();

    const nickname = normalizeNickname(nicknameInput.value);
    if (!nickname) {
      setStatus("\u6635\u79f0\u4e0d\u80fd\u4e3a\u7a7a", true);
      return;
    }

    onConfirm({
      nickname
    });
  });

  function show(profile: PlayerProfile): void {
    userTouchedNickname = false;
    root.hidden = false;
    nicknameInput.value = getDisplayNickname(profile);
    setStatus(statusText(profile));
    window.setTimeout(() => nicknameInput.focus(), 0);
  }

  function hide(): void {
    root.hidden = true;
    status.textContent = "";
  }

  function setProfile(profile: PlayerProfile): void {
    if (root.hidden) {
      return;
    }

    if (!userTouchedNickname) {
      nicknameInput.value = getDisplayNickname(profile);
    }
    setStatus(statusText(profile));
  }

  function setStatus(message: string, isError = false): void {
    status.textContent = message;
    status.classList.toggle("is-error", isError);
  }

  function statusText(profile: PlayerProfile): string {
    if (profile.ipSeedStatus === "loading") {
      return "\u6b63\u5728\u83b7\u53d6\u9ed8\u8ba4\u6635\u79f0\uff0c\u4e5f\u53ef\u4ee5\u76f4\u63a5\u8f93\u5165\u81ea\u5b9a\u4e49\u6635\u79f0";
    }

    return `\u5f53\u524d\u6635\u79f0\uff1a${getDisplayNickname(profile)}`;
  }

  root.hidden = true;

  return {
    show,
    hide,
    setProfile
  };
}

function markup(): string {
  return `
    <div class="player-setup-shell">
      <form class="player-setup-form" autocomplete="off">
        <div class="player-setup-title">\u73a9\u5bb6\u5165\u573a</div>
        <div class="player-setup-status" aria-live="polite"></div>
        <label>
          <span>\u6635\u79f0</span>
          <input data-field="nickname" type="text" maxlength="8" inputmode="text" />
        </label>
        <div class="player-setup-actions">
          <button type="button" data-action="back">\u8fd4\u56de\u7f16\u8f91</button>
          <button type="submit" class="player-setup-primary">\u8fdb\u5165\u6e38\u620f</button>
        </div>
      </form>
    </div>
  `;
}

function requiredElement<T extends HTMLElement>(root: HTMLElement, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) {
    throw new Error("\u73a9\u5bb6\u5165\u573a\u9762\u677f\u521d\u59cb\u5316\u5931\u8d25");
  }
  return element;
}
