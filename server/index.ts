import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import WebSocket, { WebSocketServer } from "ws";
import { MAP_HEIGHT, MAP_WIDTH, REBEL_FACTION_MAX_ID } from "../src/constants";
import { appendCommandLog } from "../src/game/commandLog";
import { executeCommand, parseCommand } from "../src/game/commands";
import { createPlayerProfile, getDisplayNickname, setCustomNickname } from "../src/game/playerProfile";
import { createGameState } from "../src/game/state";
import { tickGame } from "../src/game/tick";
import type {
  CommandResult,
  GameState,
  NetworkPlayer,
  PlayerProfile
} from "../src/types";
import {
  NETWORK_ROOM_ID,
  type ClientToServerMessage,
  type ServerToClientMessage
} from "../src/network/types";

const PORT = Number.parseInt(process.env.PORT ?? "8787", 10);
const SERVER_TICK_MS = 50;
const BROADCAST_MS = 150;
const MAP_SIZE = {
  width: Number.parseInt(process.env.MAP_WIDTH ?? `${MAP_WIDTH}`, 10),
  height: Number.parseInt(process.env.MAP_HEIGHT ?? `${MAP_HEIGHT}`, 10)
};

type ClientSession = NetworkPlayer & {
  profile: PlayerProfile;
};

const httpServer = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, roomId: NETWORK_ROOM_ID }));
    return;
  }

  response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  response.end("map-color-war-h5 websocket server");
});

const wss = new WebSocketServer({ server: httpServer });
const sessions = new Map<string, ClientSession>();
const sockets = new Map<WebSocket, ClientSession>();
const state = createGameState(1, performance.now(), MAP_SIZE);
let lastTickAt = performance.now();

wss.on("connection", (socket) => {
  socket.on("message", (raw) => {
    handleRawMessage(socket, raw.toString());
  });

  socket.on("close", () => {
    sockets.delete(socket);
  });
});

setInterval(() => {
  const now = performance.now();
  const delta = now - lastTickAt;
  lastTickAt = now;
  applyUnionPlayerContext();
  tickGame(state, delta, now, state.mapSize);
  syncSessionsFromState();
  syncNetworkPlayers();
}, SERVER_TICK_MS);

setInterval(() => {
  broadcastState();
}, BROADCAST_MS);

httpServer.listen(PORT, () => {
  console.log(`map-color-war-h5 websocket server listening on :${PORT}`);
});

function handleRawMessage(socket: WebSocket, raw: string): void {
  let message: ClientToServerMessage;
  try {
    message = JSON.parse(raw) as ClientToServerMessage;
  } catch {
    sendMessage(socket, { ok: false, message: "消息格式错误" });
    return;
  }

  if (message.roomId !== NETWORK_ROOM_ID) {
    sendMessage(socket, { ok: false, message: "房间不存在" });
    return;
  }

  if (message.type === "hello") {
    const session = getOrCreateSession(message.clientId, message.nickname);
    sockets.set(socket, session);
    syncNetworkPlayers();
    send(socket, {
      type: "connected",
      roomId: NETWORK_ROOM_ID,
      clientId: session.clientId
    });
    sendState(socket, session);
    return;
  }

  if (message.type === "command") {
    const session = sockets.get(socket) ?? getOrCreateSession(message.clientId, "玩家");
    sockets.set(socket, session);
    handleCommand(socket, session, message.inputText);
  }
}

function handleCommand(socket: WebSocket, session: ClientSession, inputText: string): void {
  const now = performance.now();
  const parsed = parseCommand(inputText);
  let result: CommandResult;

  if ("error" in parsed) {
    result = { ok: false, message: parsed.error };
  } else {
    const occupiedResult = getOccupiedJoinResult(session, parsed.type === "join" ? parsed.countryId : null);
    if (occupiedResult) {
      result = occupiedResult;
    } else {
      applySessionContext(session);
      result = executeCommand(state, parsed, now);
      syncSessionFromState(session);
      syncNetworkPlayers();
    }
  }

  appendCommandLog(state, inputText, result, now);
  sendMessage(socket, result);
  broadcastState();
}

function getOrCreateSession(clientId: string, nickname: string): ClientSession {
  const existing = sessions.get(clientId);
  if (existing) {
    if (nickname.trim()) {
      existing.nickname = nickname.trim();
      setCustomNickname(existing.profile, existing.nickname);
    }
    return existing;
  }

  const profile = createNicknameProfile(nickname);
  const session: ClientSession = {
    clientId,
    nickname: getDisplayNickname(profile),
    mainCountryId: null,
    countryIds: [],
    controllerCountryId: null,
    profile
  };
  sessions.set(clientId, session);
  return session;
}

function createNicknameProfile(nickname: string): PlayerProfile {
  const profile = createPlayerProfile();
  const normalized = nickname.trim() || profile.defaultNickname;
  setCustomNickname(profile, normalized);
  return profile;
}

function getOccupiedJoinResult(
  session: ClientSession,
  requestedCountryId: number | null
): CommandResult | null {
  if (requestedCountryId === null || session.countryIds.length > 0) {
    return null;
  }

  const controllerCountryId = resolveJoinControllerId(requestedCountryId);
  if (controllerCountryId === null) {
    return null;
  }

  const occupied = [...sessions.values()].some(
    (candidate) =>
      candidate.clientId !== session.clientId &&
      candidate.controllerCountryId === controllerCountryId &&
      candidate.countryIds.length > 0
  );

  return occupied ? { ok: false, message: "该国家已有玩家" } : null;
}

function resolveJoinControllerId(inputId: number): number | null {
  if (inputId < 1 || inputId > REBEL_FACTION_MAX_ID) {
    return null;
  }

  if (inputId <= state.countries.length) {
    return state.countries[inputId - 1]?.controllerCountryId ?? null;
  }

  return state.countries.find((country) => country.controllerCountryId === inputId)
    ?.controllerCountryId ?? null;
}

function applySessionContext(session: ClientSession): void {
  state.playerMainCountryId = session.mainCountryId;
  state.playerCountryIds = [...session.countryIds];
  state.playerProfile = session.profile;
}

function applyUnionPlayerContext(): void {
  const countryIds = [...new Set([...sessions.values()].flatMap((session) => session.countryIds))];
  state.playerCountryIds = countryIds;
  state.playerMainCountryId = countryIds[0] ?? null;
}

function syncSessionFromState(session: ClientSession): void {
  session.mainCountryId = state.playerMainCountryId;
  session.countryIds = [...state.playerCountryIds];
  session.profile = state.playerProfile;
  session.nickname = getDisplayNickname(session.profile);
  session.controllerCountryId = getSessionControllerCountryId(session);
}

function syncSessionsFromState(): void {
  for (const session of sessions.values()) {
    if (session.controllerCountryId === null) {
      continue;
    }

    session.countryIds = state.countries
      .filter((country) => country.controllerCountryId === session.controllerCountryId)
      .map((country) => country.id);
    session.mainCountryId = session.countryIds.includes(session.mainCountryId ?? -1)
      ? session.mainCountryId
      : session.countryIds[0] ?? null;
  }
}

function getSessionControllerCountryId(session: ClientSession): number | null {
  const mainCountry = session.mainCountryId
    ? state.countries[session.mainCountryId - 1]
    : undefined;
  if (mainCountry) {
    return mainCountry.controllerCountryId;
  }

  const firstCountry = session.countryIds[0]
    ? state.countries[session.countryIds[0] - 1]
    : undefined;
  return firstCountry?.controllerCountryId ?? session.controllerCountryId;
}

function syncNetworkPlayers(): void {
  state.networkPlayers = [...sessions.values()]
    .filter((session) => session.countryIds.length > 0)
    .map((session) => ({
      clientId: session.clientId,
      nickname: session.nickname,
      mainCountryId: session.mainCountryId,
      countryIds: [...session.countryIds],
      controllerCountryId: session.controllerCountryId
    }));
}

function broadcastState(): void {
  syncNetworkPlayers();
  for (const [socket, session] of sockets) {
    sendState(socket, session);
  }
  applyUnionPlayerContext();
}

function sendState(socket: WebSocket, session: ClientSession): void {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }

  applySessionContext(session);
  syncNetworkPlayers();
  send(socket, {
    type: "state",
    roomId: NETWORK_ROOM_ID,
    state,
    self: {
      clientId: session.clientId,
      nickname: session.nickname,
      mainCountryId: session.mainCountryId,
      countryIds: [...session.countryIds],
      controllerCountryId: session.controllerCountryId
    }
  });
}

function sendMessage(socket: WebSocket, result: CommandResult): void {
  send(socket, {
    type: "message",
    ok: result.ok,
    message: result.message
  });
}

function send(socket: WebSocket, message: ServerToClientMessage): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}
