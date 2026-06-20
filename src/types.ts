export type Owner = "neutral" | "player";

export type Point = {
  x: number;
  y: number;
};

export type Size = {
  width: number;
  height: number;
};

export type MapRegionId = "china" | "custom";

export type EditableMapLandPart = {
  id: string;
  polygon: Point[];
};

export type EditableMapData = {
  version: 1;
  name: string;
  landParts: EditableMapLandPart[];
};

export type MapLandPart = {
  id: string;
  polygon: Point[];
  minSeeds?: number;
};

export type MapRegion = {
  id: MapRegionId;
  name: string;
  landParts: MapLandPart[];
  outlinePolygons: Point[][];
};

export type GeneratedMapResult = {
  countries: Country[];
  region: MapRegion;
};

export type Country = {
  id: number;
  displayCountryId: number;
  controllerCountryId: number;
  polygon: Point[];
  center: Point;
  area: number;
  landPartId: string;
  neighbors: number[];
  owner: Owner;
  controller: "computer" | "human";
  color: number;
  defaultSoldierCap: number;
  provinces: Province[];
  spawnProvinceId: string;
};

export type Province = {
  id: string;
  countryId: number;
  polygon: Point[];
  center: Point;
  area: number;
  paintCountryId: number;
  isSpawnProvince: boolean;
};

export type SoldierStatus = "wandering" | "attacking" | "fighting" | "returning";

export type Soldier = {
  id: string;
  countryId: number;
  owner: Owner;
  x: number;
  y: number;
  target: Point;
  hp: number;
  alive: boolean;
  status: SoldierStatus;
};

export type DeadSoldier = {
  soldier: Soldier;
  reviveAt: number;
};

export type AttackTask = {
  id: string;
  sourceTaskId?: string;
  kind: "attack" | "counter";
  targetCountryId: number;
  participantCountryIds: number[];
  conquerorCountryId: number;
  attackerSoldierIds: string[];
  startedAt: number;
  lastBattleAt: number;
  phase: "moving" | "fighting" | "painting";
};

export type CommandLogEntry = {
  id: number;
  input: string;
  ok: boolean;
  message: string;
  createdAt: number;
};

export type RebelFaction = {
  id: number;
  originCountryId: number;
  color: number;
  createdAt: number;
  active: boolean;
};

export type SerializableGameState = {
  version: 1;
  round: number;
  mapSize: Size;
  region: {
    id: MapRegionId;
    name: string;
    landPartIds: string[];
  };
  editableMapData?: EditableMapData;
  player: {
    mainCountryId: number | null;
    countryIds: number[];
    networkPlayers: NetworkPlayer[];
    allyCountryId: number | null;
    pendingAllianceRequest: GameState["pendingAllianceRequest"];
    profile: PlayerProfile;
  };
  time: {
    startedAt: number;
    remainingMs: number;
    isRoundEnding: boolean;
    nextRoundAt: number | null;
  };
  countries: Array<{
    id: number;
    displayCountryId: number;
    controllerCountryId: number;
    landPartId: string;
    neighbors: number[];
    owner: Owner;
    controller: Country["controller"];
    color: number;
    defaultSoldierCap: number;
    provincePaint: Array<{
      id: string;
      paintCountryId: number;
      isSpawnProvince: boolean;
    }>;
  }>;
  rebel: {
    nextRebelFactionId: number;
    nextRebellionCheckAt: number;
    factions: RebelFaction[];
  };
  soldiers: Array<{
    id: string;
    countryId: number;
    owner: Owner;
    x: number;
    y: number;
    target: Point;
    hp: number;
    alive: boolean;
    status: SoldierStatus;
  }>;
  deadSoldiers: Array<{
    soldier: {
      id: string;
      countryId: number;
      owner: Owner;
      status: SoldierStatus;
    };
    reviveAt: number;
  }>;
  activeAttacks: Array<{
    id: string;
    sourceTaskId?: string;
    kind: AttackTask["kind"];
    targetCountryId: number;
    participantCountryIds: number[];
    conquerorCountryId: number;
    attackerSoldierIds: string[];
    aliveAttackerCount: number;
    startedAt: number;
    lastBattleAt: number;
    phase: AttackTask["phase"];
  }>;
  commandLog: CommandLogEntry[];
  message: string;
};

export type NetworkPlayer = {
  clientId: string;
  nickname: string;
  mainCountryId: number | null;
  countryIds: number[];
  controllerCountryId: number | null;
};

export type GameState = {
  mapSize: Size;
  region: MapRegion;
  editableMapData?: EditableMapData;
  playerProfile: PlayerProfile;
  countries: Country[];
  soldiers: Soldier[];
  deadSoldiers: DeadSoldier[];
  playerMainCountryId: number | null;
  playerCountryIds: number[];
  networkPlayers: NetworkPlayer[];
  allyCountryId: number | null;
  pendingAllianceRequest: {
    fromCountryId: number;
    toCountryId: number;
    createdAt: number;
  } | null;
  activeAttacks: AttackTask[];
  nextRebelFactionId: number;
  nextRebellionCheckAt: number;
  rebelFactions: RebelFaction[];
  commandLog: CommandLogEntry[];
  nextCommandLogId: number;
  startedAt: number;
  remainingMs: number;
  isRoundEnding: boolean;
  nextRoundAt: number | null;
  message: string;
  round: number;
};

export type PlayerProfile = {
  defaultNickname: string;
  customNickname: string | null;
  displayNickname: string;
  ipSeedStatus: "loading" | "ready" | "fallback";
};

export type PlayerSetupData = {
  nickname: string;
};

export type Command =
  | {
      type: "join";
      countryId: number;
    }
  | {
      type: "attack";
      targetCountryId: number;
    }
  | {
      type: "truce";
      targetCountryId: number;
    }
  | {
      type: "ally";
      countryId: number;
    }
  | {
      type: "breakAlliance";
      countryId: number;
    }
  | {
      type: "acceptAlliance";
      countryId: number;
    }
  | {
      type: "setNickname";
      nickname: string;
    };

export type CommandResult = {
  ok: boolean;
  message: string;
};

export type HudSnapshot = {
  remainingTime: string;
};
