import { COUNTRY_COUNT, REBEL_FACTION_MAX_ID, SYSTEM_MESSAGES } from "../constants";
import type { Command, CommandResult, Country, GameState } from "../types";
import { getAttackRoute, type AttackRoute } from "./attackRules";
import { hasAttackAgainstTarget, removeAttackParticipant, startAttack, stopAttack } from "./battle";
import { normalizeNickname, setCustomNickname } from "./playerProfile";
import { paintWholeCountry } from "./provinces";
import { getAliveSoldiersInCountry, getCountry } from "./state";

const ATTACK_REACHABLE_ONLY_MESSAGE = "只能进攻相邻国家或隔海可达国家";
const ALLIANCE_EXISTS_MESSAGE = "当前已有结盟国家，请先退出结盟";
const ALLIANCE_PENDING_MESSAGE = "当前已有结盟申请";

const COMMAND_TEXT = {
  nickname: "昵称",
  join: "加入",
  attack: "进攻",
  truce: "停战",
  ally: "结盟",
  breakAlliance: "退出结盟",
  acceptAlliance: "同意结盟"
} as const;

type JoinTarget = {
  controllerCountryId: number;
  countries: Country[];
};

export function parseCommand(input: string): Command | { error: string } {
  const text = input.trim();
  const nicknameMatch = new RegExp(`^${COMMAND_TEXT.nickname}\\s*(.*)$`).exec(text);
  if (nicknameMatch) {
    const nickname = normalizeNickname(nicknameMatch[1]);
    if (!nickname) {
      return { error: "昵称不能为空" };
    }
    return { type: "setNickname", nickname };
  }

  const commandPattern = new RegExp(
    `^(${[
      COMMAND_TEXT.breakAlliance,
      COMMAND_TEXT.acceptAlliance,
      COMMAND_TEXT.join,
      COMMAND_TEXT.attack,
      COMMAND_TEXT.truce,
      COMMAND_TEXT.ally
    ].join("|")})\\s*(\\d+)$`
  );
  const match = commandPattern.exec(text);

  if (!match) {
    return {
      error: "请输入正确指令，例如 加入12、进攻8、停战8、结盟15、昵称小明"
    };
  }

  const countryId = Number.parseInt(match[2], 10);
  if (!Number.isInteger(countryId) || countryId < 1 || countryId > REBEL_FACTION_MAX_ID) {
    return { error: SYSTEM_MESSAGES.invalidCountryId };
  }

  switch (match[1]) {
    case COMMAND_TEXT.join:
      return { type: "join", countryId };
    case COMMAND_TEXT.attack:
      return { type: "attack", targetCountryId: countryId };
    case COMMAND_TEXT.truce:
      return { type: "truce", targetCountryId: countryId };
    case COMMAND_TEXT.ally:
      return { type: "ally", countryId };
    case COMMAND_TEXT.breakAlliance:
      return { type: "breakAlliance", countryId };
    case COMMAND_TEXT.acceptAlliance:
      return { type: "acceptAlliance", countryId };
    default:
      return { error: SYSTEM_MESSAGES.invalidCommand };
  }
}

export function executeCommand(
  state: GameState,
  command: Command,
  now = performance.now()
): CommandResult {
  if (state.isRoundEnding) {
    return setMessage(state, "本局即将重开，请稍候", false);
  }

  switch (command.type) {
    case "join":
      return joinCountry(state, command.countryId);
    case "attack":
      return attackCountry(state, command.targetCountryId, now);
    case "truce":
      return truceCountry(state, command.targetCountryId);
    case "ally":
      return allyCountry(state, command.countryId, now);
    case "breakAlliance":
      return breakAlliance(state, command.countryId);
    case "acceptAlliance":
      return acceptAlliance(state, command.countryId);
    case "setNickname":
      return setNicknameCommand(state, command.nickname);
  }
}

function joinCountry(state: GameState, inputId: number): CommandResult {
  const target = resolveJoinTarget(state, inputId);
  if (!target) {
    return setMessage(state, SYSTEM_MESSAGES.invalidCountryId, false);
  }

  if (state.playerCountryIds.length > 0) {
    return setMessage(state, `你已经加入 ${state.playerMainCountryId} 号国家`, false);
  }

  state.playerMainCountryId = target.countries[0].id;
  state.playerCountryIds = target.countries.map((country) => country.id);

  for (const country of target.countries) {
    country.owner = "player";
    country.controller = "human";
    paintWholeCountry(country, country.controllerCountryId);

    for (const soldier of state.soldiers) {
      if (soldier.countryId === country.id) {
        soldier.owner = "player";
      }
    }

    for (const dead of state.deadSoldiers) {
      if (dead.soldier.countryId === country.id) {
        dead.soldier.owner = "player";
      }
    }
  }

  return setMessage(state, `已加入 ${target.controllerCountryId} 号国家`);
}

function attackCountry(
  state: GameState,
  inputTargetCountryId: number,
  now: number
): CommandResult {
  const targetCountry = resolvePlayableTargetCountry(state, inputTargetCountryId);
  if (!targetCountry) {
    return setMessage(state, SYSTEM_MESSAGES.invalidCountryId, false);
  }

  if (state.playerCountryIds.length === 0) {
    return setMessage(state, SYSTEM_MESSAGES.joinFirst, false);
  }

  if (state.playerCountryIds.includes(targetCountry.id)) {
    return setMessage(state, SYSTEM_MESSAGES.attackOwnCountry, false);
  }

  if (state.allyCountryId === targetCountry.id) {
    return setMessage(state, "不能进攻已结盟国家", false);
  }

  const participants = findAttackParticipants(state, targetCountry);
  if (participants.length === 0) {
    return setMessage(state, ATTACK_REACHABLE_ONLY_MESSAGE, false);
  }

  const readyParticipants = participants.filter(({ country }) =>
    getAliveSoldiersInCountry(state, country.id).some((soldier) => soldier.status === "wandering")
  );
  if (readyParticipants.length === 0) {
    return setMessage(state, "暂无可派出小兵", false);
  }

  const attack = startAttack(
    state,
    readyParticipants.map(({ country }) => country.id),
    targetCountry.id,
    now,
    "attack"
  );

  if (!attack) {
    return setMessage(state, "暂无可派出小兵", false);
  }

  const seaText = readyParticipants.some((participant) => participant.route === "sea")
    ? "含跨海"
    : "";
  const participantText = readyParticipants.map(({ country }) => country.displayCountryId).join("、");
  return setMessage(
    state,
    `${participantText} 号国家开始${seaText}进攻 ${targetCountry.displayCountryId} 号国家`
  );
}

function truceCountry(state: GameState, inputTargetCountryId: number): CommandResult {
  const targetCountry = resolvePlayableTargetCountry(state, inputTargetCountryId);
  if (!targetCountry) {
    return setMessage(state, SYSTEM_MESSAGES.invalidCountryId, false);
  }

  if (!hasAttackAgainstTarget(state, targetCountry.id)) {
    return setMessage(state, "当前没有对该国家的进攻任务", false);
  }

  stopAttack(state, targetCountry.id);
  return setMessage(state, `已停止进攻 ${targetCountry.displayCountryId} 号国家`);
}

function allyCountry(state: GameState, inputId: number, now: number): CommandResult {
  const country = resolvePlayableTargetCountry(state, inputId);
  if (!country) {
    return setMessage(state, SYSTEM_MESSAGES.invalidCountryId, false);
  }

  if (state.playerCountryIds.length === 0 || state.playerMainCountryId === null) {
    return setMessage(state, SYSTEM_MESSAGES.joinFirst, false);
  }

  if (state.playerCountryIds.includes(country.id)) {
    return setMessage(state, "不能和自己的国家结盟", false);
  }

  if (hasAttackAgainstTarget(state, country.id)) {
    return setMessage(state, "不能和正在被进攻的国家结盟", false);
  }

  if (state.allyCountryId !== null) {
    return setMessage(state, ALLIANCE_EXISTS_MESSAGE, false);
  }

  if (state.pendingAllianceRequest) {
    return setMessage(state, ALLIANCE_PENDING_MESSAGE, false);
  }

  if (country.controller === "human") {
    state.pendingAllianceRequest = {
      fromCountryId: state.playerMainCountryId,
      toCountryId: country.id,
      createdAt: now
    };
    return setMessage(state, `已向 ${country.displayCountryId} 号国家发起结盟申请`);
  }

  state.allyCountryId = country.id;
  return setMessage(state, `已和 ${country.displayCountryId} 号国家结盟`);
}

function acceptAlliance(state: GameState, inputId: number): CommandResult {
  if (state.playerCountryIds.length === 0 || state.playerMainCountryId === null) {
    return setMessage(state, SYSTEM_MESSAGES.joinFirst, false);
  }

  if (state.allyCountryId !== null) {
    return setMessage(state, ALLIANCE_EXISTS_MESSAGE, false);
  }

  const country = resolvePlayableTargetCountry(state, inputId);
  const request = state.pendingAllianceRequest;
  if (
    !country ||
    !request ||
    request.fromCountryId !== country.id ||
    !state.playerCountryIds.includes(request.toCountryId)
  ) {
    return setMessage(state, "当前没有该国家的结盟申请", false);
  }

  state.allyCountryId = country.id;
  state.pendingAllianceRequest = null;
  return setMessage(state, `已同意和 ${country.displayCountryId} 号国家结盟`);
}

function breakAlliance(state: GameState, inputId: number): CommandResult {
  const country = resolvePlayableTargetCountry(state, inputId);
  if (!country || state.allyCountryId !== country.id) {
    return setMessage(state, "该国家不是当前结盟国家", false);
  }

  const result = removeAttackParticipant(state, country.id);
  state.allyCountryId = null;

  const extraText = result === "stopped" ? "，当前进攻已自动停战" : "";
  return setMessage(
    state,
    `已退出和 ${country.displayCountryId} 号国家的结盟${extraText}`
  );
}

function setNicknameCommand(state: GameState, nickname: string): CommandResult {
  const savedNickname = setCustomNickname(state.playerProfile, nickname);
  return setMessage(state, `昵称已设置为 ${savedNickname}`);
}

function resolveJoinTarget(state: GameState, inputId: number): JoinTarget | null {
  if (inputId <= COUNTRY_COUNT) {
    const country = getCountry(state, inputId);
    if (!country) {
      return null;
    }

    return getJoinTargetByController(state, country.controllerCountryId);
  }

  return getJoinTargetByController(state, inputId);
}

function getJoinTargetByController(
  state: GameState,
  controllerCountryId: number
): JoinTarget | null {
  const countries = state.countries
    .filter((country) => country.controllerCountryId === controllerCountryId)
    .sort((left, right) => left.id - right.id);
  if (countries.length === 0) {
    return null;
  }

  return {
    controllerCountryId,
    countries
  };
}

function resolvePlayableTargetCountry(state: GameState, inputId: number): Country | undefined {
  if (inputId <= COUNTRY_COUNT) {
    return getCountry(state, inputId);
  }

  return state.countries
    .filter((country) => country.controllerCountryId === inputId)
    .sort((left, right) => left.id - right.id)[0];
}

function findAttackParticipants(
  state: GameState,
  targetCountry: Country
): Array<{ country: Country; route: AttackRoute }> {
  const sourceIds = [
    ...state.playerCountryIds,
    ...(state.allyCountryId !== null ? [state.allyCountryId] : [])
  ];
  const uniqueSourceIds = [...new Set(sourceIds)];

  return uniqueSourceIds.flatMap((countryId) => {
    const country = getCountry(state, countryId);
    if (!country) {
      return [];
    }

    const route = getAttackRoute(state, country, targetCountry);
    return route ? [{ country, route }] : [];
  });
}

function setMessage(state: GameState, message: string, ok = true): CommandResult {
  state.message = message;
  return {
    ok,
    message
  };
}
