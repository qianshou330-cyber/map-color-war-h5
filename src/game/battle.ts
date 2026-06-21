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
import { killSoldier, normalizeSoldierStats, recordSoldierKill } from "./soldiers";

type AttackKind = AttackTask["kind"];
type CounterMetadata = Pick<
  AttackTask,
  "counterControllerCountryId" | "counterTargetControllerCountryId" | "counterRootTargetCountryId"
>;
type WarMetadata = Pick<
  AttackTask,
  | "warId"
  | "originWarId"
  | "rootTargetCountryId"
  | "attackerControllerCountryId"
  | "defenderControllerCountryId"
>;
type DamageCredit = {
  damage: number;
  lastHitAt: number;
  sequence: number;
};

const ATTACK_PHASE_PRIORITY: Record<AttackTask["phase"], number> = {
  fighting: 0,
  painting: 1,
  moving: 2
};

const soldierDamageCredits = new Map<string, Map<string, DamageCredit>>();
let damageCreditSequence = 0;

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
  const counterMetadata = createCounterMetadata(
    state,
    kind,
    uniqueParticipantIds,
    targetCountry,
    sourceTaskId
  );
  const attackers = uniqueParticipantIds.flatMap((countryId) => {
    if (shouldHoldCounterRecruitmentForCountry(state, kind, countryId)) {
      return [];
    }

    return selectAttackersFromCountry(state, countryId, targetCountry);
  });
  const existingAttack = findMergeableAttack(state, kind, targetCountryId, sourceTaskId);
  const warMetadata = createWarMetadata(
    state,
    kind,
    uniqueParticipantIds,
    targetCountry,
    sourceTaskId,
    counterMetadata,
    existingAttack
  );

  if (attackers.length === 0) {
    if (kind !== "counter" || uniqueParticipantIds.length === 0) {
      return null;
    }

    if (existingAttack) {
      return existingAttack;
    }

    const waitingCounterAttack: AttackTask = {
      id: createAttackId(kind),
      ...warMetadata,
      sourceTaskId,
      kind,
      ...counterMetadata,
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
    Object.assign(existingAttack, counterMetadata);
    ensureAttackHasWarMetadata(existingAttack, warMetadata);

    if (kind === "attack") {
      ensureCounterAttackTask(state, existingAttack, now);
    }

    return existingAttack;
  }

  const attack: AttackTask = {
    id: createAttackId(kind),
    ...warMetadata,
    sourceTaskId,
    kind,
    ...counterMetadata,
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

function createCounterMetadata(
  state: GameState,
  kind: AttackKind,
  participantCountryIds: number[],
  targetCountry: Country,
  sourceTaskId?: string
): CounterMetadata {
  if (kind !== "counter") {
    return {};
  }

  const sourceAttack = sourceTaskId
    ? state.activeAttacks.find((attack) => attack.id === sourceTaskId)
    : undefined;

  return {
    counterControllerCountryId: getNearestParticipantControllerCountryId(
      state,
      participantCountryIds,
      targetCountry.id
    ),
    counterTargetControllerCountryId: targetCountry.controllerCountryId,
    counterRootTargetCountryId: sourceAttack?.targetCountryId
  };
}

function createWarMetadata(
  state: GameState,
  kind: AttackKind,
  participantCountryIds: number[],
  targetCountry: Country,
  sourceTaskId: string | undefined,
  counterMetadata: CounterMetadata,
  existingAttack?: AttackTask
): WarMetadata {
  if (existingAttack) {
    return {
      warId: existingAttack.warId,
      originWarId: existingAttack.originWarId,
      rootTargetCountryId: existingAttack.rootTargetCountryId,
      attackerControllerCountryId: existingAttack.attackerControllerCountryId,
      defenderControllerCountryId: existingAttack.defenderControllerCountryId
    };
  }

  const sourceAttack = sourceTaskId
    ? state.activeAttacks.find((attack) => attack.id === sourceTaskId)
    : undefined;
  const warId = createWarId(kind);
  const attackerControllerCountryId =
    kind === "counter"
      ? (counterMetadata.counterControllerCountryId ??
        getNearestParticipantControllerCountryId(state, participantCountryIds, targetCountry.id))
      : getNearestParticipantControllerCountryId(state, participantCountryIds, targetCountry.id);
  const defenderControllerCountryId =
    kind === "counter"
      ? (counterMetadata.counterTargetControllerCountryId ?? targetCountry.controllerCountryId)
      : targetCountry.controllerCountryId;

  return {
    warId,
    originWarId: kind === "counter" ? (sourceAttack?.originWarId ?? sourceAttack?.warId ?? warId) : warId,
    rootTargetCountryId:
      kind === "counter"
        ? (sourceAttack?.rootTargetCountryId ?? sourceAttack?.targetCountryId ?? targetCountry.id)
        : targetCountry.id,
    attackerControllerCountryId,
    defenderControllerCountryId
  };
}

function ensureAttackHasWarMetadata(attack: AttackTask, metadata: WarMetadata): void {
  attack.warId ||= metadata.warId;
  attack.originWarId ||= metadata.originWarId;
  attack.rootTargetCountryId ||= metadata.rootTargetCountryId;
  attack.attackerControllerCountryId ||= metadata.attackerControllerCountryId;
  attack.defenderControllerCountryId ||= metadata.defenderControllerCountryId;
}

export function updateBattle(state: GameState, now: number): void {
  pruneDamageCredits(state);

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

function pruneDamageCredits(state: GameState): void {
  const knownSoldierIds = new Set([
    ...state.soldiers.map((soldier) => soldier.id),
    ...state.deadSoldiers.map((dead) => dead.soldier.id)
  ]);

  for (const targetSoldierId of [...soldierDamageCredits.keys()]) {
    if (!knownSoldierIds.has(targetSoldierId)) {
      soldierDamageCredits.delete(targetSoldierId);
      continue;
    }

    const credits = soldierDamageCredits.get(targetSoldierId);
    if (!credits) {
      continue;
    }

    for (const attackerSoldierId of [...credits.keys()]) {
      if (!knownSoldierIds.has(attackerSoldierId)) {
        credits.delete(attackerSoldierId);
      }
    }

    if (credits.size === 0) {
      soldierDamageCredits.delete(targetSoldierId);
    }
  }
}

export function hasAttackAgainstTarget(
  state: GameState,
  targetCountryId: number,
  participantCountryIds?: number[],
  controllerCountryId?: number | null
): boolean {
  return getOriginWarIdsForTarget(
    state,
    targetCountryId,
    participantCountryIds,
    controllerCountryId
  ).size > 0;
}

export function stopAttack(
  state: GameState,
  targetCountryId: number,
  participantCountryIds?: number[],
  controllerCountryId?: number | null
): boolean {
  const originWarIds = getOriginWarIdsForTarget(
    state,
    targetCountryId,
    participantCountryIds,
    controllerCountryId
  );
  if (originWarIds.size === 0) {
    return false;
  }

  for (const originWarId of originWarIds) {
    removeAttackChainByOriginWarId(state, originWarId, true);
  }

  cleanupOrphanCounters(state);
  return true;
}

export function stopAttackOriginWars(
  state: GameState,
  originWarIds: string[],
  returnAttackers = true
): number {
  const uniqueOriginWarIds = [...new Set(originWarIds)];
  let stoppedCount = 0;

  for (const originWarId of uniqueOriginWarIds) {
    if (state.activeAttacks.some((attack) => attack.originWarId === originWarId)) {
      stoppedCount += 1;
    }
    removeAttackChainByOriginWarId(state, originWarId, returnAttackers);
  }

  cleanupOrphanCounters(state);
  return stoppedCount;
}

function getOriginWarIdsForTarget(
  state: GameState,
  targetCountryId: number,
  participantCountryIds?: number[],
  controllerCountryId?: number | null
): Set<string> {
  const originWarIds = new Set<string>();
  for (const attack of state.activeAttacks) {
    const participantMatches =
      !participantCountryIds ||
      attack.participantCountryIds.some((countryId) => participantCountryIds.includes(countryId));
    const controllerMatches =
      controllerCountryId === undefined ||
      controllerCountryId === null ||
      attack.defenderControllerCountryId === controllerCountryId ||
      attack.counterTargetControllerCountryId === controllerCountryId;
    const directAttackMatches =
      attack.kind === "attack" &&
      attack.targetCountryId === targetCountryId &&
      participantMatches;
    const rootWarMatches =
      attack.rootTargetCountryId === targetCountryId &&
      controllerMatches &&
      (attack.kind === "counter" || participantMatches);
    const legacyCounterMatches =
      attack.kind === "counter" &&
      attack.counterRootTargetCountryId === targetCountryId &&
      controllerMatches;

    if (directAttackMatches || rootWarMatches || legacyCounterMatches) {
      originWarIds.add(attack.originWarId);
    }
  }

  return originWarIds;
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
        stopCounterAttacksForOriginWar(state, attack.originWarId);
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

function retargetCounterAttackIfNeeded(
  state: GameState,
  attack: AttackTask,
  now: number
): boolean {
  const counterControllerCountryId = attack.counterControllerCountryId ?? attack.conquerorCountryId;
  const targetControllerCountryId = attack.counterTargetControllerCountryId;
  if (!targetControllerCountryId) {
    return true;
  }

  const currentTarget = getCountry(state, attack.targetCountryId);
  if (
    currentTarget &&
    currentTarget.controllerCountryId === targetControllerCountryId &&
    syncCounterParticipantsForTarget(state, attack, currentTarget, counterControllerCountryId)
  ) {
    attack.conquerorCountryId = counterControllerCountryId;
    return true;
  }

  const nextTarget = findNextCounterTargetCountry(
    state,
    counterControllerCountryId,
    targetControllerCountryId
  );
  if (!nextTarget) {
    return false;
  }

  attack.sourceTaskId = undefined;
  attack.targetCountryId = nextTarget.id;
  attack.conquerorCountryId = counterControllerCountryId;
  attack.phase = "moving";
  attack.lastBattleAt = now;

  if (!syncCounterParticipantsForTarget(state, attack, nextTarget, counterControllerCountryId)) {
    return false;
  }

  retargetAttackers(state, attack);
  return true;
}

function syncCounterParticipantsForTarget(
  state: GameState,
  attack: AttackTask,
  targetCountry: Country,
  counterControllerCountryId: number
): boolean {
  const reachableSourceIds = state.countries
    .filter(
      (country) =>
        country.id !== targetCountry.id &&
        country.controllerCountryId === counterControllerCountryId &&
        canAttackCountry(state, country, targetCountry)
    )
    .map((country) => country.id);

  if (reachableSourceIds.length === 0) {
    return false;
  }

  attack.participantCountryIds = [...new Set([...attack.participantCountryIds, ...reachableSourceIds])]
    .filter((countryId) => reachableSourceIds.includes(countryId));
  attack.attackerSoldierIds = attack.attackerSoldierIds.filter((soldierId) => {
    const countryId =
      state.soldiers.find((candidate) => candidate.id === soldierId)?.countryId ??
      state.deadSoldiers.find((dead) => dead.soldier.id === soldierId)?.soldier.countryId;
    const country = countryId ? getCountry(state, countryId) : undefined;
    return Boolean(country && attack.participantCountryIds.includes(country.id));
  });

  return true;
}

function findNextCounterTargetCountry(
  state: GameState,
  counterControllerCountryId: number,
  targetControllerCountryId: number
): Country | undefined {
  const sourceCountries = state.countries.filter(
    (country) => country.controllerCountryId === counterControllerCountryId
  );
  const candidates = state.countries.filter(
    (country) =>
      country.controllerCountryId === targetControllerCountryId &&
      sourceCountries.some((sourceCountry) => canAttackCountry(state, sourceCountry, country))
  );

  return candidates.sort(
    (left, right) =>
      getNearestDistanceFromSources(sourceCountries, left) -
      getNearestDistanceFromSources(sourceCountries, right)
  )[0];
}

function getNearestDistanceFromSources(sourceCountries: Country[], targetCountry: Country): number {
  return sourceCountries.reduce(
    (bestDistance, sourceCountry) =>
      Math.min(bestDistance, distance(sourceCountry.center, targetCountry.center)),
    Number.POSITIVE_INFINITY
  );
}

function retargetAttackers(state: GameState, attack: AttackTask): void {
  const attackerIds = new Set(attack.attackerSoldierIds);
  for (const soldier of state.soldiers) {
    if (!attackerIds.has(soldier.id)) {
      continue;
    }

    soldier.status = "attacking";
    soldier.target = getNextPaintTarget(
      state,
      attack.targetCountryId,
      attack.conquerorCountryId,
      soldier
    );
  }
}

function updateAttackTask(state: GameState, attack: AttackTask, now: number): void {
  if (attack.kind === "counter" && !retargetCounterAttackIfNeeded(state, attack, now)) {
    removeAttackTask(state, attack, true);
    return;
  }

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
      enterPaintingPhaseAndPaint(state, attack);
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
    enterPaintingPhaseAndPaint(state, attack);
    return;
  }

  const aliveSoldiersById = new Map(state.soldiers.map((soldier) => [soldier.id, soldier]));
  const damageByTarget = new Map<string, { target: Soldier; damage: number }>();

  queueGroupDamage(attackers, defenders, damageByTarget, now);
  queueGroupDamage(defenders, attackers, damageByTarget, now);

  for (const { target, damage } of damageByTarget.values()) {
    if (!target.alive) {
      continue;
    }
    normalizeSoldierStats(target);
    target.hp = Math.max(0, target.hp - damage);
  }

  const deadSoldiers = [...damageByTarget.values()]
    .map((entry) => entry.target)
    .filter((soldier, index, list) => soldier.hp <= 0 && list.findIndex((item) => item.id === soldier.id) === index);
  const attackerIds = new Set(attackers.map((soldier) => soldier.id));

  for (const deadSoldier of deadSoldiers) {
    const killer = getTopDamageDealer(deadSoldier.id, aliveSoldiersById);
    if (killer) {
      recordSoldierKill(killer, now);
    }
  }

  for (const deadSoldier of deadSoldiers) {
    if (!deadSoldier.alive) {
      continue;
    }

    if (attackerIds.has(deadSoldier.id)) {
      paintProvinceAtPoint(
        state,
        attack.targetCountryId,
        { x: deadSoldier.x, y: deadSoldier.y },
        attack.conquerorCountryId
      );
    }

    killSoldier(state, deadSoldier, now);
    clearDamageCreditsForDeadSoldier(deadSoldier.id);
  }

  const targetCountry = getCountry(state, attack.targetCountryId);
  if (targetCountry && isCountryFullyPaintedBy(targetCountry, attack.conquerorCountryId)) {
    annexTarget(state, attack);
  } else if (getDefenders(state, attack).length === 0) {
    enterPaintingPhaseAndPaint(state, attack);
  } else if (getAttackers(state, attack).length === 0) {
    attack.phase = "moving";
    releaseDefenders(state, attack);
  }
}

function queueGroupDamage(
  attackers: Soldier[],
  targets: Soldier[],
  damageByTarget: Map<string, { target: Soldier; damage: number }>,
  now: number
): void {
  if (targets.length === 0) {
    return;
  }

  for (const attacker of attackers) {
    if (!attacker.alive) {
      continue;
    }

    normalizeSoldierStats(attacker);
    const target = selectCombatTarget(attacker, targets);
    if (!target) {
      continue;
    }

    const damage = attacker.attackPower;
    const queued = damageByTarget.get(target.id);
    if (queued) {
      queued.damage += damage;
    } else {
      damageByTarget.set(target.id, { target, damage });
    }
    recordDamageCredit(target.id, attacker.id, damage, now);
  }
}

function selectCombatTarget(attacker: Soldier, targets: Soldier[]): Soldier | null {
  return [...targets]
    .filter((target) => target.alive)
    .sort((left, right) => {
      const leftDistance = distance({ x: attacker.x, y: attacker.y }, { x: left.x, y: left.y });
      const rightDistance = distance({ x: attacker.x, y: attacker.y }, { x: right.x, y: right.y });
      if (leftDistance !== rightDistance) {
        return leftDistance - rightDistance;
      }
      if (left.hp !== right.hp) {
        return left.hp - right.hp;
      }
      return left.id.localeCompare(right.id);
    })[0] ?? null;
}

function recordDamageCredit(
  targetSoldierId: string,
  attackerSoldierId: string,
  damage: number,
  now: number
): void {
  let targetCredits = soldierDamageCredits.get(targetSoldierId);
  if (!targetCredits) {
    targetCredits = new Map();
    soldierDamageCredits.set(targetSoldierId, targetCredits);
  }

  const previous = targetCredits.get(attackerSoldierId);
  targetCredits.set(attackerSoldierId, {
    damage: (previous?.damage ?? 0) + damage,
    lastHitAt: now,
    sequence: ++damageCreditSequence
  });
}

function getTopDamageDealer(
  targetSoldierId: string,
  aliveSoldiersById: Map<string, Soldier>
): Soldier | null {
  const targetCredits = soldierDamageCredits.get(targetSoldierId);
  if (!targetCredits) {
    return null;
  }

  const topCredit = [...targetCredits.entries()]
    .filter(([attackerId]) => aliveSoldiersById.has(attackerId))
    .sort((left, right) => {
      const leftCredit = left[1];
      const rightCredit = right[1];
      if (leftCredit.damage !== rightCredit.damage) {
        return rightCredit.damage - leftCredit.damage;
      }
      if (leftCredit.lastHitAt !== rightCredit.lastHitAt) {
        return rightCredit.lastHitAt - leftCredit.lastHitAt;
      }
      if (leftCredit.sequence !== rightCredit.sequence) {
        return rightCredit.sequence - leftCredit.sequence;
      }
      return left[0].localeCompare(right[0]);
    })[0];

  return topCredit ? aliveSoldiersById.get(topCredit[0]) ?? null : null;
}

function clearDamageCreditsForDeadSoldier(soldierId: string): void {
  soldierDamageCredits.delete(soldierId);
  for (const targetCredits of soldierDamageCredits.values()) {
    targetCredits.delete(soldierId);
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

  normalizeCountryPaint(targetCountry);

  if (attack.kind === "counter" && retargetCounterAttackIfNeeded(state, attack, performance.now())) {
    const excludedAttackIds = new Set([attack.id]);
    cancelAttacksForCountry(state, targetCountry.id, excludedAttackIds);
    cleanupOrphanCounters(state);
    joinOngoingAttacksFromNewCountry(state, targetCountry, attack.conquerorCountryId);
    recruitAttackersForTask(state, attack);
    return;
  }

  const originWarId = attack.originWarId;
  removeAttackTask(state, attack, false);
  stopCounterAttacksForOriginWar(state, originWarId);
  cancelAttacksForCountry(state, targetCountry.id);
  cleanupOrphanCounters(state);
  joinOngoingAttacksFromNewCountry(state, targetCountry, attack.conquerorCountryId);
}

function joinOngoingAttacksFromNewCountry(
  state: GameState,
  newCountry: Country,
  controllerCountryId: number
): void {
  const supportedAttacks = getSupportedAttacksForCountry(
    state,
    newCountry,
    controllerCountryId
  );
  if (supportedAttacks.length === 0) {
    return;
  }

  for (const attack of supportedAttacks) {
    attack.participantCountryIds = [...new Set([...attack.participantCountryIds, newCountry.id])];
  }

  recruitAttackersForTask(state, supportedAttacks[0], [newCountry.id]);
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

function recruitAttackersForTask(
  state: GameState,
  attack: AttackTask,
  countryIds?: number[]
): void {
  const targetCountry = getCountry(state, attack.targetCountryId);
  if (!targetCountry) {
    return;
  }

  cleanupDeadAttackersForTask(state, attack);
  const recruitCountryIds = countryIds ?? attack.participantCountryIds;
  const recruitedAttackers = recruitCountryIds.flatMap((countryId) => {
    if (!attack.participantCountryIds.includes(countryId)) {
      return [];
    }

    if (shouldHoldCounterRecruitmentForCountry(state, attack.kind, countryId)) {
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
    removeSoldierFromOtherAttacks(state, soldier.id, attack.id);
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

  return sourceSoldiers
    .sort(
      (a, b) =>
        distance({ x: a.x, y: a.y }, targetCountry.center) -
        distance({ x: b.x, y: b.y }, targetCountry.center)
    );
}

function shouldHoldCounterRecruitmentForCountry(
  state: GameState,
  kind: AttackKind,
  countryId: number
): boolean {
  if (kind !== "counter") {
    return false;
  }

  return state.activeAttacks.some(
    (attack) =>
      attack.kind === "attack" &&
      attack.targetCountryId === countryId &&
      getAttackers(state, attack).length > 0
  );
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

export function assignRevivedSoldiersToLatestBattles(
  state: GameState,
  soldiers: Soldier[]
): void {
  for (const soldier of soldiers) {
    assignSoldierToLatestSupportedAttack(state, soldier);
  }
}

function assignSoldierToLatestSupportedAttack(
  state: GameState,
  soldier: Soldier
): boolean {
  if (!soldier.alive || soldier.status !== "wandering") {
    return false;
  }

  const country = getCountry(state, soldier.countryId);
  if (!country) {
    return false;
  }

  const controllerCountryId = country.controllerCountryId;
  const attack = getLatestSupportedAttackForCountry(state, country, controllerCountryId);
  if (!attack) {
    return false;
  }

  attack.participantCountryIds = [...new Set([...attack.participantCountryIds, country.id])];
  removeSoldierFromOtherAttacks(state, soldier.id, attack.id);
  attack.attackerSoldierIds = [...new Set([...attack.attackerSoldierIds, soldier.id])];
  attack.conquerorCountryId = getNearestParticipantControllerCountryId(
    state,
    attack.participantCountryIds,
    attack.targetCountryId
  );
  soldier.owner = country.owner;
  soldier.status = "attacking";
  soldier.target = getNextPaintTarget(
    state,
    attack.targetCountryId,
    attack.conquerorCountryId,
    soldier
  );
  return true;
}

function getLatestSupportedAttackForCountry(
  state: GameState,
  country: Country,
  controllerCountryId: number
): AttackTask | undefined {
  return getSupportedAttacksForCountry(state, country, controllerCountryId)[0];
}

function getSupportedAttacksForCountry(
  state: GameState,
  country: Country,
  controllerCountryId: number
): AttackTask[] {
  return state.activeAttacks
    .filter((attack) => {
      const targetCountry = getCountry(state, attack.targetCountryId);
      return Boolean(
        targetCountry &&
        targetCountry.id !== country.id &&
        targetCountry.controllerCountryId !== controllerCountryId &&
        isAttackSupportedByController(state, attack, controllerCountryId)
      );
    })
    .sort(compareAttackUrgency);
}

function compareAttackUrgency(left: AttackTask, right: AttackTask): number {
  const phaseDelta = ATTACK_PHASE_PRIORITY[left.phase] - ATTACK_PHASE_PRIORITY[right.phase];
  if (phaseDelta !== 0) {
    return phaseDelta;
  }

  if (left.startedAt !== right.startedAt) {
    return right.startedAt - left.startedAt;
  }

  if (left.lastBattleAt !== right.lastBattleAt) {
    return right.lastBattleAt - left.lastBattleAt;
  }

  return right.id.localeCompare(left.id);
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

function cleanupDeadAttackersForTask(state: GameState, attack: AttackTask): void {
  const aliveSoldierIds = new Set(
    state.soldiers.filter((soldier) => soldier.alive).map((soldier) => soldier.id)
  );
  attack.attackerSoldierIds = attack.attackerSoldierIds.filter((soldierId) =>
    aliveSoldierIds.has(soldierId)
  );
}

function removeSoldierFromOtherAttacks(
  state: GameState,
  soldierId: string,
  keepAttackId: string
): void {
  for (const attack of state.activeAttacks) {
    if (attack.id === keepAttackId) {
      continue;
    }

    attack.attackerSoldierIds = attack.attackerSoldierIds.filter((id) => id !== soldierId);
  }
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

function enterPaintingPhaseAndPaint(state: GameState, attack: AttackTask): void {
  enterPaintingPhase(state, attack);
  if (!state.activeAttacks.includes(attack) || attack.phase !== "painting") {
    return;
  }

  retargetPainters(state, attack);
  paintAttackersInTarget(state, attack);

  const targetCountry = getCountry(state, attack.targetCountryId);
  if (targetCountry && isCountryFullyPaintedBy(targetCountry, attack.conquerorCountryId)) {
    annexTarget(state, attack);
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

function stopCounterAttacksFor(
  state: GameState,
  sourceTaskId: string,
  excludedAttackIds = new Set<string>()
): void {
  for (const counter of state.activeAttacks.filter((attack) => attack.sourceTaskId === sourceTaskId)) {
    if (excludedAttackIds.has(counter.id)) {
      continue;
    }
    removeAttackTask(state, counter, true);
  }
}

function stopCounterAttacksForOriginWar(
  state: GameState,
  originWarId: string,
  excludedAttackIds = new Set<string>()
): void {
  for (const counter of state.activeAttacks.filter(
    (attack) => attack.kind === "counter" && attack.originWarId === originWarId
  )) {
    if (excludedAttackIds.has(counter.id)) {
      continue;
    }
    removeAttackTask(state, counter, true);
  }
}

function removeAttackChainByOriginWarId(
  state: GameState,
  originWarId: string,
  returnAttackers: boolean,
  excludedAttackIds = new Set<string>()
): void {
  for (const attack of [...state.activeAttacks]) {
    if (attack.originWarId !== originWarId || excludedAttackIds.has(attack.id)) {
      continue;
    }
    removeAttackTask(state, attack, returnAttackers);
  }
}

export function cancelAttacksForCountry(
  state: GameState,
  countryId: number,
  excludedAttackIds = new Set<string>()
): void {
  for (const attack of [...state.activeAttacks]) {
    if (excludedAttackIds.has(attack.id)) {
      continue;
    }

    if (attack.targetCountryId === countryId || attack.participantCountryIds.includes(countryId)) {
      if (attack.kind === "attack") {
        removeAttackChainByOriginWarId(state, attack.originWarId, true, excludedAttackIds);
      } else {
        removeAttackTask(state, attack, true);
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

function createWarId(kind: AttackKind): string {
  const prefix = kind === "counter" ? "counter-war" : "war";
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
