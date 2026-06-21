export const COUNTRY_COUNT = 100;
export const REBEL_FACTION_START_ID = 101;
export const REBEL_FACTION_MAX_ID = 200;
export const MAP_WIDTH = 800;
export const MAP_HEIGHT = 640;
export const MOBILE_MAP_WIDTH = 800;
export const MOBILE_MAP_HEIGHT = 640;
export const HUD_HEIGHT = 44;
export const COMMAND_BAR_HEIGHT = 126;
export const GAME_DURATION_MS = 60 * 60 * 1000;
export const ROUND_RESTART_DELAY_MS = 2000;
export const REBELLION_CHECK_MS = 60 * 1000;
export const REBELLION_CHANCE = 0.01;
export const REBELLION_AREA_RATIO = 0.5;
export const SOLDIER_REVIVE_MS = 5000;
export const BATTLE_TICK_MS = 1000;
export const SOLDIER_MAX_HP = 10;
export const SOLDIER_ATTACK_POWER = 1;
export const SOLDIER_HP_REGEN_MS = 60 * 1000;
export const MINOTAUR_KILL_THRESHOLD = 10;
export const MINOTAUR_MAX_HP = 15;
export const MINOTAUR_ATTACK_POWER = 2;
export const MINOTAUR_REVIVE_MS = 30 * 1000;
export const SOLDIER_SPEED = 5;
export const ATTACK_SOLDIER_SPEED = 20;
export const SOLDIER_RADIUS = 2;
export const SOLDIER_MOVEMENT_STEP_MS = 33;
export const SOLDIER_MOVEMENT_MAX_DELTA_MS = 160;
export const SOLDIER_RENDER_SMOOTHING = 14;
export const SOLDIER_CAP_MIN = 5;
export const SOLDIER_CAP_MAX = 15;
export const PROVINCES_PER_COUNTRY = 7;
export const MAP_GENERATION_MAX_ATTEMPTS = 80;
export const MIN_COUNTRY_AREA = 1850;
export const POINT_PADDING = 28;
export const PLAYER_COLOR = 0x19b7ff;
export const PLAYER_STROKE_COLOR = 0x055c82;
export const NEUTRAL_STROKE_COLOR = 0x7a8791;
export const MAP_BACKGROUND_COLOR = 0x0e1726;
export const HUD_REFRESH_MS = 120;

export const NEUTRAL_COLORS = [
  0x8fd3c7,
  0xf2b880,
  0x91b7e8,
  0xd99bd2,
  0xb9d978,
  0xe88f8f,
  0x7fc7a6,
  0xe2cf6d,
  0x9aa3e8,
  0xe0a56f,
  0x80c4dd,
  0xc8a2df,
  0xa6cf72,
  0xee9ca7,
  0x70b8b2,
  0xd8b365,
  0x94c47d,
  0xcd9ac8,
  0x76add2,
  0xe6a37a,
  0xa3b56f,
  0xc6b0e0,
  0x82c08a,
  0xdf8fae
];

export const REBEL_COLORS = [
  0xf94144,
  0x9b5de5,
  0xf9c74f,
  0x00f5d4,
  0xf15bb5,
  0x90be6d,
  0xf3722c,
  0x43aa8b,
  0x577590,
  0xff6b6b
];

export const SYSTEM_MESSAGES = {
  invalidCommand: "请输入正确指令，例如 加入12 或 进攻8",
  joinFirst: "请先加入一个国家",
  invalidCountryId: "国家编号必须是 1-200",
  attackOwnCountry: "不能进攻自己的国家",
  attackNeighborOnly: "只能进攻相邻国家",
  roundEnding: "本局结束，正在开始下一局"
} as const;
