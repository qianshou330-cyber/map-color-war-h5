import { BATTLE_TICK_MS } from "../constants";
import type { AttackTask, Country, GameState, Soldier } from "../types";
import { distance, randomPointInPolygon } from "../utils/geometry";
import { canAttackCountry } from "./attackRules";
import {
  getNearestUnpaintedProvince,
  isCountryFullyPaintedBy,
  normalizeCountryPaint,
  paintProvinceAtPoint
} from "./provinces";
import { randomBorderPatrolPoint } from "./patrol";
import {
  getAliveSoldiersInCountry,
  getCountry,
  getCountryPopulationCount,
  setCountryController
} from "./state";
import { killSoldier } from "./soldiers";

type AttackKind = AttackTask["kind"];

export function startAttack(
  state: GameState,
  participantCountryIds: number[],
  targetCountryId: number,
  now: number,
  kind: AttackKind = "attack",
  sourceTaskId?: string
): AttackTask | null {
  const targetCountry = getCountry(state, targetCountryId);
  if (!targetCountry) {
    return null;
  }

  const uniqueParticipantIds = [...new Set(participantCountryIds)].filter(
    (countryId) => countryId !== targetCountryId
  );
  const attackers = uniqueParticipantIds.flatMap((countryId) =>
    selectAttackersFromCountry(state, countryId, targetCountry)
  );
  const existingAttack = findMergeableAttack(state, kind, targetCountryId, sourceTaskId);

  if (attackers.length === 0) {
    if (kind !== "counter" || uniqueParticipantIds.length === 0) {
      return null;
    }

    if (existingAttack) {
      return existingAttack;
    }

    const waitingCounterAttack: AttackTask = {
      id: createAttackId(kind),
      sourceTaskId,
      kind,
      targetCountryId,
      participantCountryIds: uniqueParticipantIds,
      conquerorCountryId: getNearestParticipantControllerCountryId(
        state,
        uniqueParticipantIds,
        targetCountryId
      ),
      attackerSoldierIds: [],
      startedAt: now,
      lastBattleAt: now,
      phase: "moving"
    };

    state.activeAttacks.push(waitingCounterAttack);
    return waitingCounterAttack;
  }

  const activeParticipantIds = uniqueParticipantIds.filter((countryId) =>
    attackers.some((soldier) => soldier.countryId === countryId)
  );
  const conquerorCountryId = getNearestParticipantControllerCountryId(
    state,
    activeParticipantIds,
    targetCountryId
  );

  for (const soldier of attackers) {
    soldier.status = "attacking";
    soldier.target = getNextPaintTarget(state, targetCountryId, conquerorCountryId, soldier);
  }

  if (existingAttack) {
    existingAttack.participantCountryIds = [
      ...new Set([...existingAttack.participantCountryIds, ...activeParticipantIds])
    ];
    existingAttack.attackerSoldierIds = [
      ...new Set([...existingAttack.attackerSoldierIds, ...attackers.map((soldier) => soldier.id)])
    ];
    existingAttack.conquerorCountryId = getNearestParticipantControllerCountryId(
      state,
      existingAttack.participantCountryIds,
      existingAttack.targetCountryId
    );

    if (kind === "attack") {
      ensureCounterAttackTask(state, existingAttack, now);
    }

    return existingAttack;
  }

  const attack: AttackTask = {
    id: createAttackId(kind),
    sourceTaskId,
    kind,
    targetCountryId,
    participantCountryIds: activeParticipantIds,
    conquerorCountryId,
    attackerSoldierIds: attackers.map((soldier) => soldier.id),
    startedAt: now,
    lastBattleAt: now,
    phase: "moving"
  };

  state.activeAttacks.push(attack);

  if (kind === "attack") {
    ensureCounterAttackTask(state, attack, now);
  }

  return attack;
}

export function updateBattle(state: GameState, now: number): void {
  for (const attack of [...state.activeAttacks]) {
    if (!state.activeAttacks.includes(attack)) {
      continue;
    }

    if (attack.kind === "attack") {
      ensureCounterAttackTask(state, attack, now);
    }

    updateAttackTask(state, attack, now);
  }

  cleanupOrphanCounters(state);
}

export function hasAttackAgainstTarget(
  state: GameState,
  targetCountryId: number,
  participantCountryIds?: number[]
): boolean {
  return state.activeAttacks.some(
    (attack) =>
      attack.kind === "attack" &&
      attack.targetCountryId === targetCountryId &&
      (!participantCountryIds ||
        attack.participantCountryIds.some((countryId) => participantCountryIds.includes(countryId)))
  );
}

export function stopAttack(
  state: GameState,
  targetCountryId: number,
  participantCountryIds?: number[]
): boolean {
  const attacks = state.activeAttacks.filter(
    (attack) =>
      attack.kind === "attack" &&
      attack.targetCountryId === targetCountryId &&
      (!participantCountryIds ||
        attack.participantCountryIds.some((countryId) => participantCountryIds.includes(countryId)))
  );
  if (attacks.length === 0) {
    return false;
  }

  for (const attack of attacks) {
    removeAttackTask(state, attack, true);
    stopCounterAttacksFor(state, attack.id);
  }

  cleanupOrphanCounters(state);
  return true;
}

export function removeAttackParticipant(
  state: GameState,
  countryId: number
): "none" | "continued" | "stopped" {
  let touched = false;
  let stopped = false;

  for (const attack of [...state.activeAttacks]) {
    if (!attack.participantCountryIds.includes(countryId)) {
      continue;
    }

    touched = true;
    const attackerIdsToRemove = getAttackSoldierIdsForCountry(state, attack, countryId);
    for (const soldier of state.soldiers) {
      if (attackerIdsToRemove.has(soldier.id)) {
        returnSoldierHome(state, soldier);
      }
    }

    attack.participantCountryIds = attack.participantCountryIds.filter((id) => id !== countryId);
    attack.attackerSoldierIds = attack.attackerSoldierIds.filter(
      (id) => !attackerIdsToRemove.has(id)
    );

    if (attack.participantCountryIds.length === 0 || attack.attackerSoldierIds.length === 0) {
      removeAttackTask(state, attack, false);
      if (attack.kind === "attack") {
        stopCounterAttacksFor(state, attack.id);
      }
      stopped = true;
      continue;
    }

    attack.conquerorCountryId = getNearestParticipantControllerCountryId(
      state,
      attack.participantCountryIds,
      attack.targetCountryId
    );
  }

  cleanupOrphanCounters(state);

  if (!touched) {
    return "none";
  }

  return stopped ? "stopped" : "continued";
}

function updateAttackTask(state: GameState, attack: AttackTask, now: number): void {
  const targetCountry = getCountry(state, attack.targetCountryId);
  if (!targetCountry) {
    removeAttackTask(state, attack, true);
    return;
  }

  recruitAttackersForTask(state, attack);
  prepareRevivedAttackers(state, attack);

  const attackers = getAttackers(state, attack);
  if (attackers.length === 0) {
    attack.phase = "moving";
    if (attack.attackerSoldierIds.length > 0) {
      releaseDefenders(state, attack);
    }
    return;
  }

  paintAttackersInTarget(state, attack);
  if (isCountryFullyPaintedBy(targetCountry, attack.conquerorCountryId)) {
    annexTarget(state, attack);
    return;
  }

  if (attack.phase === "moving") {
    const arrived = attackers.every(
      (soldier) => distance({ x: soldier.x, y: soldier.y }, soldier.target) < 5
    );
    if (!arrived) {
      return;
    }

    if (getDefenders(state, attack).length === 0) {
      enterPaintingPhase(state, attack);
      return;
    }

    attack.phase = "fighting";
    attack.lastBattleAt = now;
    for (const soldier of attackers) {
      soldier.status = "fighting";
    }
    for (const defender of getDefenders(state, attack)) {
      defender.status = "fighting";
      defender.target = { x: defender.x, y: defender.y };
    }
  }

  if (attack.phase === "painting") {
    retargetPainters(state, attack);
    paintAttackersInTarget(state, attack);
    if (isCountryFullyPaintedBy(targetCountry, attack.conquerorCountryId)) {
      annexTarget(state, attack);
    }
    return;
  }

  if (now - attack.lastBattleAt < BATTLE_TICK_MS) {
    return;
  }

  attack.lastBattleAt = now;
  resolveBattleTick(state, attack, now);
}

function resolveBattleTick(state: GameState, attack: AttackTask, now: number): void {
  const attackers = getAttackers(state, attack);
  const defenders = getDefenders(state, attack);

  if (attackers.length === 0) {
    attack.phase = "moving";
    releaseDefenders(state, attack);
    return;
  }

  if (defenders.length === 0) {
    enterPaintingPhase(state, attack);
    return;
  }

  const defenderLosses = Math.min(defenders.length, Math.max(1, Math.ceil(attackers.length * 0.45)));
  const attackerLosses = Math.min(attackers.length, Math.max(1, Math.ceil(defenders.length * 0.35)));

  for (const defender of defenders.slice(0, defenderLosses)) {
    killSoldier(state, defender, now);
  }

  for (const attacker of attackers.slice(0, attackerLosses)) {
    paintProvinceAtPoint(
      state,
      attack.targetCountryId,
      { x: attacker.x, y: attacker.y },
      attack.conquerorCountryId
    );
    killSoldier(state, attacker, now);
  }

  const targetCountry = getCountry(state, attack.targetCountryId);
  if (targetCountry && isCountryFullyPaintedBy(targetCountry, attack.conquerorCountryId)) {
    annexTarget(state, attack);
  } else if (getDefenders(state, attack).length === 0) {
    enterPaintingPhase(state, attack);
  } else if (getAttackers(state, attack).length === 0) {
    attack.phase = "moving";
    releaseDefenders(state, attack);
  }
}

function annexTarget(state: GameState, attack: AttackTask): void {
  const targetCountry = getCountry(state, attack.targetCountryId);
  if (!targetCountry) {
    removeAttackTask(state, attack, true);
    return;
  }

  const attackers = getAttackers(state, attack);
  const attackerHomeControllers = new Map(
    attackers.map((soldier) => [soldier.id, getSoldierControllerCountryId(state, soldier)])
  );

  setCountryController(state, targetCountry, attack.conquerorCountryId);

  for (const soldier of attackers) {
    settleAttackerAfterAnnex(
      state,
      soldier,
      targetCountry,
      attackerHomeControllers.get(soldier.id) ?? attack.conquerorCountryId
    );
  }

  for (const soldier of state.soldiers.filter(
    (candidate) => candidate.countryId === targetCountry.id
  )) {
    soldier.owner = targetCountry.owner;
    soldier.status = "wandering";
    soldier.target = randomBorderPatrolPoint(targetCountry, soldier);
  }

  const ownerText = targetCountry.owner === "player" ? "玩家" : `${attack.conquerorCountryId} 号`;
  state.message = `${targetCountry.id} 号国家已被${ownerText}吞并`;

  removeAttackTask(state, attack, false);
  stopCounterAttacksFor(state, attack.id);
  cancelAttacksForCountry(state, targetCountry.id);
  cleanupOrphanCounters(state);
  normalizeCountryPaint(targetCountry);
  joinOngoingAttacksFromNewCountry(state, targetCountry, attack.conquerorCountryId);
}

function joinOngoingAttacksFromNewCountry(
  state: GameState,
  newCountry: Country,
  controllerCountryId: number
): void {
  for (const attack of state.activeAttacks) {
    const targetCountry = getCountry(state, attack.targetCountryId);
    if (
      !targetCountry ||
      targetCountry.id === newCountry.id ||
      targetCountry.controllerCountryId === controllerCountryId ||
      attack.participantCountryIds.includes(newCountry.id) ||
      !isAttackSupportedByController(state, attack, controllerCountryId) ||
      !canAttackCountry(state, newCountry, targetCountry)
    ) {
      continue;
    }

    attack.participantCountryIds = [...new Set([...attack.participantCountryIds, newCountry.id])];
    recruitAttackersForTask(state, attack);
  }
}

function isAttackSupportedByController(
  state: GameState,
  attack: AttackTask,
  controllerCountryId: number
): boolean {
  if (attack.conquerorCountryId === controllerCountryId) {
    return true;
  }

  return attack.participantCountryIds.some((countryId) => {
    const country = getCountry(state, countryId);
    return country?.controllerCountryId === controllerCountryId;
  });
}

function ensureCounterAttackTask(state: GameState, attack: AttackTask, now: number): void {
  if (attack.kind !== "attack") {
    return;
  }

  const targetCountry = getCountry(state, attack.targetCountryId);
  if (!targetCountry || attack.participantCountryIds.length === 0) {
    return;
  }

  if (getCounterTaskForSource(state, attack.id)) {
    return;
  }

  const counterTargetId = getNearestParticipantCountryId(
    state,
    attack.participantCountryIds,
    attack.targetCountryId
  );
  if (!counterTargetId || counterTargetId === targetCountry.id) {
    return;
  }

  startAttack(state, [targetCountry.id], counterTargetId, now, "counter", attack.id);
}

function getCounterTaskForSource(
  state: GameState,
  sourceTaskId: string
): AttackTask | undefined {
  return state.activeAttacks.find(
    (task) => task.kind === "counter" && task.sourceTaskId === sourceTaskId
  );
}

function recruitAttackersForTask(state: GameState, attack: AttackTask): void {
  const targetCountry = getCountry(state, attack.targetCountryId);
  if (!targetCountry) {
    return;
  }

  const recruitedAttackers = attack.participantCountryIds.flatMap((countryId) => {
    if (getAttackSoldierIdsForCountry(state, attack, countryId).size > 0) {
      return [];
    }

    return selectAttackersFromCountry(state, countryId, targetCountry);
  });
  if (recruitedAttackers.length === 0) {
    return;
  }

  attack.attackerSoldierIds = [
    ...new Set([...attack.attackerSoldierIds, ...recruitedAttackers.map((soldier) => soldier.id)])
  ];
  attack.conquerorCountryId = getNearestParticipantControllerCountryId(
    state,
    attack.participantCountryIds,
    attack.targetCountryId
  );

  for (const soldier of recruitedAttackers) {
    soldier.status = "attacking";
    soldier.target = getNextPaintTarget(
      state,
      attack.targetCountryId,
      attack.conquerorCountryId,
      soldier
    );
  }
}

function selectAttackersFromCountry(
  state: GameState,
  countryId: number,
  targetCountry: { center: { x: number; y: number } }
): Soldier[] {
  const sourceSoldiers = getAliveSoldiersInCountry(state, countryId).filter(
    (soldier) => soldier.status === "wandering" && !isSoldierInAnyAttack(state, soldier.id)
  );
  const sendCount = Math.max(1, Math.floor(sourceSoldiers.length / 2));

  return sourceSoldiers
    .sort(
      (a, b) =>
        distance({ x: a.x, y: a.y }, targetCountry.center) -
        distance({ x: b.x, y: b.y }, targetCountry.center)
    )
    .slice(0, sendCount);
}

function prepareRevivedAttackers(state: GameState, attack: AttackTask): void {
  const attackerIds = new Set(attack.attackerSoldierIds);
  for (const soldier of state.soldiers) {
    if (attackerIds.has(soldier.id) && soldier.status === "wandering") {
      soldier.status = "attacking";
      soldier.target = getNextPaintTarget(
        state,
        attack.targetCountryId,
        attack.conquerorCountryId,
        soldier
      );
    }
  }
}

function settleAttackerAfterAnnex(
  state: GameState,
  soldier: Soldier,
  targetCountry: NonNullable<ReturnType<typeof getCountry>>,
  soldierControllerCountryId: number
): void {
  const targetHasCapacity =
    getCountryPopulationCount(state, targetCountry.id) < targetCountry.defaultSoldierCap;

  if (soldierControllerCountryId === targetCountry.controllerCountryId && targetHasCapacity) {
    assignSoldierToCountry(soldier, targetCountry);
    return;
  }

  returnSoldierHome(state, soldier);
}

function assignSoldierToCountry(
  soldier: Soldier,
  country: NonNullable<ReturnType<typeof getCountry>>
): void {
  soldier.countryId = country.id;
  soldier.owner = country.owner;
  soldier.status = "wandering";
  const position = randomPointInPolygon(country.polygon);
  soldier.x = position.x;
  soldier.y = position.y;
  soldier.target = randomBorderPatrolPoint(country);
}

function returnSoldierHome(state: GameState, soldier: Soldier): void {
  const homeCountry = getCountry(state, soldier.countryId);
  if (!homeCountry) {
    soldier.status = "wandering";
    return;
  }

  soldier.status = "returning";
  soldier.target = randomBorderPatrolPoint(homeCountry);
}

function releaseDefenders(state: GameState, attack: AttackTask): void {
  const targetCountry = getCountry(state, attack.targetCountryId);
  for (const defender of getDefenders(state, attack)) {
    defender.status = "wandering";
    if (targetCountry) {
      defender.target = randomBorderPatrolPoint(targetCountry, defender);
    }
  }
}

function getAttackers(state: GameState, attack: AttackTask): Soldier[] {
  const ids = new Set(attack.attackerSoldierIds);
  return state.soldiers.filter((soldier) => soldier.alive && ids.has(soldier.id));
}

function getDefenders(state: GameState, attack: AttackTask): Soldier[] {
  const taskAttackerIds = new Set(attack.attackerSoldierIds);
  const allAttackerIds = getAllAttackSoldierIds(state);

  return state.soldiers.filter(
    (soldier) =>
      soldier.alive &&
      soldier.countryId === attack.targetCountryId &&
      !taskAttackerIds.has(soldier.id) &&
      !allAttackerIds.has(soldier.id)
  );
}

function getAttackSoldierIdsForCountry(
  state: GameState,
  attack: AttackTask,
  countryId: number
): Set<string> {
  const ids = new Set<string>();
  for (const soldier of state.soldiers) {
    if (soldier.countryId === countryId && attack.attackerSoldierIds.includes(soldier.id)) {
      ids.add(soldier.id);
    }
  }

  for (const dead of state.deadSoldiers) {
    if (
      dead.soldier.countryId === countryId &&
      attack.attackerSoldierIds.includes(dead.soldier.id)
    ) {
      ids.add(dead.soldier.id);
    }
  }

  return ids;
}

function getNearestParticipantControllerCountryId(
  state: GameState,
  participantCountryIds: number[],
  targetCountryId: number
): number {
  const nearestCountryId = getNearestParticipantCountryId(
    state,
    participantCountryIds,
    targetCountryId
  );
  const nearestCountry = getCountry(state, nearestCountryId);
  return nearestCountry?.controllerCountryId ?? nearestCountryId;
}

function getNearestParticipantCountryId(
  state: GameState,
  participantCountryIds: number[],
  targetCountryId: number
): number {
  const targetCountry = getCountry(state, targetCountryId);
  if (!targetCountry) {
    return participantCountryIds[0] ?? 0;
  }

  return [...participantCountryIds].sort((leftId, rightId) => {
    const left = getCountry(state, leftId);
    const right = getCountry(state, rightId);
    if (!left || !right) {
      return left ? -1 : 1;
    }
    return distance(left.center, targetCountry.center) - distance(right.center, targetCountry.center);
  })[0];
}

function getNextPaintTarget(
  state: GameState,
  targetCountryId: number,
  paintCountryId: number,
  soldier: Soldier
) {
  const targetCountry = getCountry(state, targetCountryId);
  if (!targetCountry) {
    return { x: 0, y: 0 };
  }

  const province = getNearestUnpaintedProvince(
    targetCountry,
    { x: soldier.x, y: soldier.y },
    paintCountryId
  );
  return province?.center ?? targetCountry.center;
}

function paintAttackersInTarget(state: GameState, attack: AttackTask): void {
  for (const soldier of getAttackers(state, attack)) {
    paintProvinceAtPoint(
      state,
      attack.targetCountryId,
      { x: soldier.x, y: soldier.y },
      attack.conquerorCountryId
    );
  }
}

function enterPaintingPhase(state: GameState, attack: AttackTask): void {
  const targetCountry = getCountry(state, attack.targetCountryId);
  if (!targetCountry) {
    removeAttackTask(state, attack, true);
    return;
  }

  if (isCountryFullyPaintedBy(targetCountry, attack.conquerorCountryId)) {
    annexTarget(state, attack);
    return;
  }

  attack.phase = "painting";
  for (const soldier of getAttackers(state, attack)) {
    soldier.status = "attacking";
    soldier.target = getNextPaintTarget(
      state,
      attack.targetCountryId,
      attack.conquerorCountryId,
      soldier
    );
  }
}

function retargetPainters(state: GameState, attack: AttackTask): void {
  for (const soldier of getAttackers(state, attack)) {
    if (distance({ x: soldier.x, y: soldier.y }, soldier.target) < 5) {
      soldier.target = getNextPaintTarget(
        state,
        attack.targetCountryId,
        attack.conquerorCountryId,
        soldier
      );
    }
  }
}

function removeAttackTask(
  state: GameState,
  attack: AttackTask,
  returnAttackers: boolean
): void {
  if (returnAttackers) {
    const attackerIds = new Set(attack.attackerSoldierIds);
    for (const soldier of state.soldiers) {
      if (attackerIds.has(soldier.id)) {
        returnSoldierHome(state, soldier);
      }
    }
  }

  releaseDefenders(state, attack);
  state.activeAttacks = state.activeAttacks.filter((candidate) => candidate.id !== attack.id);
}

function stopCounterAttacksFor(state: GameState, sourceTaskId: string): void {
  for (const counter of state.activeAttacks.filter((attack) => attack.sourceTaskId === sourceTaskId)) {
    removeAttackTask(state, counter, true);
  }
}

export function cancelAttacksForCountry(state: GameState, countryId: number): void {
  for (const attack of [...state.activeAttacks]) {
    if (attack.targetCountryId === countryId || attack.participantCountryIds.includes(countryId)) {
      removeAttackTask(state, attack, true);
      if (attack.kind === "attack") {
        stopCounterAttacksFor(state, attack.id);
      }
    }
  }
}

function cleanupOrphanCounters(state: GameState): void {
  const attackIds = new Set(state.activeAttacks.map((attack) => attack.id));
  for (const counter of state.activeAttacks.filter(
    (attack) => attack.kind === "counter" && attack.sourceTaskId && !attackIds.has(attack.sourceTaskId)
  )) {
    removeAttackTask(state, counter, true);
  }
}

function findMergeableAttack(
  state: GameState,
  kind: AttackKind,
  targetCountryId: number,
  sourceTaskId?: string
): AttackTask | undefined {
  return state.activeAttacks.find(
    (attack) =>
      attack.kind === kind &&
      attack.targetCountryId === targetCountryId &&
      (kind === "attack" || attack.sourceTaskId === sourceTaskId)
  );
}

function getAllAttackSoldierIds(state: GameState): Set<string> {
  return new Set(state.activeAttacks.flatMap((attack) => attack.attackerSoldierIds));
}

function isSoldierInAnyAttack(state: GameState, soldierId: string): boolean {
  return state.activeAttacks.some((attack) => attack.attackerSoldierIds.includes(soldierId));
}

function getSoldierControllerCountryId(state: GameState, soldier: Soldier): number {
  const country = getCountry(state, soldier.countryId);
  return country?.controllerCountryId ?? soldier.countryId;
}

function createAttackId(kind: AttackKind): string {
  return `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
