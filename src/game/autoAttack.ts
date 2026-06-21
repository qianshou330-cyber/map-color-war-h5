import {
  AUTO_ATTACK_SCHEDULE_MS,
  AUTO_ATTACK_TARGET_COOLDOWN_MS
} from "../constants";
import type { AutoAttackPlan, Country, GameState } from "../types";
import { distance } from "../utils/geometry";
import { getAttackRoute, type AttackRoute } from "./attackRules";
import { startAttack, stopAttackOriginWars } from "./battle";
import { getAliveSoldiersInCountry, getCountry } from "./state";

type TargetCandidate = {
  country: Country;
  route: AttackRoute;
};

export function enableAutoAttackPlan(
  state: GameState,
  controllerCountryId: number,
  now: number
): AutoAttackPlan {
  const existing = getAutoAttackPlan(state, controllerCountryId);
  if (existing) {
    existing.enabled = true;
    existing.lastScheduledAt = now - AUTO_ATTACK_SCHEDULE_MS;
    existing.cooldownTargets = removeExpiredCooldowns(existing, now);
    return existing;
  }

  const plan: AutoAttackPlan = {
    controllerCountryId,
    enabled: true,
    createdAt: now,
    lastScheduledAt: now - AUTO_ATTACK_SCHEDULE_MS,
    originWarIds: [],
    cooldownTargets: []
  };
  state.autoAttackPlans.push(plan);
  return plan;
}

export function disableAutoAttackPlan(
  state: GameState,
  controllerCountryId: number
): number | null {
  const plan = getAutoAttackPlan(state, controllerCountryId);
  if (!plan || !plan.enabled) {
    return null;
  }

  plan.enabled = false;
  const stoppedCount = stopAttackOriginWars(state, plan.originWarIds, true);
  plan.originWarIds = [];
  plan.cooldownTargets = [];
  return stoppedCount;
}

export function addAutoAttackCooldown(
  state: GameState,
  controllerCountryId: number,
  targetCountryId: number,
  now: number
): void {
  const plan = getAutoAttackPlan(state, controllerCountryId);
  if (!plan || !plan.enabled) {
    return;
  }

  const until = now + AUTO_ATTACK_TARGET_COOLDOWN_MS;
  const existing = plan.cooldownTargets.find((target) => target.countryId === targetCountryId);
  if (existing) {
    existing.until = until;
    return;
  }

  plan.cooldownTargets.push({ countryId: targetCountryId, until });
}

export function updateAutoAttacks(state: GameState, now: number): void {
  for (const plan of state.autoAttackPlans) {
    if (!plan.enabled) {
      continue;
    }

    plan.originWarIds = getActiveOriginWarIds(state, plan.originWarIds);
    plan.cooldownTargets = removeExpiredCooldowns(plan, now);
    if (now - plan.lastScheduledAt < AUTO_ATTACK_SCHEDULE_MS) {
      continue;
    }

    plan.lastScheduledAt = now;
    scheduleAutoAttackPlan(state, plan, now);
  }
}

function scheduleAutoAttackPlan(
  state: GameState,
  plan: AutoAttackPlan,
  now: number
): void {
  const sourceCountries = state.countries
    .filter((country) => country.controllerCountryId === plan.controllerCountryId)
    .filter((country) => !isCountryUnderActiveAttack(state, country.id))
    .filter((country) => !isCountryAlreadyAttacking(state, country.id))
    .filter((country) =>
      getAliveSoldiersInCountry(state, country.id).some(
        (soldier) => soldier.status === "wandering"
      )
    )
    .sort((left, right) => left.id - right.id);

  const groupedSources = new Map<number, number[]>();
  for (const sourceCountry of sourceCountries) {
    const target = getBestAutoAttackTarget(state, plan, sourceCountry, now);
    if (!target) {
      continue;
    }

    const sourceIds = groupedSources.get(target.country.id) ?? [];
    sourceIds.push(sourceCountry.id);
    groupedSources.set(target.country.id, sourceIds);
  }

  for (const [targetCountryId, participantCountryIds] of groupedSources) {
    const attack = startAttack(state, participantCountryIds, targetCountryId, now, "attack");
    if (!attack) {
      continue;
    }

    plan.originWarIds = [...new Set([...plan.originWarIds, attack.originWarId])];
  }
}

function getBestAutoAttackTarget(
  state: GameState,
  plan: AutoAttackPlan,
  sourceCountry: Country,
  now: number
): TargetCandidate | null {
  const alliedControllerIds = getAlliedControllerCountryIds(
    state,
    plan.controllerCountryId
  );

  const candidates = state.countries
    .filter((targetCountry) => targetCountry.id !== sourceCountry.id)
    .filter((targetCountry) => targetCountry.controllerCountryId !== plan.controllerCountryId)
    .filter((targetCountry) => !alliedControllerIds.has(targetCountry.controllerCountryId))
    .filter((targetCountry) => !isTargetCoolingDown(plan, targetCountry.id, now))
    .filter((targetCountry) => !isTargetAlreadyUnderActiveAttack(state, targetCountry.id))
    .flatMap((targetCountry): TargetCandidate[] => {
      const route = getAttackRoute(state, sourceCountry, targetCountry);
      return route ? [{ country: targetCountry, route }] : [];
    })
    .sort((left, right) => {
      if (left.route !== right.route) {
        return left.route === "land" ? -1 : 1;
      }

      return (
        distance(sourceCountry.center, left.country.center) -
        distance(sourceCountry.center, right.country.center)
      );
    });

  return candidates[0] ?? null;
}

function getAutoAttackPlan(
  state: GameState,
  controllerCountryId: number
): AutoAttackPlan | undefined {
  return state.autoAttackPlans.find(
    (plan) => plan.controllerCountryId === controllerCountryId
  );
}

function getActiveOriginWarIds(state: GameState, originWarIds: string[]): string[] {
  const activeOriginWarIds = new Set(state.activeAttacks.map((attack) => attack.originWarId));
  return [...new Set(originWarIds)].filter((originWarId) =>
    activeOriginWarIds.has(originWarId)
  );
}

function removeExpiredCooldowns(
  plan: AutoAttackPlan,
  now: number
): AutoAttackPlan["cooldownTargets"] {
  return plan.cooldownTargets.filter((target) => target.until > now);
}

function isCountryUnderActiveAttack(state: GameState, countryId: number): boolean {
  return state.activeAttacks.some(
    (attack) =>
      attack.kind === "attack" &&
      attack.targetCountryId === countryId &&
      attack.attackerSoldierIds.some((soldierId) =>
        state.soldiers.some((soldier) => soldier.id === soldierId && soldier.alive)
      )
  );
}

function isCountryAlreadyAttacking(state: GameState, countryId: number): boolean {
  return state.activeAttacks.some(
    (attack) =>
      attack.kind === "attack" &&
      attack.participantCountryIds.includes(countryId)
  );
}

function isTargetAlreadyUnderActiveAttack(state: GameState, targetCountryId: number): boolean {
  return state.activeAttacks.some(
    (attack) => attack.kind === "attack" && attack.targetCountryId === targetCountryId
  );
}

function isTargetCoolingDown(
  plan: AutoAttackPlan,
  targetCountryId: number,
  now: number
): boolean {
  return plan.cooldownTargets.some(
    (target) => target.countryId === targetCountryId && target.until > now
  );
}

function getAlliedControllerCountryIds(
  state: GameState,
  controllerCountryId: number
): Set<number> {
  const alliedControllerIds = new Set<number>();
  if (!state.alliance) {
    return alliedControllerIds;
  }

  const countryA = getCountry(state, state.alliance.countryAId);
  const countryB = getCountry(state, state.alliance.countryBId);
  if (!countryA || !countryB) {
    return alliedControllerIds;
  }

  if (countryA.controllerCountryId === controllerCountryId) {
    alliedControllerIds.add(countryB.controllerCountryId);
  }
  if (countryB.controllerCountryId === controllerCountryId) {
    alliedControllerIds.add(countryA.controllerCountryId);
  }

  return alliedControllerIds;
}
