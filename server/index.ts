import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import WebSocket, { WebSocketServer } from "ws";
import { MAP_HEIGHT, MAP_WIDTH, REBEL_FACTION_MAX_ID } from "../src/constants";
import { appendCommandLog } from "../src/game/commandLog";
import { executeCommand, parseCommand } from "../src/game/commands";
import { createPlayerProfile, getDisplayNickname, setCustomNickname } from "../src/game/playerProfile";
import { createGameState } from "../src/game/state";
import { tickGame } from "../src/game/tick";
import { createFantasyEditableMapData, normalizeMapGenerationConfig } from "../src/map/fantasy";
import { createGameStatePatch } from "../src/network/statePatch";
import { polygonArea } from "../src/utils/geometry";
import type {
  CommandContext,
  CommandResult,
  EditableMapData,
  FantasyWorldType,
  GameState,
  MapViewMode,
  NetworkPlayer,
  PlayerProfile,
  PlayerSession
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
  width: MAP_WIDTH,
  height: MAP_HEIGHT
};

type ServerPlayerSession = PlayerSession & {
  profile: PlayerProfile;
  supportsPatches: boolean;
  lastSentRevision: number;
  lastFullRound: number;
};

type RoomState = {
  roomId: string;
  gameState: GameState;
  players: Map<string, ServerPlayerSession>;
  sockets: Map<WebSocket, string>;
  createdAt: number;
  lastTickAt: number;
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
const room = createRoom(NETWORK_ROOM_ID);

wss.on("connection", (socket) => {
  socket.on("message", (raw) => {
    handleRawMessage(room, socket, raw.toString());
  });

  socket.on("close", () => {
    handleSocketClose(room, socket);
  });
});

setInterval(() => {
  const now = performance.now();
  const delta = now - room.lastTickAt;
  room.lastTickAt = now;
  const previousRound = room.gameState.round;
  syncNetworkPlayers(room);
  tickGame(room.gameState, delta, now, room.gameState.mapSize);
  if (room.gameState.round !== previousRound) {
    resetPlayerFactionAssignments(room);
  }
  syncNetworkPlayers(room);
  markStateChanged(room);
}, SERVER_TICK_MS);

setInterval(() => {
  broadcastState(room);
}, BROADCAST_MS);

httpServer.listen(PORT, () => {
  console.log(`map-color-war-h5 websocket server listening on :${PORT}`);
});

function createRoom(roomId: string): RoomState {
  const now = performance.now();
  const editableMapData = createServerEditableMapData();
  return {
    roomId,
    gameState: createGameState(1, now, getServerMapSize(editableMapData), editableMapData),
    players: new Map(),
    sockets: new Map(),
    createdAt: now,
    lastTickAt: now
  };
}

function createServerEditableMapData(): EditableMapData {
  const importedMap = parseServerEditableMapData(process.env.DEFAULT_EDITABLE_MAP_JSON);
  if (importedMap) {
    return importedMap;
  }

  const seed = getMapEnvValue(process.env.MAP_GENERATION_SEED, "room-1-rugged-archipelago");
  const worldType = parseWorldType(
    getMapEnvValue(process.env.MAP_GENERATION_WORLD_TYPE, "twinContinents")
  );
  const config = normalizeMapGenerationConfig({
    seed,
    worldType,
    seaLevel: Number(getMapEnvValue(process.env.MAP_GENERATION_SEA_LEVEL, "0.43")),
    mountainStrength: Number(getMapEnvValue(process.env.MAP_GENERATION_MOUNTAIN_STRENGTH, "0.68")),
    moisture: Number(getMapEnvValue(process.env.MAP_GENERATION_MOISTURE, "0.58")),
    temperature: Number(process.env.MAP_GENERATION_TEMPERATURE ?? 0.58),
    riverCount: Number(getMapEnvValue(process.env.MAP_GENERATION_RIVER_COUNT, "10")),
    mapViewMode: parseMapViewMode(process.env.MAP_GENERATION_VIEW_MODE)
  });
  return createFantasyEditableMapData(config);
}

function getServerMapSize(editableMapData: EditableMapData) {
  const aspectRatio = editableMapData.sourceAspectRatio;
  if (!aspectRatio || !Number.isFinite(aspectRatio) || aspectRatio <= 0) {
    return MAP_SIZE;
  }

  const clampedAspect = Math.min(2.2, Math.max(0.72, aspectRatio));
  if (clampedAspect >= 1.12) {
    const width = Math.max(MAP_WIDTH, 960);
    return {
      width,
      height: Math.max(420, Math.round(width / clampedAspect))
    };
  }

  const height = Math.max(MAP_HEIGHT, 700);
  return {
    width: Math.max(420, Math.round(height * clampedAspect)),
    height
  };
}

function parseServerEditableMapData(raw: string | undefined): EditableMapData | null {
  if (!raw) {
    return null;
  }

  try {
    const value = JSON.parse(raw) as Partial<EditableMapData>;
    if (!value || !Array.isArray(value.landParts)) {
      return null;
    }

    const landParts = value.landParts.flatMap((part, index) => {
      if (!part || !Array.isArray(part.polygon)) {
        return [];
      }

      const polygon = part.polygon
        .map((point) => ({
          x: clamp01(Number(point.x)),
          y: clamp01(Number(point.y))
        }))
        .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));

      return polygon.length >= 3 && polygonArea(polygon) > 0.0002
        ? [
            {
              id: typeof part.id === "string" && part.id ? part.id : `custom-${index + 1}`,
              polygon
            }
          ]
        : [];
    });

    const totalArea = landParts.reduce((sum, part) => sum + polygonArea(part.polygon), 0);
    if (landParts.length === 0 || totalArea < 0.05) {
      return null;
    }

    return {
      version: 1,
      name: typeof value.name === "string" && value.name ? value.name : "Imported Map",
      landParts,
      ...(value.generationConfig
        ? { generationConfig: normalizeMapGenerationConfig(value.generationConfig) }
        : {}),
      ...(isValidAspectRatio(value.sourceAspectRatio)
        ? { sourceAspectRatio: Number(value.sourceAspectRatio) }
        : {})
    };
  } catch {
    return null;
  }
}

function getMapEnvValue(value: string | undefined, fallback: string): string {
  const legacyDefaults = new Set(["room-1-fantasy", "continent", "0.46", "0.62", "0.56", "8"]);
  if (!value || legacyDefaults.has(value)) {
    return fallback;
  }
  return value;
}

function parseWorldType(value: string | undefined): FantasyWorldType {
  if (value === "twinContinents" || value === "archipelago" || value === "continent") {
    return value;
  }

  return "twinContinents";
}

function parseMapViewMode(value: string | undefined): MapViewMode {
  if (value === "political" || value === "terrain" || value === "mixed") {
    return value;
  }

  return "mixed";
}

function handleRawMessage(roomState: RoomState, socket: WebSocket, raw: string): void {
  let message: ClientToServerMessage;
  try {
    message = JSON.parse(raw) as ClientToServerMessage;
  } catch {
    sendMessage(socket, { ok: false, message: "消息格式错误" });
    return;
  }

  if (message.roomId !== roomState.roomId) {
    sendMessage(socket, { ok: false, message: "房间不存在" });
    return;
  }

  if (message.type === "hello") {
    const session = getOrCreateSession(roomState, message.clientId, message.nickname);
    session.supportsPatches = message.protocolVersion === 2 && message.supportsPatches === true;
    bindSocketToSession(roomState, socket, session);
    syncNetworkPlayers(roomState);
    markStateChanged(roomState);
    send(socket, {
      type: "connected",
      roomId: roomState.roomId,
      clientId: session.clientId
    });
    sendState(roomState, socket, session);
    return;
  }

  if (message.type === "resync") {
    const session = getSessionForCommand(roomState, socket, message.clientId);
    bindSocketToSession(roomState, socket, session);
    sendState(roomState, socket, session, true);
    return;
  }

  if (message.type === "command") {
    const session = getSessionForCommand(roomState, socket, message.clientId);
    bindSocketToSession(roomState, socket, session);
    handleCommand(roomState, socket, session, message.inputText);
  }
}

function handleSocketClose(roomState: RoomState, socket: WebSocket): void {
  const clientId = roomState.sockets.get(socket);
  roomState.sockets.delete(socket);

  if (!clientId) {
    return;
  }

  const session = roomState.players.get(clientId);
  if (!session) {
    return;
  }

  session.lastSeenAt = performance.now();
  session.connected = hasOpenSocketForClient(roomState, clientId);
  syncNetworkPlayers(roomState);
  markStateChanged(roomState);
  broadcastState(roomState);
}

function handleCommand(
  roomState: RoomState,
  socket: WebSocket,
  session: ServerPlayerSession,
  inputText: string
): void {
  const now = performance.now();
  session.lastSeenAt = now;

  const parsed = parseCommand(inputText);
  let result: CommandResult;

  if ("error" in parsed) {
    result = { ok: false, message: parsed.error };
  } else {
    const joinControllerId =
      parsed.type === "join" ? resolveJoinControllerId(roomState.gameState, parsed.countryId) : null;
    const joinValidation = validateJoinRequest(roomState, session, joinControllerId);

    if (joinValidation) {
      result = joinValidation;
    } else {
      const context = createCommandContext(session);
      result = executeCommand(roomState.gameState, parsed, now, context);

      if (result.ok && parsed.type === "join" && joinControllerId !== null) {
        session.factionId = joinControllerId;
      }

      if (result.ok && parsed.type === "setNickname") {
        session.nickname = getDisplayNickname(session.profile);
      }
    }
  }

  syncNetworkPlayers(roomState);
  appendCommandLog(roomState.gameState, inputText, result, now, {
    clientId: session.clientId,
    nickname: session.nickname,
    factionId: session.factionId
  });
  markStateChanged(roomState);
  sendMessage(socket, result);
  broadcastState(roomState);
}

function getSessionForCommand(
  roomState: RoomState,
  socket: WebSocket,
  clientId: string
): ServerPlayerSession {
  const socketClientId = roomState.sockets.get(socket);
  if (socketClientId) {
    const session = roomState.players.get(socketClientId);
    if (session) {
      return session;
    }
  }

  return getOrCreateSession(roomState, clientId, "玩家");
}

function getOrCreateSession(
  roomState: RoomState,
  clientId: string,
  nickname: string
): ServerPlayerSession {
  const normalizedClientId = normalizeClientId(clientId);
  const existing = roomState.players.get(normalizedClientId);
  if (existing) {
    if (nickname.trim()) {
      setCustomNickname(existing.profile, nickname.trim());
      existing.nickname = getDisplayNickname(existing.profile);
    }
    existing.connected = true;
    existing.lastSeenAt = performance.now();
    return existing;
  }

  const profile = createNicknameProfile(nickname);
  const session: ServerPlayerSession = {
    clientId: normalizedClientId,
    nickname: getDisplayNickname(profile),
    factionId: null,
    connected: true,
    lastSeenAt: performance.now(),
    profile,
    supportsPatches: false,
    lastSentRevision: 0,
    lastFullRound: 0
  };
  roomState.players.set(normalizedClientId, session);
  return session;
}

function bindSocketToSession(
  roomState: RoomState,
  socket: WebSocket,
  session: ServerPlayerSession
): void {
  roomState.sockets.set(socket, session.clientId);
  session.connected = true;
  session.lastSeenAt = performance.now();
}

function resetPlayerFactionAssignments(roomState: RoomState): void {
  for (const session of roomState.players.values()) {
    session.factionId = null;
    session.lastSentRevision = 0;
    session.lastFullRound = 0;
  }
}

function markStateChanged(roomState: RoomState): void {
  roomState.gameState.stateRevision += 1;
}

function createNicknameProfile(nickname: string): PlayerProfile {
  const profile = createPlayerProfile();
  const normalized = nickname.trim() || profile.defaultNickname;
  setCustomNickname(profile, normalized);
  return profile;
}

function createCommandContext(session: ServerPlayerSession): CommandContext {
  return {
    mode: "server",
    clientId: session.clientId,
    factionId: session.factionId,
    nickname: session.nickname,
    playerProfile: session.profile
  };
}

function validateJoinRequest(
  roomState: RoomState,
  session: ServerPlayerSession,
  controllerCountryId: number | null
): CommandResult | null {
  if (controllerCountryId === null) {
    return null;
  }

  if (session.factionId !== null) {
    if (session.factionId === controllerCountryId) {
      return null;
    }

    return {
      ok: false,
      message: `你已经加入 ${session.factionId} 号国家`
    };
  }

  const occupied = [...roomState.players.values()].some(
    (candidate) =>
      candidate.clientId !== session.clientId &&
      candidate.factionId === controllerCountryId
  );

  return occupied ? { ok: false, message: "该国家已被其他玩家占用" } : null;
}

function resolveJoinControllerId(state: GameState, inputId: number): number | null {
  if (inputId < 1 || inputId > REBEL_FACTION_MAX_ID) {
    return null;
  }

  if (inputId <= state.countries.length) {
    return state.countries[inputId - 1]?.controllerCountryId ?? null;
  }

  return state.countries.find((country) => country.controllerCountryId === inputId)
    ?.controllerCountryId ?? null;
}

function syncNetworkPlayers(roomState: RoomState): NetworkPlayer[] {
  const players = [...roomState.players.values()].map((session) =>
    createNetworkPlayerSnapshot(roomState.gameState, session)
  );
  roomState.gameState.networkPlayers = players;
  return players;
}

function createNetworkPlayerSnapshot(
  state: GameState,
  session: ServerPlayerSession
): NetworkPlayer {
  const countryIds =
    session.factionId === null
      ? []
      : state.countries
          .filter((country) => country.controllerCountryId === session.factionId)
          .map((country) => country.id);
  const mainCountryId = countryIds[0] ?? null;

  return {
    clientId: session.clientId,
    nickname: session.nickname,
    factionId: session.factionId,
    mainCountryId,
    countryIds,
    controllerCountryId: session.factionId,
    connected: session.connected
  };
}

function broadcastState(roomState: RoomState): void {
  syncNetworkPlayers(roomState);
  for (const [socket, clientId] of roomState.sockets) {
    const session = roomState.players.get(clientId);
    if (session) {
      sendState(roomState, socket, session);
    }
  }
}

function sendState(
  roomState: RoomState,
  socket: WebSocket,
  session: ServerPlayerSession,
  forceFull = false
): void {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }

  const players = syncNetworkPlayers(roomState);
  const self = createNetworkPlayerSnapshot(roomState.gameState, session);

  if (session.supportsPatches) {
    const needsFullState =
      forceFull ||
      session.lastSentRevision === 0 ||
      session.lastFullRound !== roomState.gameState.round;
    if (needsFullState) {
      send(socket, {
        type: "stateFull",
        roomId: roomState.roomId,
        revision: roomState.gameState.stateRevision,
        state: roomState.gameState,
        players,
        self
      });
      session.lastSentRevision = roomState.gameState.stateRevision;
      session.lastFullRound = roomState.gameState.round;
      return;
    }

    if (roomState.gameState.stateRevision > session.lastSentRevision) {
      const baseRevision = session.lastSentRevision;
      send(socket, {
        type: "statePatch",
        roomId: roomState.roomId,
        baseRevision,
        revision: roomState.gameState.stateRevision,
        patch: createGameStatePatch(roomState.gameState),
        players,
        self
      });
      session.lastSentRevision = roomState.gameState.stateRevision;
    }
    return;
  }

  send(socket, {
    type: "state",
    roomId: roomState.roomId,
    state: roomState.gameState,
    players,
    self
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

function hasOpenSocketForClient(roomState: RoomState, clientId: string): boolean {
  for (const [socket, socketClientId] of roomState.sockets) {
    if (socketClientId === clientId && socket.readyState === WebSocket.OPEN) {
      return true;
    }
  }

  return false;
}

function normalizeClientId(clientId: string): string {
  const trimmed = clientId.trim();
  return trimmed || `client-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

function isValidAspectRatio(value: unknown): boolean {
  const ratio = Number(value);
  return Number.isFinite(ratio) && ratio >= 0.3 && ratio <= 4;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}
