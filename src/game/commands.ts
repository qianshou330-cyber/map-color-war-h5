import { COUNTRY_COUNT, REBEL_FACTION_MAX_ID, SYSTEM_MESSAGES } from "../constants";
import type { Command, CommandContext, CommandResult, Country, GameState } from "../types";
import { getAttackRoute, type AttackRoute } from "./attackRules";
import {
  addAutoAttackCooldown,
  disableAutoAttackPlan,
  enableAutoAttackPlan,
  updateAutoAttacks
} from "./autoAttack";
import { hasAttackAgainstTarget, removeAttackParticipant, startAttack, stopAttack } from "./battle";
import { normalizeNickname, setCustomNickname } from "./playerProfile";
import { normalizeCountryPaint } from "./provinces";
import { getAliveSoldiersInCountry, getCountry } from "./state";

const ATTACK_REACHABLE_ONLY_MESSAGE = "只能进攻相邻国家或隔海可达国家";
const ALLIANCE_EXISTS_MESSAGE = "当前已有结盟国家，请先退出结盟";
const ALLIANCE_PENDING_MESSAGE = "当前已有结盟申请";

const COMMAND_TEXT = {
  nickname: "昵称",
  join: "加入",
  attack: "进攻",
  all: "全部",
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

  const attackAllMatch = new RegExp(
    `^${COMMAND_TEXT.attack}\\s*${COMMAND_TEXT.all}$`
  ).exec(text);
  if (attackAllMatch) {
    return { type: "attackAll" };
  }

  const truceAllMatch = new RegExp(
    `^${COMMAND_TEXT.truce}\\s*${COMMAND_TEXT.all}$`
  ).exec(text);
  if (truceAllMatch) {
    return { type: "truceAll" };
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
      error: "请输入正确指令，例如 加入12、进攻8、进攻全部、停战全部、结盟15、昵称小明"
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
  now = performance.now(),
  context?: CommandContext
): CommandResult {
  if (state.isRoundEnding) {
    return setMessage(state, "本局即将重开，请稍候", false);
  }

  switch (command.type) {
    case "join":
      return joinCountry(state, command.countryId, context);
    case "attack":
      return attackCountry(state, command.targetCountryId, now, context);
    case "attackAll":
      return attackAllCountries(state, now, context);
    case "truce":
      return truceCountry(state, command.targetCountryId, now, context);
    case "truceAll":
      return truceAllCountries(state, context);
    case "ally":
      return allyCountry(state, command.countryId, now, context);
    case "breakAlliance":
      return breakAlliance(state, command.countryId, context);
    case "acceptAlliance":
      return acceptAlliance(state, command.countryId, context);
    case "setNickname":
      return setNicknameCommand(state, command.nickname, context);
  }
}

function joinCountry(
  state: GameState,
  inputId: number,
  context?: CommandContext
): CommandResult {
  const target = resolveJoinTarget(state, inputId);
  if (!target) {
    return setMessage(state, SYSTEM_MESSAGES.invalidCountryId, false);
  }

  const actor = getCommandActor(state, context);
  if (actor.countryIds.length > 0 || actor.factionId !== null) {
    return setMessage(
      state,
      `你已经加入 ${actor.factionId ?? actor.mainCountryId} 号国家`,
      false
    );
  }

  if (!isServerContext(context)) {
    state.playerMainCountryId = target.countries[0].id;
    state.playerCountryIds = target.countries.map((country) => country.id);
  }

  for (const country of target.countries) {
    country.owner = "player";
    country.controller = "human";
    normalizeCountryPaint(country);

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
  now: number,
  context?: CommandContext
): CommandResult {
  const targetCountry = resolvePlayableTargetCountry(state, inputTargetCountryId);
  if (!targetCountry) {
    return setMessage(state, SYSTEM_MESSAGES.invalidCountryId, false);
  }

  const actor = getCommandActor(state, context);
  if (actor.countryIds.length === 0) {
    return setMessage(state, SYSTEM_MESSAGES.joinFirst, false);
  }

  if (
    actor.countryIds.includes(targetCountry.id) ||
    targetCountry.controllerCountryId === actor.factionId
  ) {
    return setMessage(state, SYSTEM_MESSAGES.attackOwnCountry, false);
  }

  const allyCountryId = getAlliancePartnerCountryId(state, actor.countryIds);
  const allyCountry = allyCountryId ? getCountry(state, allyCountryId) : undefined;
  if (
    allyCountry &&
    (targetCountry.id === allyCountry.id ||
      targetCountry.controllerCountryId === allyCountry.controllerCountryId)
  ) {
    return setMessage(state, "不能进攻已结盟国家", false);
  }

  const participants = findAttackParticipants(state, targetCountry, actor.countryIds);
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

function attackAllCountries(
  state: GameState,
  now: number,
  context?: CommandContext
): CommandResult {
  const actor = getCommandActor(state, context);
  if (actor.countryIds.length === 0 || actor.factionId === null) {
    return setMessage(state, SYSTEM_MESSAGES.joinFirst, false);
  }

  const plan = enableAutoAttackPlan(state, actor.factionId, now);
  updateAutoAttacks(state, now);
  const activeAutoAttackCount = state.activeAttacks.filter((attack) =>
    plan.originWarIds.includes(attack.originWarId)
  ).length;
  const suffix =
    activeAutoAttackCount > 0
      ? `，已开启 ${activeAutoAttackCount} 条自动战线`
      : "，暂无可进攻目标或可用小兵";

  return setMessage(state, `${actor.factionId} 号国家开启自动进攻${suffix}`);
}

function truceCountry(
  state: GameState,
  inputTargetCountryId: number,
  now: number,
  context?: CommandContext
): CommandResult {
  const targetCountry = resolvePlayableTargetCountry(state, inputTargetCountryId);
  if (!targetCountry) {
    return setMessage(state, SYSTEM_MESSAGES.invalidCountryId, false);
  }

  const actor = getCommandActor(state, context);
  if (actor.countryIds.length === 0) {
    return setMessage(state, SYSTEM_MESSAGES.joinFirst, false);
  }

  const participantIds = getCommandParticipantIds(state, actor.countryIds);
  if (!hasAttackAgainstTarget(state, targetCountry.id, participantIds, actor.factionId)) {
    return setMessage(state, "当前没有对该国家的进攻任务", false);
  }

  stopAttack(state, targetCountry.id, participantIds, actor.factionId);
  if (actor.factionId !== null) {
    addAutoAttackCooldown(state, actor.factionId, targetCountry.id, now);
  }
  return setMessage(state, `已停止进攻 ${targetCountry.displayCountryId} 号国家`);
}

function truceAllCountries(
  state: GameState,
  context?: CommandContext
): CommandResult {
  const actor = getCommandActor(state, context);
  if (actor.countryIds.length === 0 || actor.factionId === null) {
    return setMessage(state, SYSTEM_MESSAGES.joinFirst, false);
  }

  const stoppedCount = disableAutoAttackPlan(state, actor.factionId);
  if (stoppedCount === null) {
    return setMessage(state, "当前没有开启自动进攻", false);
  }

  return setMessage(state, `已停止全部自动进攻，清理 ${stoppedCount} 条战线`);
}

function allyCountry(
  state: GameState,
  inputId: number,
  now: number,
  context?: CommandContext
): CommandResult {
  const country = resolvePlayableTargetCountry(state, inputId);
  if (!country) {
    return setMessage(state, SYSTEM_MESSAGES.invalidCountryId, false);
  }

  const actor = getCommandActor(state, context);
  if (actor.countryIds.length === 0 || actor.mainCountryId === null) {
    return setMessage(state, SYSTEM_MESSAGES.joinFirst, false);
  }

  if (actor.countryIds.includes(country.id) || country.controllerCountryId === actor.factionId) {
    return setMessage(state, "不能和自己的国家结盟", false);
  }

  if (hasAttackAgainstTarget(state, country.id)) {
    return setMessage(state, "不能和正在被进攻的国家结盟", false);
  }

  if (state.alliance !== null) {
    return setMessage(state, ALLIANCE_EXISTS_MESSAGE, false);
  }

  if (state.pendingAllianceRequest) {
    return setMessage(state, ALLIANCE_PENDING_MESSAGE, false);
  }

  if (country.controller === "human") {
    state.pendingAllianceRequest = {
      fromCountryId: actor.mainCountryId,
      toCountryId: country.id,
      createdAt: now
    };
    return setMessage(state, `已向 ${country.displayCountryId} 号国家发起结盟申请`);
  }

  setAlliance(state, actor.mainCountryId, country.id);
  return setMessage(state, `已和 ${country.displayCountryId} 号国家结盟`);
}

function acceptAlliance(
  state: GameState,
  inputId: number,
  context?: CommandContext
): CommandResult {
  const actor = getCommandActor(state, context);
  if (actor.countryIds.length === 0 || actor.mainCountryId === null) {
    return setMessage(state, SYSTEM_MESSAGES.joinFirst, false);
  }

  if (state.alliance !== null) {
    return setMessage(state, ALLIANCE_EXISTS_MESSAGE, false);
  }

  const country = resolvePlayableTargetCountry(state, inputId);
  const request = state.pendingAllianceRequest;
  if (
    !country ||
    !request ||
    request.fromCountryId !== country.id ||
    !actor.countryIds.includes(request.toCountryId)
  ) {
    return setMessage(state, "当前没有该国家的结盟申请", false);
  }

  setAlliance(state, request.fromCountryId, request.toCountryId);
  state.pendingAllianceRequest = null;
  return setMessage(state, `已同意和 ${country.displayCountryId} 号国家结盟`);
}

function breakAlliance(
  state: GameState,
  inputId: number,
  context?: CommandContext
): CommandResult {
  const actor = getCommandActor(state, context);
  if (actor.countryIds.length === 0) {
    return setMessage(state, SYSTEM_MESSAGES.joinFirst, false);
  }

  const country = resolvePlayableTargetCountry(state, inputId);
  const partnerCountryId = getAlliancePartnerCountryId(state, actor.countryIds);
  const actorInAlliance = partnerCountryId !== null;
  const inputInAlliance = country ? isCountryInAlliance(state, country.id) : false;
  if (!country || !actorInAlliance || !inputInAlliance) {
    return setMessage(state, "该国家不是当前结盟国家", false);
  }

  const participantToRemove = actor.countryIds.includes(country.id)
    ? partnerCountryId
    : country.id;
  const result =
    participantToRemove === null
      ? "none"
      : removeAttackParticipant(state, participantToRemove);
  clearAlliance(state);

  const extraText = result === "stopped" ? "，当前进攻已自动停战" : "";
  return setMessage(
    state,
    `已退出和 ${country.displayCountryId} 号国家的结盟${extraText}`
  );
}

function setNicknameCommand(
  state: GameState,
  nickname: string,
  context?: CommandContext
): CommandResult {
  const profile = context?.playerProfile ?? state.playerProfile;
  const savedNickname = setCustomNickname(profile, nickname);
  if (!isServerContext(context)) {
    state.playerProfile = profile;
  }
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
  targetCountry: Country,
  actorCountryIds: number[]
): Array<{ country: Country; route: AttackRoute }> {
  const sourceIds = getCommandParticipantIds(state, actorCountryIds);
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

function getCommandParticipantIds(state: GameState, actorCountryIds: number[]): number[] {
  const allyCountryId = getAlliancePartnerCountryId(state, actorCountryIds);
  return [
    ...actorCountryIds,
    ...(allyCountryId !== null ? [allyCountryId] : [])
  ];
}

function setAlliance(state: GameState, countryAId: number, countryBId: number): void {
  state.alliance = {
    countryAId,
    countryBId
  };
  state.allyCountryId = countryBId;
}

function clearAlliance(state: GameState): void {
  state.alliance = null;
  state.allyCountryId = null;
}

function getAlliancePartnerCountryId(
  state: GameState,
  actorCountryIds: number[]
): number | null {
  if (!state.alliance) {
    return null;
  }

  const actorControllers = new Set(
    actorCountryIds
      .map((countryId) => getCountry(state, countryId)?.controllerCountryId)
      .filter((controllerCountryId): controllerCountryId is number => controllerCountryId !== undefined)
  );
  const countryA = getCountry(state, state.alliance.countryAId);
  const countryB = getCountry(state, state.alliance.countryBId);

  if (
    actorCountryIds.includes(state.alliance.countryAId) ||
    (countryA && actorControllers.has(countryA.controllerCountryId))
  ) {
    return state.alliance.countryBId;
  }

  if (
    actorCountryIds.includes(state.alliance.countryBId) ||
    (countryB && actorControllers.has(countryB.controllerCountryId))
  ) {
    return state.alliance.countryAId;
  }

  return null;
}

function isCountryInAlliance(state: GameState, countryId: number): boolean {
  if (!state.alliance) {
    return false;
  }

  if (countryId === state.alliance.countryAId || countryId === state.alliance.countryBId) {
    return true;
  }

  const country = getCountry(state, countryId);
  const countryA = getCountry(state, state.alliance.countryAId);
  const countryB = getCountry(state, state.alliance.countryBId);
  return Boolean(
    country &&
      ((countryA && country.controllerCountryId === countryA.controllerCountryId) ||
        (countryB && country.controllerCountryId === countryB.controllerCountryId))
  );
}

function getCommandActor(
  state: GameState,
  context?: CommandContext
): {
  factionId: number | null;
  mainCountryId: number | null;
  countryIds: number[];
} {
  if (isServerContext(context)) {
    const countryIds =
      context.factionId === null
        ? []
        : getCountryIdsByController(state, context.factionId);
    return {
      factionId: context.factionId,
      mainCountryId: countryIds[0] ?? null,
      countryIds
    };
  }

  const mainCountry = state.playerMainCountryId
    ? getCountry(state, state.playerMainCountryId)
    : undefined;
  return {
    factionId: mainCountry?.controllerCountryId ?? null,
    mainCountryId: state.playerMainCountryId,
    countryIds: [...state.playerCountryIds]
  };
}

function getCountryIdsByController(state: GameState, controllerCountryId: number): number[] {
  return state.countries
    .filter((country) => country.controllerCountryId === controllerCountryId)
    .map((country) => country.id);
}

function isServerContext(context: CommandContext | undefined): context is CommandContext {
  return context?.mode === "server";
}

function setMessage(state: GameState, message: string, ok = true): CommandResult {
  state.message = message;
  return {
    ok,
    message
  };
}
