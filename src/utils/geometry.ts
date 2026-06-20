import polygonClipping, {
  type MultiPolygon as ClippingMultiPolygon,
  type Polygon as ClippingPolygon
} from "polygon-clipping";
import type { Point } from "../types";
import { randomFloat } from "./random";

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function polygonArea(polygon: Point[]): number {
  return Math.abs(signedPolygonArea(polygon));
}

export function signedPolygonArea(polygon: Point[]): number {
  let sum = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const current = polygon[i];
    const next = polygon[(i + 1) % polygon.length];
    sum += current.x * next.y - next.x * current.y;
  }
  return sum / 2;
}

export function polygonCentroid(polygon: Point[]): Point {
  let areaTwice = 0;
  let x = 0;
  let y = 0;

  for (let i = 0; i < polygon.length; i += 1) {
    const current = polygon[i];
    const next = polygon[(i + 1) % polygon.length];
    const cross = current.x * next.y - next.x * current.y;
    areaTwice += cross;
    x += (current.x + next.x) * cross;
    y += (current.y + next.y) * cross;
  }

  if (Math.abs(areaTwice) < 0.001) {
    return averagePoint(polygon);
  }

  return {
    x: x / (3 * areaTwice),
    y: y / (3 * areaTwice)
  };
}

export function averagePoint(points: Point[]): Point {
  const total = points.reduce(
    (acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y }),
    { x: 0, y: 0 }
  );
  return {
    x: total.x / points.length,
    y: total.y / points.length
  };
}

export function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const pi = polygon[i];
    const pj = polygon[j];
    const intersects =
      pi.y > point.y !== pj.y > point.y &&
      point.x < ((pj.x - pi.x) * (point.y - pi.y)) / (pj.y - pi.y) + pi.x;
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

export function polygonBounds(polygon: Point[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  return polygon.reduce(
    (bounds, point) => ({
      minX: Math.min(bounds.minX, point.x),
      minY: Math.min(bounds.minY, point.y),
      maxX: Math.max(bounds.maxX, point.x),
      maxY: Math.max(bounds.maxY, point.y)
    }),
    {
      minX: Number.POSITIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY
    }
  );
}

export function randomPointInPolygon(polygon: Point[]): Point {
  const bounds = polygonBounds(polygon);
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const point = {
      x: randomFloat(bounds.minX, bounds.maxX),
      y: randomFloat(bounds.minY, bounds.maxY)
    };
    if (pointInPolygon(point, polygon)) {
      return point;
    }
  }

  return polygonCentroid(polygon);
}

export function moveToward(
  point: Point,
  target: Point,
  distanceToMove: number
): { point: Point; arrived: boolean } {
  const totalDistance = distance(point, target);
  if (totalDistance <= distanceToMove || totalDistance < 0.001) {
    return {
      point: { ...target },
      arrived: true
    };
  }

  const ratio = distanceToMove / totalDistance;
  return {
    point: {
      x: point.x + (target.x - point.x) * ratio,
      y: point.y + (target.y - point.y) * ratio
    },
    arrived: false
  };
}

export function clampPointToPolygon(point: Point, polygon: Point[]): Point {
  if (pointInPolygon(point, polygon)) {
    return point;
  }

  const center = polygonCentroid(polygon);
  let low = 0;
  let high = 1;
  let best = center;

  for (let i = 0; i < 14; i += 1) {
    const mid = (low + high) / 2;
    const candidate = {
      x: center.x + (point.x - center.x) * mid,
      y: center.y + (point.y - center.y) * mid
    };

    if (pointInPolygon(candidate, polygon)) {
      best = candidate;
      low = mid;
    } else {
      high = mid;
    }
  }

  return best;
}

export function clipPolygonToConvexPolygon(subject: Point[], clip: Point[]): Point[] {
  if (subject.length < 3 || clip.length < 3) {
    return [];
  }

  const orientation = signedPolygonArea(clip) >= 0 ? 1 : -1;
  let output = subject;

  for (let i = 0; i < clip.length; i += 1) {
    const edgeStart = clip[i];
    const edgeEnd = clip[(i + 1) % clip.length];
    const input = output;
    output = [];

    if (input.length === 0) {
      break;
    }

    let previous = input[input.length - 1];
    for (const current of input) {
      const currentInside = isInsideClipEdge(current, edgeStart, edgeEnd, orientation);
      const previousInside = isInsideClipEdge(previous, edgeStart, edgeEnd, orientation);

      if (currentInside) {
        if (!previousInside) {
          output.push(lineIntersection(previous, current, edgeStart, edgeEnd));
        }
        output.push(current);
      } else if (previousInside) {
        output.push(lineIntersection(previous, current, edgeStart, edgeEnd));
      }

      previous = current;
    }
  }

  return removeDuplicatePoints(output).filter((point) =>
    pointInPolygon(point, clip) || isPointNearPolygonEdge(point, clip)
  );
}

export function clipPolygonToPolygon(subject: Point[], clip: Point[]): Point[] {
  const parts = clipPolygonToPolygonParts(subject, clip);
  return parts.sort((a, b) => polygonArea(b) - polygonArea(a))[0] ?? [];
}

export function clipPolygonToPolygonParts(subject: Point[], clip: Point[]): Point[][] {
  if (subject.length < 3 || clip.length < 3) {
    return [];
  }

  const clipped = polygonClipping.intersection(toClippingPolygon(subject), toClippingPolygon(clip));
  return outerRings(clipped);
}

function toClippingPolygon(polygon: Point[]): ClippingPolygon {
  return [
    polygon.map((point) => [
      Number(point.x.toFixed(3)),
      Number(point.y.toFixed(3))
    ])
  ];
}

function outerRings(multiPolygon: ClippingMultiPolygon): Point[][] {
  const parts: Point[][] = [];

  for (const polygon of multiPolygon) {
    const outerRing = polygon[0] ?? [];
    const points = removeDuplicatePoints(
      outerRing.map(([x, y]) => ({
        x,
        y
      }))
    );
    const area = points.length >= 3 ? polygonArea(points) : 0;

    if (area > 0) {
      parts.push(points);
    }
  }

  return parts;
}

function isInsideClipEdge(
  point: Point,
  edgeStart: Point,
  edgeEnd: Point,
  orientation: number
): boolean {
  const cross =
    (edgeEnd.x - edgeStart.x) * (point.y - edgeStart.y) -
    (edgeEnd.y - edgeStart.y) * (point.x - edgeStart.x);
  return cross * orientation >= -0.001;
}

function lineIntersection(a: Point, b: Point, c: Point, d: Point): Point {
  const a1 = b.y - a.y;
  const b1 = a.x - b.x;
  const c1 = a1 * a.x + b1 * a.y;
  const a2 = d.y - c.y;
  const b2 = c.x - d.x;
  const c2 = a2 * c.x + b2 * c.y;
  const determinant = a1 * b2 - a2 * b1;

  if (Math.abs(determinant) < 0.0001) {
    return { ...b };
  }

  return {
    x: (b2 * c1 - b1 * c2) / determinant,
    y: (a1 * c2 - a2 * c1) / determinant
  };
}

function removeDuplicatePoints(points: Point[]): Point[] {
  const result: Point[] = [];
  for (const point of points) {
    const previous = result[result.length - 1];
    if (!previous || distance(previous, point) > 0.05) {
      result.push(point);
    }
  }

  if (result.length > 1 && distance(result[0], result[result.length - 1]) <= 0.05) {
    result.pop();
  }

  return result;
}

function isPointNearPolygonEdge(point: Point, polygon: Point[]): boolean {
  return polygon.some((current, index) => {
    const next = polygon[(index + 1) % polygon.length];
    return distanceToSegment(point, current, next) <= 0.1;
  });
}

export function distanceToSegment(point: Point, a: Point, b: Point): number {
  const segmentLengthSquared = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
  if (segmentLengthSquared === 0) {
    return distance(point, a);
  }

  const t = Math.max(
    0,
    Math.min(
      1,
      ((point.x - a.x) * (b.x - a.x) + (point.y - a.y) * (b.y - a.y)) /
        segmentLengthSquared
    )
  );
  return distance(point, {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t
  });
}
