import type { GameState, GameStatePatch, NetworkPlayer } from "../types";

export const NETWORK_ROOM_ID = "room-1";

export type ClientToServerMessage =
  | {
      type: "hello";
      roomId: string;
      clientId: string;
      nickname: string;
      protocolVersion?: 2;
      supportsPatches?: boolean;
    }
  | {
      type: "resync";
      roomId: string;
      clientId: string;
      knownRevision: number;
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
      type: "stateFull";
      roomId: string;
      revision: number;
      state: GameState;
      players: NetworkPlayer[];
      self: NetworkPlayer | null;
    }
  | {
      type: "statePatch";
      roomId: string;
      baseRevision: number;
      revision: number;
      patch: GameStatePatch;
      players?: NetworkPlayer[];
      self?: NetworkPlayer | null;
    }
  | {
      type: "message";
      ok: boolean;
      message: string;
    };
