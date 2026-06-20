import { Delaunay } from "d3-delaunay";
import {
  COUNTRY_COUNT,
  MAP_GENERATION_MAX_ATTEMPTS,
  MAP_HEIGHT,
  MAP_WIDTH,
  MIN_COUNTRY_AREA,
  NEUTRAL_COLORS,
  PROVINCES_PER_COUNTRY,
  SOLDIER_CAP_MAX,
  SOLDIER_CAP_MIN
} from "../constants";
import type {
  Country,
  EditableMapData,
  GeneratedMapResult,
  MapLandPart,
  MapRegion,
  Point,
  Province
} from "../types";
import {
  clipPolygonToPolygon,
  clipPolygonToPolygonParts,
  distance,
  distanceToSegment,
  polygonArea,
  polygonBounds,
  polygonCentroid,
  pointInPolygon,
  randomPointInPolygon
} from "../utils/geometry";
import { randomFloat, randomInt } from "../utils/random";
import { createRandomRegion, createRegionFromEditableMap } from "./regions";

type SeedPoint = Point & {
  landPartId: string;
};

type GeneratedMap = {
  countries: Country[];
  minArea: number;
};

export function generateMap(
  width = MAP_WIDTH,
  height = MAP_HEIGHT,
  editableMapData?: EditableMapData
): GeneratedMapResult {
  let bestMap: GeneratedMap | null = null;
  let bestRegion: MapRegion | null = null;

  for (let attempt = 0; attempt < MAP_GENERATION_MAX_ATTEMPTS; attempt += 1) {
    const region = createRegion(width, height, editableMapData);
    const generated = generateMapOnce(width, height, region);
    const targetMinArea = getTargetMinArea(region);

    if (generated.countries.length === COUNTRY_COUNT && generated.minArea >= targetMinArea) {
      return {
        countries: generated.countries,
        region
      };
    }

    if (
      generated.countries.length === COUNTRY_COUNT &&
      (!bestMap || generated.minArea > bestMap.minArea)
    ) {
      bestMap = generated;
      bestRegion = region;
    }
  }

  if (bestMap && bestRegion) {
    return {
      countries: bestMap.countries,
      region: bestRegion
    };
  }

  const region = createRegion(width, height, editableMapData);
  return {
    countries: generateMapOnce(width, height, region).countries,
    region
  };
}

function createRegion(
  width: number,
  height: number,
  editableMapData?: EditableMapData
): MapRegion {
  return editableMapData
    ? createRegionFromEditableMap(width, height, editableMapData)
    : createRandomRegion(width, height);
}

function generateMapOnce(width: number, height: number, region: MapRegion): GeneratedMap {
  const points = createRegionPoints(region);
  const delaunay = Delaunay.from<SeedPoint>(
    points,
    (point) => point.x,
    (point) => point.y
  );
  const voronoi = delaunay.voronoi([0, 0, width, height]);
  const countries: Country[] = [];
  let minArea = Number.POSITIVE_INFINITY;

  for (let index = 0; index < points.length; index += 1) {
    const seed = points[index];
    const landPart = getLandPart(region, seed.landPartId);
    const rawPolygon = voronoi.cellPolygon(index);
    const polygon = clipCellToRegionPart(
      sanitizePolygon(rawPolygon, width, height),
      landPart,
      seed
    );

    if (polygon.length < 3) {
      return {
        countries: [],
        minArea: 0
      };
    }

    const area = polygonArea(polygon);
    if (area < 12) {
      return {
        countries: [],
        minArea: 0
      };
    }

    const centroid = polygonCentroid(polygon);
    const center = isPointInOrNearPolygon(centroid, polygon) ? centroid : seed;
    minArea = Math.min(minArea, area);

    const country: Country = {
      id: index + 1,
      displayCountryId: index + 1,
      controllerCountryId: index + 1,
      polygon,
      center,
      area,
      landPartId: seed.landPartId,
      neighbors: [],
      owner: "neutral",
      controller: "computer",
      color: getCountryBaseColor(index),
      defaultSoldierCap: randomInt(SOLDIER_CAP_MIN, SOLDIER_CAP_MAX),
      provinces: [],
      spawnProvinceId: ""
    };

    country.provinces = createCountryProvinces(country);
    const spawnProvince = [...country.provinces].sort(
      (a, b) => distance(a.center, country.center) - distance(b.center, country.center)
    )[0];

    if (!spawnProvince) {
      return {
        countries: [],
        minArea: 0
      };
    }

    spawnProvince.isSpawnProvince = true;
    country.spawnProvinceId = spawnProvince.id;
    countries.push(country);
  }

  computeCountryNeighbors(countries);

  return {
    countries,
    minArea
  };
}

function getCountryBaseColor(index: number): number {
  const paletteIndex =
    (index * 7 + Math.floor(index / NEUTRAL_COLORS.length) * 5) % NEUTRAL_COLORS.length;
  return NEUTRAL_COLORS[paletteIndex];
}

function createCountryProvinces(country: Country): Province[] {
  const seeds = createProvinceSeeds(country);
  const bounds = polygonBounds(country.polygon);
  const delaunay = Delaunay.from<Point>(
    seeds,
    (point) => point.x,
    (point) => point.y
  );
  const voronoi = delaunay.voronoi([
    bounds.minX - 4,
    bounds.minY - 4,
    bounds.maxX + 4,
    bounds.maxY + 4
  ]);

  const provinces: Province[] = [];
  for (let index = 0; index < seeds.length; index += 1) {
    const rawPolygon = voronoi.cellPolygon(index);
    if (!rawPolygon) {
      continue;
    }

    const cell = Array.from(rawPolygon, ([x, y]) => ({ x, y }));
    if (cell.length > 1 && distance(cell[0], cell[cell.length - 1]) < 0.001) {
      cell.pop();
    }

    const clipped = clipPolygonToPolygon(cell, country.polygon);
    if (clipped.length < 3) {
      continue;
    }

    const area = polygonArea(clipped);
    if (area < Math.max(8, country.area * 0.006)) {
      continue;
    }

    provinces.push({
      id: `${country.id}-${index + 1}`,
      countryId: country.id,
      polygon: clipped,
      center: polygonCentroid(clipped),
      area,
      paintCountryId: country.controllerCountryId,
      isSpawnProvince: false
    });
  }

  return provinces.length === PROVINCES_PER_COUNTRY
    ? provinces
    : createFallbackProvinces(country);
}

function createProvinceSeeds(country: Country): Point[] {
  const seeds = [country.center];
  while (seeds.length < PROVINCES_PER_COUNTRY) {
    seeds.push(randomPointInPolygon(country.polygon));
  }
  return seeds;
}

function createFallbackProvinces(country: Country): Province[] {
  const provinces: Province[] = [];
  const perimeter = polygonPerimeter(country.polygon);

  for (let index = 0; index < PROVINCES_PER_COUNTRY; index += 1) {
    const start = pointOnPolygonPerimeter(
      country.polygon,
      (perimeter * index) / PROVINCES_PER_COUNTRY
    );
    const end = pointOnPolygonPerimeter(
      country.polygon,
      (perimeter * (index + 1)) / PROVINCES_PER_COUNTRY
    );
    const fallbackPolygon = [country.center, start, end];
    const clipped = clipPolygonToPolygon(fallbackPolygon, country.polygon);
    const polygon = clipped.length >= 3 ? clipped : fallbackPolygon;

    provinces.push({
      id: `${country.id}-${index + 1}`,
      countryId: country.id,
      polygon,
      center: polygonCentroid(polygon),
      area: polygonArea(polygon),
      paintCountryId: country.controllerCountryId,
      isSpawnProvince: false
    });
  }

  return provinces;
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
    const start = polygon[index];
    const end = polygon[(index + 1) % polygon.length];
    const segmentLength = distance(start, end);

    if (traveled + segmentLength >= targetDistance) {
      const ratio = segmentLength === 0 ? 0 : (targetDistance - traveled) / segmentLength;
      return {
        x: start.x + (end.x - start.x) * ratio,
        y: start.y + (end.y - start.y) * ratio
      };
    }

    traveled += segmentLength;
  }

  return polygon[0];
}

function createRegionPoints(region: MapRegion): SeedPoint[] {
  const allocations = allocateSeedCounts(region);
  const points = allocations.flatMap(({ landPart, count }) =>
    createPointsForLandPart(landPart, count)
  );

  return points.slice(0, COUNTRY_COUNT).sort(() => Math.random() - 0.5);
}

function allocateSeedCounts(
  region: MapRegion
): Array<{ landPart: MapLandPart; count: number }> {
  const areas = region.landParts.map((landPart) => ({
    landPart,
    area: polygonArea(landPart.polygon),
    count: Math.max(0, Math.floor(landPart.minSeeds ?? 0))
  }));
  let allocated = areas.reduce((total, item) => total + item.count, 0);

  while (allocated > COUNTRY_COUNT) {
    const item = areas
      .filter((candidate) => candidate.count > 0)
      .sort((a, b) => b.count - a.count)[0];
    item.count -= 1;
    allocated -= 1;
  }

  const totalArea = Math.max(
    1,
    areas.reduce((total, item) => total + item.area, 0)
  );

  while (allocated < COUNTRY_COUNT) {
    const pick = randomFloat(0, totalArea);
    let cursor = 0;
    const selected =
      areas.find((item) => {
        cursor += item.area;
        return pick <= cursor;
      }) ?? areas[areas.length - 1];

    selected.count += 1;
    allocated += 1;
  }

  return areas.map(({ landPart, count }) => ({
    landPart,
    count
  }));
}

function createPointsForLandPart(landPart: MapLandPart, count: number): SeedPoint[] {
  if (count <= 0) {
    return [];
  }

  const bounds = polygonBounds(landPart.polygon);
  const width = Math.max(1, bounds.maxX - bounds.minX);
  const height = Math.max(1, bounds.maxY - bounds.minY);
  const columns = Math.max(1, Math.ceil(Math.sqrt(count * (width / height))));
  const rows = Math.max(1, Math.ceil(count / columns));
  const cellWidth = width / columns;
  const cellHeight = height / rows;
  const points: SeedPoint[] = [];

  for (let index = 0; index < count; index += 1) {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const point =
      randomPointInLandPartCell(landPart, {
        minX: bounds.minX + column * cellWidth,
        minY: bounds.minY + row * cellHeight,
        maxX: bounds.minX + (column + 1) * cellWidth,
        maxY: bounds.minY + (row + 1) * cellHeight
      }) ?? randomPointInPolygon(landPart.polygon);

    points.push({
      ...point,
      landPartId: landPart.id
    });
  }

  return points;
}

function randomPointInLandPartCell(
  landPart: MapLandPart,
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
): Point | null {
  for (let attempt = 0; attempt < 28; attempt += 1) {
    const point = {
      x: randomFloat(bounds.minX, bounds.maxX),
      y: randomFloat(bounds.minY, bounds.maxY)
    };

    if (pointInPolygon(point, landPart.polygon)) {
      return point;
    }
  }

  return null;
}

function clipCellToRegionPart(cell: Point[], landPart: MapLandPart, seed: Point): Point[] {
  const parts = clipPolygonToPolygonParts(cell, landPart.polygon)
    .filter((polygon) => polygon.length >= 3)
    .sort((a, b) => polygonArea(b) - polygonArea(a));

  return (
    parts.find((polygon) => isPointInOrNearPolygon(seed, polygon)) ??
    parts[0] ??
    []
  );
}

function computeCountryNeighbors(countries: Country[]): void {
  for (const country of countries) {
    country.neighbors = [];
  }

  for (let leftIndex = 0; leftIndex < countries.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < countries.length; rightIndex += 1) {
      const left = countries[leftIndex];
      const right = countries[rightIndex];

      if (polygonsShareBorder(left.polygon, right.polygon)) {
        left.neighbors.push(right.id);
        right.neighbors.push(left.id);
      }
    }
  }
}

function polygonsShareBorder(left: Point[], right: Point[]): boolean {
  const sharedLengthThreshold = 2.4;

  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const leftStart = left[leftIndex];
    const leftEnd = left[(leftIndex + 1) % left.length];

    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      const rightStart = right[rightIndex];
      const rightEnd = right[(rightIndex + 1) % right.length];

      if (sharedSegmentLength(leftStart, leftEnd, rightStart, rightEnd) >= sharedLengthThreshold) {
        return true;
      }
    }
  }

  return false;
}

function sharedSegmentLength(a: Point, b: Point, c: Point, d: Point): number {
  const tolerance = 1.15;
  const abLength = distance(a, b);
  const cdLength = distance(c, d);

  if (abLength < 0.1 || cdLength < 0.1) {
    return 0;
  }

  if (pointLineDistance(c, a, b) > tolerance || pointLineDistance(d, a, b) > tolerance) {
    return 0;
  }

  if (pointLineDistance(a, c, d) > tolerance || pointLineDistance(b, c, d) > tolerance) {
    return 0;
  }

  const useX = Math.abs(a.x - b.x) >= Math.abs(a.y - b.y);
  const firstMin = Math.min(useX ? a.x : a.y, useX ? b.x : b.y);
  const firstMax = Math.max(useX ? a.x : a.y, useX ? b.x : b.y);
  const secondMin = Math.min(useX ? c.x : c.y, useX ? d.x : d.y);
  const secondMax = Math.max(useX ? c.x : c.y, useX ? d.x : d.y);
  const overlap = Math.min(firstMax, secondMax) - Math.max(firstMin, secondMin);

  if (overlap <= 0) {
    return 0;
  }

  const axisLength = Math.max(0.001, useX ? Math.abs(a.x - b.x) : Math.abs(a.y - b.y));
  return overlap * (abLength / axisLength);
}

function pointLineDistance(point: Point, lineStart: Point, lineEnd: Point): number {
  const length = distance(lineStart, lineEnd);
  if (length < 0.001) {
    return distance(point, lineStart);
  }

  return Math.abs(
    ((lineEnd.x - lineStart.x) * (lineStart.y - point.y) -
      (lineStart.x - point.x) * (lineEnd.y - lineStart.y)) /
      length
  );
}

function isPointInOrNearPolygon(point: Point, polygon: Point[]): boolean {
  return (
    pointInPolygon(point, polygon) ||
    polygon.some((current, index) => {
      const next = polygon[(index + 1) % polygon.length];
      return distanceToSegment(point, current, next) <= 0.5;
    })
  );
}

function getLandPart(region: MapRegion, landPartId: string): MapLandPart {
  return region.landParts.find((landPart) => landPart.id === landPartId) ?? region.landParts[0];
}

function getTargetMinArea(region: MapRegion): number {
  const landArea = region.landParts.reduce(
    (total, landPart) => total + polygonArea(landPart.polygon),
    0
  );
  return Math.min(MIN_COUNTRY_AREA, (landArea * 0.2) / COUNTRY_COUNT);
}

function sanitizePolygon(
  rawPolygon: Iterable<[number, number]> | null,
  width: number,
  height: number
): Point[] {
  if (!rawPolygon) {
    return [
      { x: 0, y: 0 },
      { x: width, y: 0 },
      { x: width, y: height },
      { x: 0, y: height }
    ];
  }

  const polygon = Array.from(rawPolygon, ([x, y]) => ({
    x: clampNumber(x, 0, width),
    y: clampNumber(y, 0, height)
  }));

  if (polygon.length > 1) {
    const first = polygon[0];
    const last = polygon[polygon.length - 1];
    if (Math.abs(first.x - last.x) < 0.001 && Math.abs(first.y - last.y) < 0.001) {
      polygon.pop();
    }
  }

  return polygon;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
