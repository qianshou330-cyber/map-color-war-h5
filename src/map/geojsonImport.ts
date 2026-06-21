import polygonClipping, {
  type MultiPolygon as ClippingMultiPolygon,
  type Polygon as ClippingPolygon
} from "polygon-clipping";
import type { Point } from "../types";
import { polygonArea } from "../utils/geometry";

export type GeoJsonImportOptions = {
  minPartArea: number;
  simplifyTolerance: number;
  maxMainPoints: number;
  maxMediumPoints: number;
  maxSmallPoints: number;
  invertY: boolean;
  unionFeatures: boolean;
};

export type GeoJsonImportResult = {
  polygons: Point[][];
  removedParts: number;
  featureCount: number;
  sourceAspectRatio: number;
};

type Position = [number, number];

const DEFAULT_OPTIONS: GeoJsonImportOptions = {
  minPartArea: 0.00025,
  simplifyTolerance: 0.0012,
  maxMainPoints: 280,
  maxMediumPoints: 120,
  maxSmallPoints: 36,
  invertY: true,
  unionFeatures: true
};

export function importPolygonsFromGeoJsonText(
  text: string,
  partialOptions: Partial<GeoJsonImportOptions> = {}
): GeoJsonImportResult {
  const parsed = JSON.parse(text) as unknown;
  const candidate = findGeoJsonCandidate(parsed);
  if (!candidate) {
    throw new Error("No GeoJSON geometry found");
  }

  return importPolygonsFromGeoJson(candidate, partialOptions);
}

export function importPolygonsFromGeoJson(
  geoJson: unknown,
  partialOptions: Partial<GeoJsonImportOptions> = {}
): GeoJsonImportResult {
  const options = normalizeOptions(partialOptions);
  const rawPolygons = collectPolygonRings(geoJson);
  if (rawPolygons.length === 0) {
    throw new Error("GeoJSON has no polygons");
  }

  const bounds = getBounds(rawPolygons);
  if (!bounds) {
    throw new Error("GeoJSON bounds are invalid");
  }

  const normalized = rawPolygons.map((polygon) =>
    polygon.map(([x, y]) => ({
      x: (x - bounds.minX) / bounds.width,
      y: options.invertY
        ? (bounds.maxY - y) / bounds.height
        : (y - bounds.minY) / bounds.height
    }))
  );

  const merged = options.unionFeatures ? unionPolygons(normalized) : normalized;
  const fitted = fitPolygonsToUnitBox(merged);
  const polygons: Point[][] = [];
  let removedParts = 0;

  for (const polygon of fitted) {
    const cleaned = preparePolygon(polygon, options);
    if (cleaned.length < 6 || polygonArea(cleaned) < options.minPartArea) {
      removedParts += 1;
      continue;
    }
    polygons.push(cleaned);
  }

  return {
    polygons: polygons.sort((left, right) => polygonArea(right) - polygonArea(left)),
    removedParts,
    featureCount: rawPolygons.length,
    sourceAspectRatio: clampNumber(bounds.width / bounds.height, 0.3, 4)
  };
}

function findGeoJsonCandidate(value: unknown): unknown | null {
  if (isGeoJsonLike(value)) {
    return value;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const likelyFields = [
    "customMapGeojson",
    "customMapGeoJSON",
    "geojson",
    "geoJson",
    "geoJSON",
    "mapGeojson",
    "mapGeoJSON",
    "baseMap",
    "basemap"
  ];

  for (const field of likelyFields) {
    const candidate = parseMaybeJson(record[field]);
    if (isGeoJsonLike(candidate)) {
      return candidate;
    }
  }

  for (const field of ["data", "map", "customMap", "settings"]) {
    const candidate = findGeoJsonCandidate(record[field]);
    if (candidate) {
      return candidate;
    }
  }

  return null;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function isGeoJsonLike(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }

  const type = (value as { type?: unknown }).type;
  return (
    type === "FeatureCollection" ||
    type === "Feature" ||
    type === "GeometryCollection" ||
    type === "Polygon" ||
    type === "MultiPolygon"
  );
}

function collectPolygonRings(value: unknown): Position[][] {
  if (!value || typeof value !== "object") {
    return [];
  }

  const record = value as Record<string, unknown>;
  switch (record.type) {
    case "FeatureCollection":
      return Array.isArray(record.features)
        ? record.features.flatMap((feature) => collectPolygonRings(feature))
        : [];
    case "Feature":
      return collectPolygonRings(record.geometry);
    case "GeometryCollection":
      return Array.isArray(record.geometries)
        ? record.geometries.flatMap((geometry) => collectPolygonRings(geometry))
        : [];
    case "Polygon":
      return collectPolygonGeometry(record.coordinates);
    case "MultiPolygon":
      return Array.isArray(record.coordinates)
        ? record.coordinates.flatMap((polygon) => collectPolygonGeometry(polygon))
        : [];
    default:
      return [];
  }
}

function collectPolygonGeometry(value: unknown): Position[][] {
  if (!Array.isArray(value)) {
    return [];
  }

  const outerRing = value[0];
  if (!Array.isArray(outerRing)) {
    return [];
  }

  const ring = outerRing
    .filter(isPosition)
    .map((position) => [Number(position[0]), Number(position[1])] as Position)
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));

  return ring.length >= 4 ? [ring] : [];
}

function isPosition(value: unknown): value is Position {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    Number.isFinite(Number(value[0])) &&
    Number.isFinite(Number(value[1]))
  );
}

function getBounds(polygons: Position[][]):
  | {
      minX: number;
      minY: number;
      maxX: number;
      maxY: number;
      width: number;
      height: number;
    }
  | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const polygon of polygons) {
    for (const [x, y] of polygon) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  const width = maxX - minX;
  const height = maxY - minY;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }

  return { minX, minY, maxX, maxY, width, height };
}

function unionPolygons(polygons: Point[][]): Point[][] {
  const clippingPolygons = polygons
    .filter((polygon) => polygon.length >= 3)
    .map(toClippingPolygon);

  if (clippingPolygons.length <= 1) {
    return polygons;
  }

  try {
    const union = polygonClipping.union as (
      ...geometries: Array<ClippingPolygon | ClippingMultiPolygon>
    ) => ClippingMultiPolygon;
    let merged: ClippingMultiPolygon | null = null;
    const chunkSize = 80;
    for (let index = 0; index < clippingPolygons.length; index += chunkSize) {
      const chunk = clippingPolygons.slice(index, index + chunkSize);
      merged = merged
        ? union(merged, ...chunk)
        : union(...chunk);
    }
    return merged ? outerRings(merged) : polygons;
  } catch {
    return polygons;
  }
}

function toClippingPolygon(polygon: Point[]): ClippingPolygon {
  return [
    polygon.map((point) => [
      Number(point.x.toFixed(6)),
      Number(point.y.toFixed(6))
    ])
  ];
}

function outerRings(multiPolygon: ClippingMultiPolygon): Point[][] {
  const rings: Point[][] = [];
  for (const polygon of multiPolygon) {
    const outer = polygon[0] ?? [];
    const ring = removeAdjacentDuplicatePoints(
      outer.map(([x, y]) => ({
        x,
        y
      }))
    );
    if (ring.length >= 3 && polygonArea(ring) > 0) {
      rings.push(ring);
    }
  }
  return rings;
}

function preparePolygon(points: Point[], options: GeoJsonImportOptions): Point[] {
  const cleaned = removeAdjacentDuplicatePoints(
    points.map((point) => ({
      x: clampNumber(point.x, 0, 1),
      y: clampNumber(point.y, 0, 1)
    }))
  );
  const simplified = simplifyClosedPolygon(cleaned, options.simplifyTolerance);
  const limited = limitPolygonPoints(
    removeAdjacentDuplicatePoints(simplified),
    getTargetPointCount(simplified, options)
  );
  return ensureMinimumPointCount(limited, 6);
}

function getTargetPointCount(points: Point[], options: GeoJsonImportOptions): number {
  const area = polygonArea(points);
  if (area >= 0.075) {
    return options.maxMainPoints;
  }
  if (area >= 0.012) {
    return options.maxMediumPoints;
  }
  return options.maxSmallPoints;
}

function simplifyClosedPolygon(points: Point[], tolerance: number): Point[] {
  if (points.length <= 3) {
    return points;
  }

  const openPoints = [...points, points[0]];
  const simplified = simplifyOpenPolyline(openPoints, tolerance);
  const result = simplified.slice(0, -1);
  return result.length >= 3 ? result : points;
}

function simplifyOpenPolyline(points: Point[], tolerance: number): Point[] {
  if (points.length <= 2) {
    return points;
  }

  let maxDistance = 0;
  let splitIndex = 0;
  const start = points[0];
  const end = points[points.length - 1];

  for (let index = 1; index < points.length - 1; index += 1) {
    const currentDistance = distanceToLine(points[index], start, end);
    if (currentDistance > maxDistance) {
      maxDistance = currentDistance;
      splitIndex = index;
    }
  }

  if (maxDistance <= tolerance) {
    return [start, end];
  }

  const left = simplifyOpenPolyline(points.slice(0, splitIndex + 1), tolerance);
  const right = simplifyOpenPolyline(points.slice(splitIndex), tolerance);
  return [...left.slice(0, -1), ...right];
}

function limitPolygonPoints(points: Point[], maxPoints: number): Point[] {
  if (points.length <= maxPoints) {
    return points;
  }

  const step = points.length / maxPoints;
  const result: Point[] = [];
  for (let index = 0; index < maxPoints; index += 1) {
    result.push(points[Math.floor(index * step)]);
  }
  return removeAdjacentDuplicatePoints(result);
}

function ensureMinimumPointCount(points: Point[], minPoints: number): Point[] {
  if (points.length >= minPoints || points.length < 3) {
    return points;
  }

  const result = [...points];
  while (result.length < minPoints) {
    let longestIndex = 0;
    let longestLength = 0;
    for (let index = 0; index < result.length; index += 1) {
      const current = result[index];
      const next = result[(index + 1) % result.length];
      const length = Math.hypot(next.x - current.x, next.y - current.y);
      if (length > longestLength) {
        longestLength = length;
        longestIndex = index;
      }
    }

    const current = result[longestIndex];
    const next = result[(longestIndex + 1) % result.length];
    result.splice(longestIndex + 1, 0, {
      x: (current.x + next.x) / 2,
      y: (current.y + next.y) / 2
    });
  }

  return result;
}

function fitPolygonsToUnitBox(polygons: Point[][]): Point[][] {
  if (polygons.length === 0) {
    return [];
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const polygon of polygons) {
    for (const point of polygon) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
  }

  const width = Math.max(0.0001, maxX - minX);
  const height = Math.max(0.0001, maxY - minY);
  const padding = 0.035;

  return polygons.map((polygon) =>
    polygon.map((point) => ({
      x: clampNumber(padding + ((point.x - minX) / width) * (1 - padding * 2), 0, 1),
      y: clampNumber(padding + ((point.y - minY) / height) * (1 - padding * 2), 0, 1)
    }))
  );
}

function removeAdjacentDuplicatePoints(points: Point[]): Point[] {
  const result: Point[] = [];
  for (const point of points) {
    const previous = result[result.length - 1];
    if (!previous || Math.hypot(previous.x - point.x, previous.y - point.y) > 0.00001) {
      result.push(point);
    }
  }

  if (result.length > 1) {
    const first = result[0];
    const last = result[result.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) <= 0.00001) {
      result.pop();
    }
  }

  return result;
}

function distanceToLine(point: Point, start: Point, end: Point): number {
  const lengthSquared = (end.x - start.x) ** 2 + (end.y - start.y) ** 2;
  if (lengthSquared === 0) {
    return Math.hypot(point.x - start.x, point.y - start.y);
  }

  const area = Math.abs(
    (end.x - start.x) * (start.y - point.y) -
      (start.x - point.x) * (end.y - start.y)
  );
  return area / Math.sqrt(lengthSquared);
}

function normalizeOptions(partialOptions: Partial<GeoJsonImportOptions>): GeoJsonImportOptions {
  return {
    minPartArea: clampNumber(Number(partialOptions.minPartArea ?? DEFAULT_OPTIONS.minPartArea), 0.00001, 0.05),
    simplifyTolerance: clampNumber(
      Number(partialOptions.simplifyTolerance ?? DEFAULT_OPTIONS.simplifyTolerance),
      0,
      0.02
    ),
    maxMainPoints: Math.round(clampNumber(Number(partialOptions.maxMainPoints ?? DEFAULT_OPTIONS.maxMainPoints), 80, 320)),
    maxMediumPoints: Math.round(
      clampNumber(Number(partialOptions.maxMediumPoints ?? DEFAULT_OPTIONS.maxMediumPoints), 24, 160)
    ),
    maxSmallPoints: Math.round(clampNumber(Number(partialOptions.maxSmallPoints ?? DEFAULT_OPTIONS.maxSmallPoints), 8, 64)),
    invertY: partialOptions.invertY ?? DEFAULT_OPTIONS.invertY,
    unionFeatures: partialOptions.unionFeatures ?? DEFAULT_OPTIONS.unionFeatures
  };
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}
