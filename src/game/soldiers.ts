import {
  MINOTAUR_ATTACK_POWER,
  MINOTAUR_KILL_THRESHOLD,
  MINOTAUR_MAX_HP,
  MINOTAUR_REVIVE_MS,
  SOLDIER_ATTACK_POWER,
  SOLDIER_HP_REGEN_MS,
  SOLDIER_MAX_HP,
  SOLDIER_REVIVE_MS,
  SOLDIER_SPEED,
  ATTACK_SOLDIER_SPEED,
  SOLDIER_MOVEMENT_MAX_DELTA_MS,
  SOLDIER_MOVEMENT_STEP_MS
} from "../constants";
import type { GameState, Soldier } from "../types";
import {
  clampPointToPolygon,
  moveToward,
  pointInPolygon,
  randomPointInPolygon
} from "../utils/geometry";
import { randomBorderPatrolPoint } from "./patrol";
import { getSpawnProvince, randomPointInProvince } from "./provinces";
import { createSoldier, getCountry, getCountryPopulationCount } from "./state";

export function updateSoldiers(state: GameState, deltaMs: number): void {
  const movementMs = Math.min(deltaMs, SOLDIER_MOVEMENT_MAX_DELTA_MS);
  const steps = Math.max(1, Math.ceil(movementMs / SOLDIER_MOVEMENT_STEP_MS));
  const stepSeconds = movementMs / steps / 1000;

  for (const soldier of state.soldiers) {
    if (!soldier.alive || soldier.status === "fighting") {
      continue;
    }

    const country = getCountry(state, soldier.countryId);
    if (!country) {
      continue;
    }

    for (let step = 0; step < steps; step += 1) {
      const speed =
        soldier.status === "attacking" || soldier.status === "returning"
          ? ATTACK_SOLDIER_SPEED
          : SOLDIER_SPEED;
      const moved = moveToward(
        { x: soldier.x, y: soldier.y },
        soldier.target,
        speed * stepSeconds
      );

      const nextPoint =
        soldier.status === "wandering"
          ? clampPointToPolygon(moved.point, country.polygon)
          : moved.point;
      soldier.x = nextPoint.x;
      soldier.y = nextPoint.y;

      if (moved.arrived && soldier.status === "wandering") {
        soldier.target = randomBorderPatrolPoint(country, soldier);
      }

      if (moved.arrived && soldier.status === "returning") {
        soldier.status = "wandering";
        soldier.target = randomBorderPatrolPoint(country, soldier);
      }
    }
  }
}

export function killSoldier(state: GameState, soldier: Soldier, now: number): void {
  normalizeSoldierStats(soldier);
  soldier.alive = false;
  state.soldiers = state.soldiers.filter((candidate) => candidate.id !== soldier.id);
  state.deadSoldiers.push({
    soldier: {
      ...soldier,
      hp: 0,
      status: "wandering",
      alive: false
    },
    reviveAt: now + getSoldierReviveMs(soldier)
  });
}

export function reviveSoldiers(state: GameState, now: number): void {
  const waiting = [];

  for (const dead of state.deadSoldiers) {
    if (dead.reviveAt > now) {
      waiting.push(dead);
      continue;
    }

    const country = getCountry(state, dead.soldier.countryId);
    if (!country || getCountryPopulationCount(state, country.id) > country.defaultSoldierCap) {
      waiting.push({
        ...dead,
        reviveAt: now + 500
      });
      continue;
    }

    const spawnProvince = getSpawnProvince(country);
    const position = spawnProvince
      ? randomPointInProvince(spawnProvince)
      : randomPointInPolygon(country.polygon);
    const target = randomBorderPatrolPoint(country);
    const revivedSoldier = {
      ...dead.soldier,
      owner: country.owner,
      x: position.x,
      y: position.y,
      target,
      alive: true,
      status: "wandering" as const
    };
    normalizeSoldierStats(revivedSoldier);
    state.soldiers.push({
      ...revivedSoldier,
      hp: revivedSoldier.maxHp,
      lastHpRegenAt: now
    });
  }

  state.deadSoldiers = waiting;
}

export function regenerateSoldiers(state: GameState, now: number): void {
  for (const soldier of state.soldiers) {
    if (!soldier.alive) {
      continue;
    }

    normalizeSoldierStats(soldier);
    const elapsed = now - soldier.lastHpRegenAt;
    if (elapsed < SOLDIER_HP_REGEN_MS) {
      continue;
    }

    const regenTicks = Math.floor(elapsed / SOLDIER_HP_REGEN_MS);
    soldier.lastHpRegenAt += regenTicks * SOLDIER_HP_REGEN_MS;
    if (soldier.hp < soldier.maxHp) {
      soldier.hp = Math.min(soldier.maxHp, soldier.hp + regenTicks);
    }
  }
}

export function recordSoldierKill(soldier: Soldier, now: number): void {
  normalizeSoldierStats(soldier);
  soldier.killCount += 1;
  if (soldier.rank === "normal" && soldier.killCount >= MINOTAUR_KILL_THRESHOLD) {
    soldier.rank = "minotaur";
    soldier.maxHp = MINOTAUR_MAX_HP;
    soldier.attackPower = MINOTAUR_ATTACK_POWER;
    soldier.hp = Math.min(soldier.hp, soldier.maxHp);
    soldier.lastHpRegenAt = now;
  }
}

export function normalizeSoldierStats(soldier: Soldier): void {
  const rank = soldier.rank ?? "normal";
  soldier.rank = rank;
  soldier.maxHp = rank === "minotaur" ? MINOTAUR_MAX_HP : SOLDIER_MAX_HP;
  soldier.attackPower = rank === "minotaur" ? MINOTAUR_ATTACK_POWER : SOLDIER_ATTACK_POWER;
  soldier.killCount = soldier.killCount ?? 0;
  soldier.lastHpRegenAt = soldier.lastHpRegenAt ?? performance.now();
  soldier.hp = Math.max(0, Math.min(soldier.hp ?? soldier.maxHp, soldier.maxHp));
}

function getSoldierReviveMs(soldier: Soldier): number {
  return soldier.rank === "minotaur" ? MINOTAUR_REVIVE_MS : SOLDIER_REVIVE_MS;
}

export function ensureSoldierInsideCountry(state: GameState, soldier: Soldier): void {
  const country = getCountry(state, soldier.countryId);
  if (!country || pointInPolygon({ x: soldier.x, y: soldier.y }, country.polygon)) {
    return;
  }

  const point = randomPointInPolygon(country.polygon);
  soldier.x = point.x;
  soldier.y = point.y;
  soldier.target = randomBorderPatrolPoint(country);
}

export function fillCountryToCap(state: GameState, countryId: number): void {
  const country = getCountry(state, countryId);
  if (!country) {
    return;
  }

  while (getCountryPopulationCount(state, countryId) < country.defaultSoldierCap) {
    const sequence = state.soldiers.length + state.deadSoldiers.length + 1;
    state.soldiers.push(createSoldier(country, country.owner, sequence));
  }
}
