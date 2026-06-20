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
import { polygonArea } from "../utils/geometry";
import { createSeededRandom, type SeededRandom } from "../utils/seededRandom";

const TERRAIN_GRID_WIDTH = 160;
const TERRAIN_GRID_HEIGHT = 90;
const LAND_POLYGON_STEPS = 48;
const RIVER_TRACE_STEPS = 64;
const MIN_TOTAL_PLAYABLE_LAND_AREA = 0.18;

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
    worldType: "continent",
    seaLevel: 0.46,
    mountainStrength: 0.62,
    moisture: 0.56,
    riverCount: 8,
    countryCount: COUNTRY_COUNT,
    provincesPerCountry: PROVINCES_PER_COUNTRY,
    ...partial
  });
}

export function normalizeMapGenerationConfig(
  partial: Partial<MapGenerationConfig> = {}
): MapGenerationConfig {
  const worldType = isWorldType(partial.worldType) ? partial.worldType : "continent";
  return {
    seed: String(partial.seed || "fantasy-map"),
    worldType,
    seaLevel: clampNumber(Number(partial.seaLevel ?? 0.46), 0.35, 0.6),
    mountainStrength: clampNumber(Number(partial.mountainStrength ?? 0.62), 0.15, 1),
    moisture: clampNumber(Number(partial.moisture ?? 0.56), 0.15, 1),
    riverCount: Math.round(clampNumber(Number(partial.riverCount ?? 8), 0, 20)),
    countryCount: COUNTRY_COUNT,
    provincesPerCountry: PROVINCES_PER_COUNTRY
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
      ? filterPlayableLandParts(savedLandParts, generationConfig)
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
    return {
      id: `fantasy-${index + 1}`,
      minSeeds: Math.max(0, Math.floor(COUNTRY_COUNT * areaRatio * 0.58)),
      polygon: scalePolygon(polygon, width, height)
    };
  });

  return {
    id: "fantasy",
    name: "Fantasy World",
    landParts,
    outlinePolygons: landParts.map((part) => part.polygon),
    generationConfig,
    terrain: createTerrainMap(width, height, generationConfig),
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
  const playableParts = filterPlayableLandParts(
    blobs
    .filter((blob) => blob.asLandPart)
      .map((blob) => createLandPolygon(blob, config, blobs)),
    config
  );

  const totalArea = playableParts.reduce((sum, polygon) => sum + polygonArea(polygon), 0);
  return totalArea >= MIN_TOTAL_PLAYABLE_LAND_AREA
    ? playableParts
    : createFallbackContinent(config);
}

function filterPlayableLandParts(parts: Point[][], config: MapGenerationConfig): Point[][] {
  const minArea = getMinPlayableLandPartArea(config);
  return parts
    .filter((polygon) => polygon.length >= 8 && polygonArea(polygon) >= minArea)
    .sort((left, right) => polygonArea(right) - polygonArea(left));
}

function getMinPlayableLandPartArea(config: MapGenerationConfig): number {
  if (config.worldType === "archipelago") {
    return 0.018;
  }

  if (config.worldType === "twinContinents") {
    return 0.035;
  }

  return 0.08;
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
    const count = rng.int(7, 10);
    return Array.from({ length: count }, (_, index) => ({
      id: `island-${index + 1}`,
      cx: rng.float(0.14, 0.86),
      cy: rng.float(0.16, 0.84),
      rx: rng.float(0.09, 0.19),
      ry: rng.float(0.075, 0.16),
      strength: rng.float(0.82, 1.04),
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
      ...createSatelliteBlobs(rng, 4, false)
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
    ...createSatelliteBlobs(rng, 3, false)
  ];
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
    rx: rng.float(0.07, 0.14),
    ry: rng.float(0.055, 0.12),
    strength: rng.float(0.74, 0.94),
    asLandPart
  }));
}

function createLandPolygon(blob: LandBlob, config: MapGenerationConfig, blobs: LandBlob[]): Point[] {
  const polygon: Point[] = [];
  const maxScale = 1.42;

  for (let index = 0; index < LAND_POLYGON_STEPS; index += 1) {
    const angle = (Math.PI * 2 * index) / LAND_POLYGON_STEPS;
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

function createTerrainMap(width: number, height: number, config: MapGenerationConfig): TerrainMap {
  const blobs = createLandBlobs(config);
  const heights: number[] = [];
  const moisture: number[] = [];
  const temperature: number[] = [];
  const biomes: Biome[] = [];

  for (let row = 0; row < TERRAIN_GRID_HEIGHT; row += 1) {
    for (let column = 0; column < TERRAIN_GRID_WIDTH; column += 1) {
      const x = (column + 0.5) / TERRAIN_GRID_WIDTH;
      const y = (row + 0.5) / TERRAIN_GRID_HEIGHT;
      const heightValue = heightAt(x, y, config, blobs);
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
    biomes
  };
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
  const mountainLift = ridgeNoise * 0.18 * config.mountainStrength;
  const base = land * edgeFalloff + (broadNoise - 0.5) * 0.2 + mountainLift;
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
  return clampNumber(1 - latitude - altitudeCooling + (noise - 0.5) * 0.12, 0, 1);
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
