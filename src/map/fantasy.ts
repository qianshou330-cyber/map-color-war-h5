import { COUNTRY_COUNT, PROVINCES_PER_COUNTRY } from "../constants";
import type {
  Biome,
  EditableMapData,
  FantasyWorldType,
  MapGenerationConfig,
  MapLandPart,
  MapRegion,
  Point,
  River,
  TerrainMap
} from "../types";
import { pointInPolygon, polygonArea } from "../utils/geometry";
import { createSeededRandom, type SeededRandom } from "../utils/seededRandom";

const TERRAIN_GRID_WIDTH = 112;
const TERRAIN_GRID_HEIGHT = 140;
const LAND_POLYGON_STEPS = 224;
const RIVER_TRACE_STEPS = 64;
const MIN_TOTAL_PLAYABLE_LAND_AREA = 0.18;
const HEIGHTMAP_LAND_GRID_WIDTH = 176;
const HEIGHTMAP_LAND_GRID_HEIGHT = 220;

type HeightGrid = {
  width: number;
  height: number;
  values: number[];
};

type LandBlob = {
  id: string;
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  strength: number;
  asLandPart: boolean;
};

export function createDefaultMapGenerationConfig(
  partial: Partial<MapGenerationConfig> = {}
): MapGenerationConfig {
  return normalizeMapGenerationConfig({
    seed: `fantasy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    worldType: "twinContinents",
    seaLevel: 0.43,
    mountainStrength: 0.68,
    moisture: 0.58,
    temperature: 0.58,
    riverCount: 10,
    countryCount: COUNTRY_COUNT,
    provincesPerCountry: PROVINCES_PER_COUNTRY,
    mapViewMode: "mixed",
    ...partial
  });
}

export function normalizeMapGenerationConfig(
  partial: Partial<MapGenerationConfig> = {}
): MapGenerationConfig {
  const worldType = isWorldType(partial.worldType) ? partial.worldType : "twinContinents";
  return {
    seed: String(partial.seed || "fantasy-map"),
    worldType,
    seaLevel: clampNumber(Number(partial.seaLevel ?? 0.46), 0.35, 0.6),
    mountainStrength: clampNumber(Number(partial.mountainStrength ?? 0.62), 0.15, 1),
    moisture: clampNumber(Number(partial.moisture ?? 0.56), 0.15, 1),
    temperature: clampNumber(Number(partial.temperature ?? 0.58), 0.1, 1),
    riverCount: Math.round(clampNumber(Number(partial.riverCount ?? 8), 0, 20)),
    countryCount: COUNTRY_COUNT,
    provincesPerCountry: PROVINCES_PER_COUNTRY,
    mapViewMode: isMapViewMode(partial.mapViewMode) ? partial.mapViewMode : "mixed"
  };
}

export function createFantasyEditableMapData(
  partial: Partial<MapGenerationConfig> = {}
): EditableMapData {
  const generationConfig = createDefaultMapGenerationConfig(partial);
  return {
    version: 1,
    name: `Fantasy ${generationConfig.seed}`,
    landParts: createFantasyLandParts(generationConfig).map((polygon, index) => ({
      id: `fantasy-${index + 1}`,
      polygon
    })),
    generationConfig
  };
}

export function createFantasyRegion(
  width: number,
  height: number,
  partial: Partial<MapGenerationConfig> = {},
  savedLandParts?: Point[][]
): MapRegion {
  const generationConfig = normalizeMapGenerationConfig(partial);
  const savedPlayableParts =
    savedLandParts && savedLandParts.length > 0
      ? filterVisibleLandParts(savedLandParts, generationConfig)
      : [];
  const normalizedParts =
    savedPlayableParts.length > 0
      ? savedPlayableParts
      : createFantasyLandParts(generationConfig);
  const totalArea = Math.max(
    0.001,
    normalizedParts.reduce((sum, polygon) => sum + polygonArea(polygon), 0)
  );
  const landParts: MapLandPart[] = normalizedParts.map((polygon, index) => {
    const areaRatio = polygonArea(polygon) / totalArea;
    const seedable = isSeedableLandPart(polygon, generationConfig);
    return {
      id: `fantasy-${index + 1}`,
      minSeeds: seedable ? Math.max(0, Math.floor(COUNTRY_COUNT * areaRatio * 0.58)) : 0,
      seedable,
      attachToNearestCountry: !seedable,
      polygon: scalePolygon(polygon, width, height)
    };
  });

  return {
    id: "fantasy",
    name: "Fantasy World",
    landParts,
    outlinePolygons: landParts.map((part) => part.polygon),
    generationConfig,
    terrain: createTerrainMap(width, height, generationConfig, normalizedParts),
    rivers: createRivers(width, height, generationConfig)
  };
}

export function getTerrainCell(terrain: TerrainMap, column: number, row: number) {
  const clampedColumn = Math.max(0, Math.min(terrain.width - 1, column));
  const clampedRow = Math.max(0, Math.min(terrain.height - 1, row));
  const index = clampedRow * terrain.width + clampedColumn;
  return {
    x: clampedColumn,
    y: clampedRow,
    height: terrain.heights[index] ?? 0,
    moisture: terrain.moisture[index] ?? 0,
    temperature: terrain.temperature[index] ?? 0,
    biome: terrain.biomes[index] ?? "ocean",
    isWater: (terrain.biomes[index] ?? "ocean") === "ocean"
  };
}

function createFantasyLandParts(config: MapGenerationConfig): Point[][] {
  const blobs = createLandBlobs(config);
  const heightGrid = createHeightGrid(
    HEIGHTMAP_LAND_GRID_WIDTH,
    HEIGHTMAP_LAND_GRID_HEIGHT,
    config,
    blobs
  );
  const heightmapParts = extractLandPolygonsFromHeightGrid(heightGrid, config.seaLevel, config);
  const terrainAlignedParts = filterTerrainAlignedLandParts(heightmapParts, heightGrid, config);
  const playableParts = filterVisibleLandParts(terrainAlignedParts, config);

  const totalArea = playableParts.reduce((sum, polygon) => sum + polygonArea(polygon), 0);
  return totalArea >= MIN_TOTAL_PLAYABLE_LAND_AREA
    ? playableParts
    : createBlobFallbackLandParts(config, blobs, heightGrid);
}

function filterTerrainAlignedLandParts(
  parts: Point[][],
  heightGrid: HeightGrid,
  config: MapGenerationConfig
): Point[][] {
  const minCoverage = config.worldType === "archipelago" ? 0.28 : 0.52;
  return parts.filter((polygon) => getLandCoverageRatio(polygon, heightGrid, config.seaLevel) >= minCoverage);
}

function getLandCoverageRatio(polygon: Point[], heightGrid: HeightGrid, seaLevel: number): number {
  let inside = 0;
  let land = 0;

  for (let row = 0; row < heightGrid.height; row += 1) {
    for (let column = 0; column < heightGrid.width; column += 1) {
      const point = {
        x: (column + 0.5) / heightGrid.width,
        y: (row + 0.5) / heightGrid.height
      };
      if (!pointInPolygon(point, polygon)) {
        continue;
      }

      inside += 1;
      if ((heightGrid.values[row * heightGrid.width + column] ?? 0) >= seaLevel) {
        land += 1;
      }
    }
  }

  return inside === 0 ? 0 : land / inside;
}

function createBlobFallbackLandParts(
  config: MapGenerationConfig,
  blobs: LandBlob[],
  heightGrid: HeightGrid
): Point[][] {
  const blobParts = blobs
    .filter((blob) => blob.asLandPart)
    .map((blob) => createLandPolygon(blob, config, blobs));
  const playableParts = filterVisibleLandParts(
    filterTerrainAlignedLandParts(blobParts, heightGrid, config),
    config
  );
  const totalArea = playableParts.reduce((sum, polygon) => sum + polygonArea(polygon), 0);
  if (totalArea >= MIN_TOTAL_PLAYABLE_LAND_AREA) {
    return playableParts;
  }

  const areaOnlyParts = filterVisibleLandParts(blobParts, config);
  const areaOnlyTotal = areaOnlyParts.reduce((sum, polygon) => sum + polygonArea(polygon), 0);
  return areaOnlyTotal >= MIN_TOTAL_PLAYABLE_LAND_AREA
    ? areaOnlyParts
    : createFallbackContinent(config);
}

function createHeightGrid(
  width: number,
  height: number,
  config: MapGenerationConfig,
  blobs: LandBlob[]
): HeightGrid {
  const values: number[] = [];

  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      values.push(heightAt((column + 0.5) / width, (row + 0.5) / height, config, blobs));
    }
  }

  return {
    width,
    height,
    values
  };
}

function extractLandPolygonsFromHeightGrid(
  grid: HeightGrid,
  seaLevel: number,
  config: MapGenerationConfig
): Point[][] {
  const land = grid.values.map((heightValue) => heightValue >= seaLevel);
  const visited = new Set<number>();
  const polygons: Point[][] = [];

  for (let row = 0; row < grid.height; row += 1) {
    for (let column = 0; column < grid.width; column += 1) {
      const index = row * grid.width + column;
      if (!land[index] || visited.has(index)) {
        continue;
      }

      const component = collectLandComponent(column, row, grid, land, visited);
      const loops = traceComponentBoundaryLoops(component, grid);
      const largestLoop = loops
        .map((loop) => cleanContourPolygon(loop, config))
        .filter((loop) => loop.length >= 8)
        .sort((left, right) => polygonArea(right) - polygonArea(left))[0];

      if (largestLoop) {
        polygons.push(largestLoop);
      }
    }
  }

  return polygons.sort((left, right) => polygonArea(right) - polygonArea(left));
}

function collectLandComponent(
  startColumn: number,
  startRow: number,
  grid: HeightGrid,
  land: boolean[],
  visited: Set<number>
): Array<{ column: number; row: number }> {
  const stack = [{ column: startColumn, row: startRow }];
  const component: Array<{ column: number; row: number }> = [];

  while (stack.length > 0) {
    const cell = stack.pop();
    if (!cell) {
      continue;
    }

    if (
      cell.column < 0 ||
      cell.column >= grid.width ||
      cell.row < 0 ||
      cell.row >= grid.height
    ) {
      continue;
    }

    const index = cell.row * grid.width + cell.column;
    if (!land[index] || visited.has(index)) {
      continue;
    }

    visited.add(index);
    component.push(cell);
    stack.push(
      { column: cell.column + 1, row: cell.row },
      { column: cell.column - 1, row: cell.row },
      { column: cell.column, row: cell.row + 1 },
      { column: cell.column, row: cell.row - 1 }
    );
  }

  return component;
}

function traceComponentBoundaryLoops(
  component: Array<{ column: number; row: number }>,
  grid: HeightGrid
): Point[][] {
  const cells = new Set(component.map((cell) => cellKey(cell.column, cell.row)));
  const edgeMap = new Map<string, Array<{ start: Point; end: Point }>>();

  for (const cell of component) {
    const { column, row } = cell;
    addBoundaryEdgeIfWater(cells, edgeMap, grid, column, row, column, row - 1, {
      start: gridVertex(column, row, grid),
      end: gridVertex(column + 1, row, grid)
    });
    addBoundaryEdgeIfWater(cells, edgeMap, grid, column, row, column + 1, row, {
      start: gridVertex(column + 1, row, grid),
      end: gridVertex(column + 1, row + 1, grid)
    });
    addBoundaryEdgeIfWater(cells, edgeMap, grid, column, row, column, row + 1, {
      start: gridVertex(column + 1, row + 1, grid),
      end: gridVertex(column, row + 1, grid)
    });
    addBoundaryEdgeIfWater(cells, edgeMap, grid, column, row, column - 1, row, {
      start: gridVertex(column, row + 1, grid),
      end: gridVertex(column, row, grid)
    });
  }

  const loops: Point[][] = [];
  while (edgeMap.size > 0) {
    const firstKey = edgeMap.keys().next().value as string | undefined;
    if (!firstKey) {
      break;
    }

    const firstEdge = shiftEdge(edgeMap, firstKey);
    if (!firstEdge) {
      continue;
    }

    const loop: Point[] = [firstEdge.start];
    let current = firstEdge.end;
    const startKey = pointKey(firstEdge.start);
    let guard = 0;

    while (pointKey(current) !== startKey && guard < component.length * 8 + 32) {
      loop.push(current);
      const nextEdge = shiftEdge(edgeMap, pointKey(current));
      if (!nextEdge) {
        break;
      }
      current = nextEdge.end;
      guard += 1;
    }

    if (loop.length >= 4) {
      loops.push(removeAdjacentDuplicatePoints(loop));
    }
  }

  return loops;
}

function addBoundaryEdgeIfWater(
  cells: Set<string>,
  edgeMap: Map<string, Array<{ start: Point; end: Point }>>,
  grid: HeightGrid,
  _column: number,
  _row: number,
  neighborColumn: number,
  neighborRow: number,
  edge: { start: Point; end: Point }
): void {
  const neighborInGrid =
    neighborColumn >= 0 &&
    neighborColumn < grid.width &&
    neighborRow >= 0 &&
    neighborRow < grid.height;

  if (neighborInGrid && cells.has(cellKey(neighborColumn, neighborRow))) {
    return;
  }

  const startKey = pointKey(edge.start);
  const bucket = edgeMap.get(startKey) ?? [];
  bucket.push(edge);
  edgeMap.set(startKey, bucket);
}

function shiftEdge(
  edgeMap: Map<string, Array<{ start: Point; end: Point }>>,
  key: string
): { start: Point; end: Point } | undefined {
  const bucket = edgeMap.get(key);
  if (!bucket || bucket.length === 0) {
    edgeMap.delete(key);
    return undefined;
  }

  const edge = bucket.shift();
  if (bucket.length === 0) {
    edgeMap.delete(key);
  }
  return edge;
}

function cleanContourPolygon(polygon: Point[], config: MapGenerationConfig): Point[] {
  const withoutDuplicates = removeAdjacentDuplicatePoints(polygon);
  const withoutCollinear = removeCollinearPoints(withoutDuplicates);
  const smoothed = smoothClosedPolygon(
    withoutCollinear,
    config.worldType === "archipelago" ? 1 : 2
  );
  const simplified = simplifyPolygon(removeCollinearPoints(smoothed), 0.00135).map((point) => ({
    x: clamp01(point.x),
    y: clamp01(point.y)
  }));
  return fitCoastlinePointCount(simplified, config);
}

function fitCoastlinePointCount(polygon: Point[], config: MapGenerationConfig): Point[] {
  if (polygon.length < 4) {
    return polygon;
  }

  const area = polygonArea(polygon);
  const targetCount = getTargetCoastlinePointCount(area, config);
  const resampled = resampleClosedPolygon(polygon, targetCount);
  return addCoastalMicroDetail(resampled, config, area);
}

function getTargetCoastlinePointCount(area: number, config: MapGenerationConfig): number {
  if (area >= 0.11) {
    return config.worldType === "archipelago" ? 196 : 232;
  }

  if (area >= 0.055) {
    return 116;
  }

  if (area >= 0.018) {
    return 72;
  }

  return 24;
}

function resampleClosedPolygon(polygon: Point[], targetCount: number): Point[] {
  const perimeter = getNormalizedPolygonPerimeter(polygon);
  if (perimeter < 0.000001) {
    return polygon;
  }

  const result: Point[] = [];
  for (let index = 0; index < targetCount; index += 1) {
    result.push(pointOnNormalizedPolygonPerimeter(polygon, (perimeter * index) / targetCount));
  }
  return result;
}

function addCoastalMicroDetail(
  polygon: Point[],
  config: MapGenerationConfig,
  area: number
): Point[] {
  const amplitude = clampNumber(Math.sqrt(area) * 0.012, 0.0012, 0.0065);
  return polygon.map((point, index) => {
    const previous = polygon[(index - 1 + polygon.length) % polygon.length];
    const next = polygon[(index + 1) % polygon.length];
    const tangent = {
      x: next.x - previous.x,
      y: next.y - previous.y
    };
    const length = Math.max(0.000001, Math.hypot(tangent.x, tangent.y));
    const normal = {
      x: -tangent.y / length,
      y: tangent.x / length
    };
    const broad = fractalNoise(point.x * 32, point.y * 32, `${config.seed}:coast-detail`, 3) - 0.5;
    const fine = fractalNoise(point.x * 76 + 7, point.y * 76 - 3, `${config.seed}:coast-fine`, 2) - 0.5;
    const displacement = (broad * 0.72 + fine * 0.28) * amplitude;
    return {
      x: clamp01(point.x + normal.x * displacement),
      y: clamp01(point.y + normal.y * displacement)
    };
  });
}

function removeAdjacentDuplicatePoints(points: Point[]): Point[] {
  const result: Point[] = [];
  for (const point of points) {
    const previous = result[result.length - 1];
    if (!previous || distanceSq(previous, point) > 0.0000005) {
      result.push(point);
    }
  }

  if (result.length > 1 && distanceSq(result[0], result[result.length - 1]) <= 0.0000005) {
    result.pop();
  }
  return result;
}

function removeCollinearPoints(points: Point[]): Point[] {
  if (points.length <= 3) {
    return points;
  }

  return points.filter((point, index) => {
    const previous = points[(index - 1 + points.length) % points.length];
    const next = points[(index + 1) % points.length];
    const cross =
      (point.x - previous.x) * (next.y - point.y) -
      (point.y - previous.y) * (next.x - point.x);
    return Math.abs(cross) > 0.00001;
  });
}

function smoothClosedPolygon(points: Point[], iterations: number): Point[] {
  let result = points;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    if (result.length < 4) {
      return result;
    }

    const next: Point[] = [];
    for (let index = 0; index < result.length; index += 1) {
      const current = result[index];
      const following = result[(index + 1) % result.length];
      next.push(
        {
          x: current.x * 0.74 + following.x * 0.26,
          y: current.y * 0.74 + following.y * 0.26
        },
        {
          x: current.x * 0.26 + following.x * 0.74,
          y: current.y * 0.26 + following.y * 0.74
        }
      );
    }
    result = next;
  }
  return result;
}

function simplifyPolygon(points: Point[], tolerance: number): Point[] {
  if (points.length <= 16) {
    return points;
  }

  const result = points.filter((point, index) => {
    const previous = points[(index - 1 + points.length) % points.length];
    const next = points[(index + 1) % points.length];
    return distanceToLine(point, previous, next) >= tolerance || index % 3 === 0;
  });

  return result.length >= 8 ? result : points;
}

function distanceToLine(point: Point, start: Point, end: Point): number {
  const length = Math.sqrt(distanceSq(start, end));
  if (length < 0.000001) {
    return Math.sqrt(distanceSq(point, start));
  }

  return Math.abs(
    ((end.x - start.x) * (start.y - point.y) -
      (start.x - point.x) * (end.y - start.y)) /
      length
  );
}

function getNormalizedPolygonPerimeter(polygon: Point[]): number {
  let perimeter = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    perimeter += Math.sqrt(distanceSq(polygon[index], polygon[(index + 1) % polygon.length]));
  }
  return perimeter;
}

function pointOnNormalizedPolygonPerimeter(polygon: Point[], targetDistance: number): Point {
  let traveled = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const start = polygon[index];
    const end = polygon[(index + 1) % polygon.length];
    const segmentLength = Math.sqrt(distanceSq(start, end));
    if (traveled + segmentLength >= targetDistance) {
      const ratio = segmentLength < 0.000001 ? 0 : (targetDistance - traveled) / segmentLength;
      return {
        x: start.x + (end.x - start.x) * ratio,
        y: start.y + (end.y - start.y) * ratio
      };
    }
    traveled += segmentLength;
  }

  return { ...polygon[0] };
}

function cellKey(column: number, row: number): string {
  return `${column}:${row}`;
}

function gridVertex(column: number, row: number, grid: HeightGrid): Point {
  return {
    x: column / grid.width,
    y: row / grid.height
  };
}

function pointKey(point: Point): string {
  return `${Math.round(point.x * 100000)}:${Math.round(point.y * 100000)}`;
}

function filterVisibleLandParts(parts: Point[][], config: MapGenerationConfig): Point[][] {
  const minArea = getMinVisibleLandPartArea(config);
  return parts
    .filter((polygon) => polygon.length >= 8 && polygonArea(polygon) >= minArea)
    .sort((left, right) => polygonArea(right) - polygonArea(left));
}

function isSeedableLandPart(polygon: Point[], config: MapGenerationConfig): boolean {
  return polygonArea(polygon) >= getMinSeedableLandPartArea(config);
}

function getMinVisibleLandPartArea(config: MapGenerationConfig): number {
  if (config.worldType === "archipelago") {
    return 0.0028;
  }

  if (config.worldType === "twinContinents") {
    return 0.0035;
  }

  return 0.0045;
}

function getMinSeedableLandPartArea(config: MapGenerationConfig): number {
  if (config.worldType === "archipelago") {
    return 0.014;
  }

  if (config.worldType === "twinContinents") {
    return 0.02;
  }

  return 0.045;
}

function createFallbackContinent(config: MapGenerationConfig): Point[][] {
  const rng = createSeededRandom(`${config.seed}:fallback-land`);
  const blob: LandBlob = {
    id: "fallback-main",
    cx: 0.5,
    cy: 0.52,
    rx: rng.float(0.38, 0.43),
    ry: rng.float(0.31, 0.37),
    strength: 1.08,
    asLandPart: true
  };
  const supportBlobs = [
    blob,
    {
      id: "fallback-north",
      cx: rng.float(0.42, 0.58),
      cy: rng.float(0.22, 0.34),
      rx: rng.float(0.16, 0.22),
      ry: rng.float(0.1, 0.16),
      strength: 0.34,
      asLandPart: false
    },
    {
      id: "fallback-south",
      cx: rng.float(0.4, 0.6),
      cy: rng.float(0.68, 0.78),
      rx: rng.float(0.14, 0.22),
      ry: rng.float(0.1, 0.16),
      strength: 0.3,
      asLandPart: false
    }
  ];
  return [createLandPolygon(blob, config, supportBlobs)];
}

function createLandBlobs(config: MapGenerationConfig): LandBlob[] {
  const rng = createSeededRandom(`${config.seed}:land`);
  if (config.worldType === "archipelago") {
    const count = rng.int(12, 16);
    return Array.from({ length: count }, (_, index) => ({
      id: `island-${index + 1}`,
      cx: rng.float(0.14, 0.86),
      cy: rng.float(0.16, 0.84),
      rx: rng.float(0.055, 0.17),
      ry: rng.float(0.045, 0.15),
      strength: rng.float(0.74, 1.04),
      asLandPart: true
    }));
  }

  if (config.worldType === "twinContinents") {
    return [
      {
        id: "west",
        cx: rng.float(0.33, 0.4),
        cy: rng.float(0.44, 0.56),
        rx: rng.float(0.24, 0.32),
        ry: rng.float(0.27, 0.38),
        strength: 1,
        asLandPart: true
      },
      {
        id: "east",
        cx: rng.float(0.62, 0.7),
        cy: rng.float(0.38, 0.54),
        rx: rng.float(0.24, 0.33),
        ry: rng.float(0.25, 0.36),
        strength: 0.98,
        asLandPart: true
      },
      ...createRuggedIslandChainBlobs(rng),
      ...createSatelliteBlobs(rng, 5, false)
    ];
  }

  return [
    {
      id: "main",
      cx: rng.float(0.46, 0.54),
      cy: rng.float(0.45, 0.56),
      rx: rng.float(0.36, 0.44),
      ry: rng.float(0.31, 0.4),
      strength: 1,
      asLandPart: true
    },
    {
      id: "north-bump",
      cx: rng.float(0.4, 0.62),
      cy: rng.float(0.19, 0.32),
      rx: rng.float(0.16, 0.24),
      ry: rng.float(0.11, 0.19),
      strength: 0.42,
      asLandPart: false
    },
    {
      id: "south-bump",
      cx: rng.float(0.35, 0.65),
      cy: rng.float(0.66, 0.78),
      rx: rng.float(0.13, 0.24),
      ry: rng.float(0.1, 0.18),
      strength: 0.38,
      asLandPart: false
    },
    ...createSatelliteBlobs(rng, 6, false)
  ];
}

function createRuggedIslandChainBlobs(rng: SeededRandom): LandBlob[] {
  const chainAnchors = [
    { x: 0.47, y: 0.26, dx: 0.19, dy: 0.06, count: 4 },
    { x: 0.5, y: 0.5, dx: 0.16, dy: 0.1, count: 5 },
    { x: 0.48, y: 0.74, dx: 0.22, dy: 0.08, count: 4 },
    { x: 0.18, y: 0.78, dx: 0.1, dy: 0.08, count: 3 },
    { x: 0.82, y: 0.22, dx: 0.1, dy: 0.08, count: 3 }
  ];
  const blobs: LandBlob[] = [];

  for (const [anchorIndex, anchor] of chainAnchors.entries()) {
    for (let index = 0; index < anchor.count; index += 1) {
      const ratio = anchor.count === 1 ? 0.5 : index / (anchor.count - 1);
      blobs.push({
        id: `chain-${anchorIndex + 1}-${index + 1}`,
        cx: clamp01(anchor.x + (ratio - 0.5) * anchor.dx + rng.float(-0.035, 0.035)),
        cy: clamp01(anchor.y + Math.sin(ratio * Math.PI * 2) * anchor.dy + rng.float(-0.035, 0.035)),
        rx: rng.float(0.025, 0.078),
        ry: rng.float(0.02, 0.066),
        strength: rng.float(0.58, 0.88),
        asLandPart: true
      });
    }
  }

  return blobs;
}

function createSatelliteBlobs(
  rng: SeededRandom,
  count: number,
  asLandPart: boolean
): LandBlob[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `satellite-${index + 1}`,
    cx: rng.float(0.1, 0.9),
    cy: rng.float(0.16, 0.86),
    rx: rng.float(0.035, 0.13),
    ry: rng.float(0.03, 0.11),
    strength: rng.float(0.62, 0.94),
    asLandPart
  }));
}

function createLandPolygon(blob: LandBlob, config: MapGenerationConfig, blobs: LandBlob[]): Point[] {
  const polygon: Point[] = [];
  const maxScale = 1.42;
  const steps = getLandPolygonStepCount(blob);

  for (let index = 0; index < steps; index += 1) {
    const angle = (Math.PI * 2 * index) / steps;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    let lastLand = 0.08;

    for (let step = 1; step <= 80; step += 1) {
      const ratio = (step / 80) * maxScale;
      const point = {
        x: blob.cx + cos * blob.rx * ratio,
        y: blob.cy + sin * blob.ry * ratio
      };

      if (point.x <= 0.025 || point.x >= 0.975 || point.y <= 0.035 || point.y >= 0.965) {
        break;
      }

      if (heightAt(point.x, point.y, config, blobs) >= config.seaLevel) {
        lastLand = ratio;
      }
    }

    polygon.push({
      x: clamp01(blob.cx + cos * blob.rx * lastLand),
      y: clamp01(blob.cy + sin * blob.ry * lastLand)
    });
  }

  return polygon;
}

function getLandPolygonStepCount(blob: LandBlob): number {
  const ellipseArea = Math.PI * blob.rx * blob.ry;
  if (ellipseArea >= 0.07) {
    return LAND_POLYGON_STEPS;
  }

  if (ellipseArea >= 0.03) {
    return 116;
  }

  if (ellipseArea >= 0.012) {
    return 72;
  }

  return 28;
}

function createTerrainMap(
  width: number,
  height: number,
  config: MapGenerationConfig,
  landMask: Point[][] = []
): TerrainMap {
  const blobs = createLandBlobs(config);
  const heightGrid = createHeightGrid(TERRAIN_GRID_WIDTH, TERRAIN_GRID_HEIGHT, config, blobs);
  const heights: number[] = [];
  const moisture: number[] = [];
  const temperature: number[] = [];
  const biomes: Biome[] = [];

  for (let row = 0; row < TERRAIN_GRID_HEIGHT; row += 1) {
    for (let column = 0; column < TERRAIN_GRID_WIDTH; column += 1) {
      const x = (column + 0.5) / TERRAIN_GRID_WIDTH;
      const y = (row + 0.5) / TERRAIN_GRID_HEIGHT;
      const rawHeightValue = heightGrid.values[row * TERRAIN_GRID_WIDTH + column] ?? 0;
      const heightValue =
        landMask.length > 0 && landMask.some((polygon) => pointInPolygon({ x, y }, polygon))
          ? Math.max(rawHeightValue, config.seaLevel + 0.018)
          : rawHeightValue;
      heightGrid.values[row * TERRAIN_GRID_WIDTH + column] = heightValue;
      const moistureValue = moistureAt(x, y, heightValue, config);
      const temperatureValue = temperatureAt(x, y, heightValue, config);
      heights.push(round3(heightValue));
      moisture.push(round3(moistureValue));
      temperature.push(round3(temperatureValue));
      biomes.push(classifyBiome(heightValue, moistureValue, temperatureValue, config.seaLevel));
    }
  }

  return {
    width: TERRAIN_GRID_WIDTH,
    height: TERRAIN_GRID_HEIGHT,
    heights,
    moisture,
    temperature,
    biomes,
    coastline: extractLandPolygonsFromHeightGrid(heightGrid, config.seaLevel, config).map((polygon) =>
      scalePolygon(polygon, width, height)
    ),
    mountainRidges: createMountainRidges(width, height, heightGrid, biomes, config),
    contours: createHeightContours(width, height, heightGrid, config),
    riverBasins: []
  };
}

function createMountainRidges(
  width: number,
  height: number,
  heightGrid: HeightGrid,
  biomes: Biome[],
  config: MapGenerationConfig
): Point[][] {
  const rng = createSeededRandom(`${config.seed}:mountain-ridges`);
  const ridges: Point[][] = [];
  const threshold = Math.max(config.seaLevel + 0.22, 0.72);

  for (let row = 2; row < heightGrid.height - 2; row += 3) {
    for (let column = 2; column < heightGrid.width - 2; column += 3) {
      const index = row * heightGrid.width + column;
      const heightValue = heightGrid.values[index] ?? 0;
      const biome = biomes[index] ?? "ocean";
      if (
        heightValue < threshold ||
        (biome !== "mountain" && biome !== "snow") ||
        rng.next() > 0.44
      ) {
        continue;
      }

      const x = (column + 0.5) / heightGrid.width;
      const y = (row + 0.5) / heightGrid.height;
      const angle =
        fractalNoise(x * 8.5, y * 8.5, `${config.seed}:ridge-angle`, 2) * Math.PI * 2;
      const ridgeLength = rng.float(0.012, 0.028) * (0.75 + config.mountainStrength * 0.65);
      const curve = rng.float(-0.006, 0.006);
      ridges.push([
        {
          x: (x - Math.cos(angle) * ridgeLength) * width,
          y: (y - Math.sin(angle) * ridgeLength) * height
        },
        {
          x: (x + Math.cos(angle + Math.PI / 2) * curve) * width,
          y: (y + Math.sin(angle + Math.PI / 2) * curve) * height
        },
        {
          x: (x + Math.cos(angle) * ridgeLength) * width,
          y: (y + Math.sin(angle) * ridgeLength) * height
        }
      ]);

      if (ridges.length >= 90) {
        return ridges;
      }
    }
  }

  return ridges;
}

function createHeightContours(
  width: number,
  height: number,
  heightGrid: HeightGrid,
  config: MapGenerationConfig
): Point[][] {
  const contours: Point[][] = [];
  const levels = [config.seaLevel + 0.12, config.seaLevel + 0.24, config.seaLevel + 0.36];

  for (const level of levels) {
    for (let row = 1; row < heightGrid.height - 1; row += 4) {
      let runStart: Point | null = null;
      let previous: Point | null = null;
      for (let column = 1; column < heightGrid.width - 1; column += 1) {
        const index = row * heightGrid.width + column;
        const heightValue = heightGrid.values[index] ?? 0;
        const nextHeight = heightGrid.values[index + 1] ?? heightValue;
        const crosses = (heightValue <= level && nextHeight >= level) || (heightValue >= level && nextHeight <= level);
        const isLand = heightValue >= config.seaLevel + 0.03;

        if (crosses && isLand) {
          const point = {
            x: ((column + 0.5) / heightGrid.width) * width,
            y: ((row + 0.5) / heightGrid.height) * height
          };
          runStart ??= point;
          previous = point;
        } else if (runStart && previous && distanceSq(runStart, previous) > 120) {
          contours.push([runStart, previous]);
          runStart = null;
          previous = null;
        }
      }

      if (runStart && previous && distanceSq(runStart, previous) > 120) {
        contours.push([runStart, previous]);
      }

      if (contours.length >= 120) {
        return contours;
      }
    }
  }

  return contours;
}

function createRivers(width: number, height: number, config: MapGenerationConfig): River[] {
  const blobs = createLandBlobs(config);
  const rng = createSeededRandom(`${config.seed}:rivers`);
  const rivers: River[] = [];

  for (let riverIndex = 0; riverIndex < config.riverCount; riverIndex += 1) {
    const start = findRiverStart(config, blobs, rng);
    if (!start) {
      continue;
    }

    const points = traceRiver(start, config, blobs);
    if (points.length >= 5) {
      rivers.push({
        id: `river-${riverIndex + 1}`,
        points: points.map((point) => ({
          x: point.x * width,
          y: point.y * height
        }))
      });
    }
  }

  return rivers;
}

function findRiverStart(
  config: MapGenerationConfig,
  blobs: LandBlob[],
  rng: SeededRandom
): Point | null {
  for (let attempt = 0; attempt < 420; attempt += 1) {
    const point = {
      x: rng.float(0.08, 0.92),
      y: rng.float(0.08, 0.92)
    };
    const heightValue = heightAt(point.x, point.y, config, blobs);
    if (heightValue > config.seaLevel + 0.1) {
      return point;
    }
  }

  return null;
}

function traceRiver(start: Point, config: MapGenerationConfig, blobs: LandBlob[]): Point[] {
  const points: Point[] = [start];
  let current = start;
  const step = 1 / 82;

  for (let index = 0; index < RIVER_TRACE_STEPS; index += 1) {
    const currentHeight = heightAt(current.x, current.y, config, blobs);
    if (currentHeight <= config.seaLevel + 0.01) {
      break;
    }

    let bestPoint: Point | null = null;
    let bestHeight = currentHeight;
    for (let direction = 0; direction < 8; direction += 1) {
      const angle = (Math.PI * 2 * direction) / 8;
      const candidate = {
        x: clamp01(current.x + Math.cos(angle) * step),
        y: clamp01(current.y + Math.sin(angle) * step)
      };
      const candidateHeight = heightAt(candidate.x, candidate.y, config, blobs);
      if (candidateHeight < bestHeight) {
        bestHeight = candidateHeight;
        bestPoint = candidate;
      }
    }

    if (!bestPoint) {
      const seaVector = {
        x: current.x < 0.5 ? -step : step,
        y: current.y < 0.5 ? -step : step
      };
      bestPoint = {
        x: clamp01(current.x + seaVector.x),
        y: clamp01(current.y + seaVector.y)
      };
    }

    if (points.length === 1 || distanceSq(points[points.length - 1], bestPoint) > 0.00008) {
      points.push(bestPoint);
    }
    current = bestPoint;
  }

  return points;
}

function heightAt(x: number, y: number, config: MapGenerationConfig, blobs: LandBlob[]): number {
  let land = 0;
  for (const blob of blobs) {
    const dx = (x - blob.cx) / blob.rx;
    const dy = (y - blob.cy) / blob.ry;
    const distanceFromCenter = Math.sqrt(dx * dx + dy * dy);
    const contribution = Math.max(0, 1 - distanceFromCenter);
    land += contribution ** 1.55 * blob.strength;
  }

  const edge = Math.min(x, 1 - x, y, 1 - y);
  const edgeFalloff = clampNumber(edge * 9, 0, 1);
  const broadNoise = fractalNoise(x * 3.4, y * 3.4, `${config.seed}:broad`, 4);
  const ridgeNoise = Math.abs(fractalNoise(x * 9.2, y * 9.2, `${config.seed}:ridge`, 3) - 0.5) * 2;
  const coastNoise = fractalNoise(x * 22, y * 22, `${config.seed}:coast-height`, 3) - 0.5;
  const mountainLift = ridgeNoise * 0.18 * config.mountainStrength;
  const base = land * edgeFalloff + (broadNoise - 0.5) * 0.2 + coastNoise * 0.075 + mountainLift;
  return clampNumber(base, 0, 1);
}

function moistureAt(x: number, y: number, heightValue: number, config: MapGenerationConfig): number {
  const noise = fractalNoise(x * 4.8 + 12, y * 4.8 - 7, `${config.seed}:moisture`, 4);
  const seaBoost = heightValue < config.seaLevel + 0.08 ? 0.18 : 0;
  return clampNumber(config.moisture * 0.66 + noise * 0.34 + seaBoost, 0, 1);
}

function temperatureAt(x: number, y: number, heightValue: number, config: MapGenerationConfig): number {
  const latitude = Math.abs(y - 0.55) * 1.35;
  const noise = fractalNoise(x * 2.2 - 4, y * 2.2 + 9, `${config.seed}:temp`, 3);
  const altitudeCooling = Math.max(0, heightValue - config.seaLevel) * 0.72;
  return clampNumber(
    config.temperature * 0.62 + (1 - latitude) * 0.38 - altitudeCooling + (noise - 0.5) * 0.12,
    0,
    1
  );
}

function classifyBiome(
  heightValue: number,
  moistureValue: number,
  temperatureValue: number,
  seaLevel: number
): Biome {
  if (heightValue < seaLevel - 0.035) {
    return "ocean";
  }
  if (heightValue < seaLevel + 0.035) {
    return "coast";
  }
  if (heightValue > 0.83) {
    return temperatureValue < 0.35 ? "snow" : "mountain";
  }
  if (temperatureValue < 0.22) {
    return "snow";
  }
  if (moistureValue > 0.76) {
    return temperatureValue > 0.5 ? "wetland" : "forest";
  }
  if (moistureValue < 0.28 && temperatureValue > 0.42) {
    return "desert";
  }
  if (moistureValue > 0.54) {
    return "forest";
  }
  return "plains";
}

function fractalNoise(x: number, y: number, seed: string, octaves: number): number {
  let amplitude = 1;
  let frequency = 1;
  let total = 0;
  let max = 0;
  for (let octave = 0; octave < octaves; octave += 1) {
    total += valueNoise(x * frequency, y * frequency, `${seed}:${octave}`) * amplitude;
    max += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return max === 0 ? 0 : total / max;
}

function valueNoise(x: number, y: number, seed: string): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const sx = smoothstep(x - x0);
  const sy = smoothstep(y - y0);
  const n00 = hash2d(x0, y0, seed);
  const n10 = hash2d(x1, y0, seed);
  const n01 = hash2d(x0, y1, seed);
  const n11 = hash2d(x1, y1, seed);
  return lerp(lerp(n00, n10, sx), lerp(n01, n11, sx), sy);
}

function hash2d(x: number, y: number, seed: string): number {
  let hash = getStringHash(seed);
  hash ^= Math.imul(x + 374761393, 668265263);
  hash ^= Math.imul(y + 1442695041, 2246822519);
  hash = Math.imul(hash ^ (hash >>> 13), 1274126177);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 4294967296;
}

const stringHashCache = new Map<string, number>();

function getStringHash(value: string): number {
  const cached = stringHashCache.get(value);
  if (cached !== undefined) {
    return cached;
  }

  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const result = hash >>> 0;
  stringHashCache.set(value, result);
  return result;
}

function smoothstep(value: number): number {
  return value * value * (3 - 2 * value);
}

function lerp(left: number, right: number, t: number): number {
  return left + (right - left) * t;
}

function scalePolygon(polygon: Point[], width: number, height: number): Point[] {
  return polygon.map((point) => ({
    x: point.x * width,
    y: point.y * height
  }));
}

function distanceSq(left: Point, right: Point): number {
  return (left.x - right.x) ** 2 + (left.y - right.y) ** 2;
}

function isWorldType(value: unknown): value is FantasyWorldType {
  return value === "continent" || value === "twinContinents" || value === "archipelago";
}

function isMapViewMode(value: unknown): value is MapGenerationConfig["mapViewMode"] {
  return value === "political" || value === "terrain" || value === "mixed";
}

function clamp01(value: number): number {
  return clampNumber(value, 0, 1);
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
