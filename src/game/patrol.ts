import type { Country, Point } from "../types";
import { distance, pointInPolygon, randomPointInPolygon } from "../utils/geometry";
import { randomFloat } from "../utils/random";

const BORDER_INSET_RATIOS = [0.12, 0.18, 0.25, 0.36, 0.5, 0.72];

export function randomBorderPatrolPoint(country: Country, from?: Point): Point {
  const polygon = country.polygon;
  if (polygon.length < 3) {
    return { ...country.center };
  }

  const perimeter = polygonPerimeter(polygon);
  if (perimeter < 0.001) {
    return randomPointInPolygon(polygon);
  }

  const targetDistance = from
    ? nextPatrolDistanceFromPoint(polygon, perimeter, from)
    : randomFloat(0, perimeter);
  const edgePoint = pointOnPolygonPerimeter(polygon, targetDistance);
  for (const ratio of BORDER_INSET_RATIOS) {
    const candidate = {
      x: edgePoint.x + (country.center.x - edgePoint.x) * ratio,
      y: edgePoint.y + (country.center.y - edgePoint.y) * ratio
    };

    if (pointInPolygon(candidate, polygon)) {
      return candidate;
    }
  }

  if (pointInPolygon(country.center, polygon)) {
    return { ...country.center };
  }

  return randomPointInPolygon(polygon);
}

function polygonPerimeter(polygon: Point[]): number {
  let perimeter = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    perimeter += distance(polygon[index], polygon[(index + 1) % polygon.length]);
  }
  return perimeter;
}

function pointOnPolygonPerimeter(polygon: Point[], targetDistance: number): Point {
  let traveled = 0;

  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    const segmentLength = distance(current, next);

    if (traveled + segmentLength >= targetDistance) {
      const ratio = segmentLength < 0.001 ? 0 : (targetDistance - traveled) / segmentLength;
      return {
        x: current.x + (next.x - current.x) * ratio,
        y: current.y + (next.y - current.y) * ratio
      };
    }

    traveled += segmentLength;
  }

  return { ...polygon[0] };
}

function nextPatrolDistanceFromPoint(
  polygon: Point[],
  perimeter: number,
  point: Point
): number {
  let traveled = 0;
  let nearestDistanceOnPerimeter = 0;
  let nearestDistanceToEdge = Number.POSITIVE_INFINITY;

  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    const segmentLength = distance(current, next);

    if (segmentLength < 0.001) {
      continue;
    }

    const t = Math.max(
      0,
      Math.min(
        1,
        ((point.x - current.x) * (next.x - current.x) +
          (point.y - current.y) * (next.y - current.y)) /
          segmentLength ** 2
      )
    );
    const projected = {
      x: current.x + (next.x - current.x) * t,
      y: current.y + (next.y - current.y) * t
    };
    const edgeDistance = distance(point, projected);

    if (edgeDistance < nearestDistanceToEdge) {
      nearestDistanceToEdge = edgeDistance;
      nearestDistanceOnPerimeter = traveled + segmentLength * t;
    }

    traveled += segmentLength;
  }

  const direction = randomFloat(0, 1) < 0.5 ? -1 : 1;
  const step = randomFloat(perimeter * 0.06, perimeter * 0.16);
  return wrapDistance(nearestDistanceOnPerimeter + direction * step, perimeter);
}

function wrapDistance(value: number, perimeter: number): number {
  return ((value % perimeter) + perimeter) % perimeter;
}
