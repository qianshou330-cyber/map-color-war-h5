import type { Country, GameState, Point } from "../types";
import { distance, pointInPolygon, polygonBounds } from "../utils/geometry";

export type AttackRoute = "land" | "sea";

export function canAttackCountry(
  state: GameState,
  sourceCountry: Country,
  targetCountry: Country
): boolean {
  return getAttackRoute(state, sourceCountry, targetCountry) !== null;
}

export function getAttackRoute(
  state: GameState,
  sourceCountry: Country,
  targetCountry: Country
): AttackRoute | null {
  if (isLandNeighbor(sourceCountry, targetCountry)) {
    return "land";
  }

  if (isSeaReachable(state, sourceCountry, targetCountry)) {
    return "sea";
  }

  return null;
}

export function isLandNeighbor(sourceCountry: Country, targetCountry: Country): boolean {
  return sourceCountry.neighbors.includes(targetCountry.id);
}

export function isSeaReachable(
  state: GameState,
  sourceCountry: Country,
  targetCountry: Country
): boolean {
  if (sourceCountry.landPartId === targetCountry.landPartId) {
    return false;
  }

  return !segmentCrossesOtherCountry(
    state,
    sourceCountry.center,
    targetCountry.center,
    new Set([sourceCountry.id, targetCountry.id])
  );
}

export function segmentCrossesOtherCountry(
  state: GameState,
  from: Point,
  to: Point,
  ignoredCountryIds: Set<number>
): boolean {
  return state.countries.some((country) => {
    if (ignoredCountryIds.has(country.id) || !segmentMayOverlapPolygon(from, to, country.polygon)) {
      return false;
    }

    return segmentPassesThroughPolygon(from, to, country.polygon);
  });
}

function segmentPassesThroughPolygon(from: Point, to: Point, polygon: Point[]): boolean {
  for (let step = 1; step < 24; step += 1) {
    const ratio = step / 24;
    const sample = {
      x: from.x + (to.x - from.x) * ratio,
      y: from.y + (to.y - from.y) * ratio
    };

    if (pointInPolygon(sample, polygon)) {
      return true;
    }
  }

  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];

    if (segmentsIntersect(from, to, current, next)) {
      return true;
    }
  }

  return false;
}

function segmentMayOverlapPolygon(from: Point, to: Point, polygon: Point[]): boolean {
  const bounds = polygonBounds(polygon);
  const minX = Math.min(from.x, to.x);
  const maxX = Math.max(from.x, to.x);
  const minY = Math.min(from.y, to.y);
  const maxY = Math.max(from.y, to.y);

  return !(maxX < bounds.minX || bounds.maxX < minX || maxY < bounds.minY || bounds.maxY < minY);
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const tolerance = 0.001;
  const abC = orientation(a, b, c);
  const abD = orientation(a, b, d);
  const cdA = orientation(c, d, a);
  const cdB = orientation(c, d, b);

  if (abC * abD < -tolerance && cdA * cdB < -tolerance) {
    return true;
  }

  return (
    isPointOnSegment(c, a, b, tolerance) ||
    isPointOnSegment(d, a, b, tolerance) ||
    isPointOnSegment(a, c, d, tolerance) ||
    isPointOnSegment(b, c, d, tolerance)
  );
}

function orientation(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function isPointOnSegment(point: Point, start: Point, end: Point, tolerance: number): boolean {
  if (Math.abs(orientation(start, end, point)) > tolerance) {
    return false;
  }

  return (
    point.x >= Math.min(start.x, end.x) - tolerance &&
    point.x <= Math.max(start.x, end.x) + tolerance &&
    point.y >= Math.min(start.y, end.y) - tolerance &&
    point.y <= Math.max(start.y, end.y) + tolerance &&
    distance(point, start) > tolerance &&
    distance(point, end) > tolerance
  );
}
