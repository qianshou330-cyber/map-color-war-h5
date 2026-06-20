import Phaser from "phaser";
import "./style.css";
import { MAP_HEIGHT, MAP_WIDTH } from "./constants";
import {
  createPlayerProfile,
  getDisplayNickname,
  initDefaultNicknameFromPublicIp,
  setCustomNickname
} from "./game/playerProfile";
import { canAttackCountry } from "./game/attackRules";
import { appendCommandLog as appendGameCommandLog } from "./game/commandLog";
import { createGameState } from "./game/state";
import { NetworkGameClient, getConfiguredWebSocketUrl, isNetworkModeEnabled } from "./network/client";
import { MapColorWarScene } from "./phaser/MapColorWarScene";
import type {
  EditableMapData,
  GameState,
  NetworkPlayer,
  PlayerProfile,
  PlayerSetupData
} from "./types";
import { bindCommandInput } from "./ui/commandInput";
import { renderCommandMessage } from "./ui/commandMessage";
import { renderHud } from "./ui/hud";
import { loadSavedEditableMap, mountMapEditor } from "./ui/mapEditor";
import { mountPlayerSetup } from "./ui/playerSetup";

const gameRoot = requiredElement<HTMLDivElement>("#game-root");
const editorRoot = requiredElement<HTMLDivElement>("#editor-root");
const playerSetupRoot = requiredElement<HTMLDivElement>("#player-setup-root");
const hudRoot = requiredElement<HTMLDivElement>("#hud-root");
const commandMessage = requiredElement<HTMLDivElement>("#command-message");
const commandForm = requiredElement<HTMLFormElement>("#command-form");
const commandInput = requiredElement<HTMLInputElement>("#command-input");
const editMapButton = requiredElement<HTMLButtonElement>("#edit-map-button");
const adminMode = isAdminMode();
const networkMode = isNetworkModeEnabled();
const webSocketUrl = getConfiguredWebSocketUrl();

commandForm.classList.toggle("is-admin", adminMode);

let state: GameState | null = null;
let game: Phaser.Game | null = null;
let networkClient: NetworkGameClient | null = null;
let pendingEditableMapData: EditableMapData | undefined;
let pendingPlayerProfile: PlayerProfile | null = null;
let hasPendingSetup = false;

const render = () => {
  if (!state) {
    return;
  }

  renderHud(hudRoot, state);
  renderCommandMessage(commandMessage, state);
};

const editor = mountMapEditor({
  root: editorRoot,
  onGenerate: showPlayerSetup
});

const playerSetup = mountPlayerSetup({
  root: playerSetupRoot,
  onConfirm: (setupData) => {
    if (!hasPendingSetup || !pendingPlayerProfile) {
      showEditor();
      return;
    }

    startGame(pendingEditableMapData, setupData, pendingPlayerProfile);
  },
  onBack: showEditor,
  allowBackToEditor: adminMode
});

bindCommandInput(
  commandForm,
  commandInput,
  () => state,
  render,
  appendCommandLog,
  networkMode ? submitNetworkCommand : undefined
);

editMapButton.hidden = !adminMode;
editMapButton.addEventListener("click", () => {
  stopGame();
  showEditor();
});

if (adminMode) {
  showEditor();
} else {
  showPlayerSetup(getDefaultEditableMapData());
}

window.addEventListener("beforeunload", () => {
  stopGame();
});

function showPlayerSetup(editableMapData?: EditableMapData): void {
  stopGame();
  editor.hide();
  pendingEditableMapData = editableMapData;
  hasPendingSetup = true;
  pendingPlayerProfile = createPlayerProfile();
  playerSetup.show(pendingPlayerProfile);
  gameRoot.hidden = true;
  hudRoot.hidden = true;
  commandForm.hidden = true;

  const setupProfile = pendingPlayerProfile;
  void initDefaultNicknameFromPublicIp(setupProfile).then(() => {
    if (pendingPlayerProfile === setupProfile) {
      playerSetup.setProfile(setupProfile);
    }
  });
}

function startGame(
  editableMapData: EditableMapData | undefined,
  setupData: PlayerSetupData,
  playerProfile: PlayerProfile
): void {
  stopGame();
  editor.hide();
  playerSetup.hide();
  gameRoot.hidden = false;
  hudRoot.hidden = false;
  commandForm.hidden = false;

  setCustomNickname(playerProfile, setupData.nickname);
  const initialMapSize = measureGameRoot(gameRoot);
  state = createGameState(1, performance.now(), initialMapSize, editableMapData, playerProfile);
  state.message = networkMode
    ? "\u6b63\u5728\u8fde\u63a5\u7f51\u7edc\u5bf9\u6218..."
    : "\u8bf7\u9009\u62e9\u56fd\u5bb6\u7f16\u53f7\uff0c\u5728\u5e95\u90e8\u8f93\u5165 \u52a0\u516512";

  game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: gameRoot,
    backgroundColor: "#0e1726",
    width: initialMapSize.width,
    height: initialMapSize.height,
    scale: {
      mode: Phaser.Scale.RESIZE,
      parent: gameRoot,
      width: "100%",
      height: "100%"
    },
    scene: [
      new MapColorWarScene(
        state,
        render,
        handleCountrySelected,
        handleRouteSelected,
        networkMode
      )
    ]
  });

  if (networkMode) {
    connectNetworkGame(playerProfile);
  }

  commandInput.value = "";
  pendingEditableMapData = undefined;
  pendingPlayerProfile = null;
  hasPendingSetup = false;
  render();
}

function stopGame(): void {
  if (networkClient) {
    networkClient.close();
    networkClient = null;
  }

  if (game) {
    game.destroy(true);
    game = null;
  }

  state = null;
  hudRoot.innerHTML = "";
  commandMessage.textContent = "";
}

function showEditor(): void {
  if (!adminMode) {
    showPlayerSetup(getDefaultEditableMapData());
    return;
  }

  pendingEditableMapData = undefined;
  pendingPlayerProfile = null;
  hasPendingSetup = false;
  gameRoot.hidden = true;
  playerSetup.hide();
  hudRoot.hidden = true;
  commandForm.hidden = true;
  editor.show();
}

function getDefaultEditableMapData(): EditableMapData | undefined {
  return loadSavedEditableMap() ?? undefined;
}

function measureGameRoot(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  return {
    width: Math.max(320, Math.round(rect.width || element.clientWidth || MAP_WIDTH)),
    height: Math.max(360, Math.round(rect.height || element.clientHeight || MAP_HEIGHT))
  };
}

function requiredElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error("\u9875\u9762\u5bb9\u5668\u521d\u59cb\u5316\u5931\u8d25");
  }
  return element;
}

function isAdminMode(): boolean {
  return new URLSearchParams(window.location.search).get("admin") === "1";
}

function connectNetworkGame(playerProfile: PlayerProfile): void {
  if (!state || !webSocketUrl) {
    return;
  }

  networkClient = new NetworkGameClient({
    url: webSocketUrl,
    onState: applyAuthoritativeState,
    onMessage: (_ok, message) => {
      if (state) {
        state.message = message;
        render();
      }
    },
    onStatus: (message) => {
      if (state) {
        state.message = message;
        render();
      }
    }
  });

  networkClient.connect(getDisplayNickname(playerProfile));
}

function submitNetworkCommand(inputText: string) {
  if (!state || !networkClient) {
    return {
      ok: false,
      message: "网络尚未连接"
    };
  }

  const sent = networkClient.sendCommand(inputText);
  if (!sent) {
    state.message = "网络断开，正在重连";
  }
}

function applyAuthoritativeState(remoteState: GameState, self: NetworkPlayer | null): void {
  if (!state) {
    return;
  }

  const localProfile = state.playerProfile;
  Object.assign(state, remoteState);

  if (self) {
    state.playerMainCountryId = self.mainCountryId;
    state.playerCountryIds = [...self.countryIds];
    state.playerProfile = {
      ...localProfile,
      customNickname: self.nickname,
      displayNickname: self.nickname
    };
  }

  render();
}

function appendCommandLog(inputText: string, result: { ok: boolean; message: string }): void {
  if (!state) {
    return;
  }

  if (!networkMode) {
    appendGameCommandLog(state, inputText, result);
  }
}

function handleCountrySelected(countryId: number, routeMessage?: string): void {
  if (!state) {
    return;
  }

  const country = state.countries.find((candidate) => candidate.id === countryId);
  if (!country) {
    return;
  }

  const aliveCount = state.soldiers.filter(
    (soldier) => soldier.alive && soldier.countryId === country.id
  ).length;

  state.message =
    routeMessage ??
    `国家 ${country.id}｜显示 ${country.displayCountryId}｜兵力 ${aliveCount}/${country.defaultSoldierCap}｜${getCountryActionHint(countryId)}`;
  render();
}

function handleRouteSelected(message: string): void {
  if (!state) {
    return;
  }

  state.message = message;
  render();
}

function getCountryActionHint(countryId: number): string {
  if (!state) {
    return "";
  }
  const currentState = state;

  if (currentState.playerCountryIds.length === 0) {
    const country = currentState.countries.find((candidate) => candidate.id === countryId);
    return `可输入 加入${country?.displayCountryId ?? countryId} 落座`;
  }

  if (currentState.playerCountryIds.includes(countryId)) {
    return "这是你的领土";
  }

  if (currentState.allyCountryId === countryId) {
    return "这是你的盟友";
  }

  const targetCountry = currentState.countries.find((country) => country.id === countryId);
  if (!targetCountry) {
    return "";
  }

  const sourceIds = [
    ...currentState.playerCountryIds,
    ...(currentState.allyCountryId !== null ? [currentState.allyCountryId] : [])
  ];
  const canReach = sourceIds.some((sourceId) => {
    const sourceCountry = currentState.countries.find((country) => country.id === sourceId);
    return sourceCountry ? canAttackCountry(currentState, sourceCountry, targetCountry) : false;
  });

  return canReach ? `可输入 进攻${targetCountry.displayCountryId}` : "当前不可直接进攻";
}
