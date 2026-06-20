import type { GameState, NetworkPlayer } from "../types";

export const NETWORK_ROOM_ID = "room-1";

export type ClientToServerMessage =
  | {
      type: "hello";
      roomId: string;
      clientId: string;
      nickname: string;
    }
  | {
      type: "command";
      roomId: string;
      clientId: string;
      inputText: string;
    };

export type ServerToClientMessage =
  | {
      type: "connected";
      roomId: string;
      clientId: string;
    }
  | {
      type: "state";
      roomId: string;
      state: GameState;
      players: NetworkPlayer[];
      self: NetworkPlayer | null;
    }
  | {
      type: "message";
      ok: boolean;
      message: string;
    };
