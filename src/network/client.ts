import type { GameState, NetworkPlayer } from "../types";
import { NETWORK_ROOM_ID, type ClientToServerMessage, type ServerToClientMessage } from "./types";

const CLIENT_ID_KEY = "map-color-war-h5:network-client-id";
const LOCAL_DEV_WS_URL = "ws://localhost:8787";

type NetworkGameClientOptions = {
  url: string;
  roomId?: string;
  onState: (state: GameState, self: NetworkPlayer | null) => void;
  onMessage: (ok: boolean, message: string) => void;
  onStatus: (message: string) => void;
};

export class NetworkGameClient {
  readonly clientId = getOrCreateClientId();
  private readonly url: string;
  private readonly roomId: string;
  private readonly onState: NetworkGameClientOptions["onState"];
  private readonly onMessage: NetworkGameClientOptions["onMessage"];
  private readonly onStatus: NetworkGameClientOptions["onStatus"];
  private socket: WebSocket | null = null;
  private nickname = "";
  private reconnectTimer = 0;
  private closedByUser = false;

  constructor(options: NetworkGameClientOptions) {
    this.url = options.url;
    this.roomId = options.roomId ?? NETWORK_ROOM_ID;
    this.onState = options.onState;
    this.onMessage = options.onMessage;
    this.onStatus = options.onStatus;
  }

  connect(nickname: string): void {
    this.nickname = nickname;
    this.closedByUser = false;
    this.clearReconnectTimer();
    this.socket?.close();
    this.socket = new WebSocket(this.url);
    this.onStatus("正在连接网络对战...");

    this.socket.addEventListener("open", () => {
      this.send({
        type: "hello",
        roomId: this.roomId,
        clientId: this.clientId,
        nickname: this.nickname
      });
      this.onStatus("已连接网络对战");
    });

    this.socket.addEventListener("message", (event) => {
      this.handleMessage(event.data);
    });

    this.socket.addEventListener("close", () => {
      if (this.closedByUser) {
        return;
      }
      this.onStatus("网络断开，正在重连");
      this.reconnectTimer = window.setTimeout(() => this.connect(this.nickname), 1600);
    });

    this.socket.addEventListener("error", () => {
      this.onStatus("网络连接异常，正在重连");
    });
  }

  close(): void {
    this.closedByUser = true;
    this.clearReconnectTimer();
    this.socket?.close();
    this.socket = null;
  }

  sendCommand(inputText: string): boolean {
    if (!this.isConnected()) {
      this.onStatus("网络断开，正在重连");
      return false;
    }

    this.send({
      type: "command",
      roomId: this.roomId,
      clientId: this.clientId,
      inputText
    });
    return true;
  }

  isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== "string") {
      return;
    }

    let message: ServerToClientMessage;
    try {
      message = JSON.parse(data) as ServerToClientMessage;
    } catch {
      return;
    }

    if (message.type === "state") {
      message.state.networkPlayers = message.players;
      if (message.self?.nickname) {
        this.nickname = message.self.nickname;
      }
      this.onState(message.state, message.self);
      return;
    }

    if (message.type === "message") {
      this.onMessage(message.ok, message.message);
    }
  }

  private send(message: ClientToServerMessage): void {
    this.socket?.send(JSON.stringify(message));
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = 0;
    }
  }
}

export function getConfiguredWebSocketUrl(): string {
  const configured = import.meta.env.VITE_WS_URL?.trim();
  if (configured) {
    return configured;
  }

  return import.meta.env.DEV ? LOCAL_DEV_WS_URL : "";
}

export function isNetworkModeEnabled(): boolean {
  return getConfiguredWebSocketUrl().length > 0;
}

function getOrCreateClientId(): string {
  try {
    const existing = localStorage.getItem(CLIENT_ID_KEY);
    if (existing) {
      return existing;
    }

    const created = crypto.randomUUID();
    localStorage.setItem(CLIENT_ID_KEY, created);
    return created;
  } catch {
    return `client-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  }
}
