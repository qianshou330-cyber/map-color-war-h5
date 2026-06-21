import type { Point } from "../types";
import { polygonArea } from "../utils/geometry";

export type ImageTraceOptions = {
  landThreshold: number;
  alphaThreshold: number;
  minIslandArea: number;
  smoothing: number;
  maxMainPoints: number;
  maxMediumPoints: number;
  maxSmallPoints: number;
};

export type ImageTraceResult = {
  polygons: Point[][];
  removedComponents: number;
  sourceSize: {
    width: number;
    height: number;
  };
};

type Cell = {
  column: number;
  row: number;
};

type PixelPoint = {
  x: number;
  y: number;
};

type PixelEdge = {
  start: PixelPoint;
  end: PixelPoint;
};

const DEFAULT_TRACE_OPTIONS: ImageTraceOptions = {
  landThreshold: 154,
  alphaThreshold: 24,
  minIslandArea: 0.00035,
  smoothing: 1,
  maxMainPoints: 260,
  maxMediumPoints: 96,
  maxSmallPoints: 32
};

export function traceLandPolygonsFromImageData(
  imageData: ImageData,
  partialOptions: Partial<ImageTraceOptions> = {}
): ImageTraceResult {
  const options = normalizeTraceOptions(partialOptions);
  const { width, height, data } = imageData;
  const landMask = openMask(createLandMask(data, width, height, options), width, height);
  const visited = new Uint8Array(width * height);
  const minPixelArea = Math.max(10, Math.round(width * height * options.minIslandArea));
  const polygons: Point[][] = [];
  let removedComponents = 0;

  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const index = row * width + column;
      if (visited[index] || !landMask[index]) {
        continue;
      }

      const component = collectComponent(column, row, width, height, landMask, visited);
      if (component.length < minPixelArea) {
        removedComponents += 1;
        continue;
      }

      const loop = getLargestBoundaryLoop(component, width, height);
      if (loop.length < 8) {
        removedComponents += 1;
        continue;
      }

      const normalized = loop.map((point) => ({
        x: clamp01(point.x / width),
        y: clamp01(point.y / height)
      }));
      const cleaned = preparePolygon(normalized, options);
      if (cleaned.length < 8 || polygonArea(cleaned) < options.minIslandArea) {
        removedComponents += 1;
        continue;
      }

      polygons.push(cleaned);
    }
  }

  return {
    polygons: fitPolygonsToUnitBox(polygons.sort((left, right) => polygonArea(right) - polygonArea(left))),
    removedComponents,
    sourceSize: { width, height }
  };
}

function normalizeTraceOptions(partialOptions: Partial<ImageTraceOptions>): ImageTraceOptions {
  return {
    landThreshold: clampNumber(
      Math.round(partialOptions.landThreshold ?? DEFAULT_TRACE_OPTIONS.landThreshold),
      40,
      245
    ),
    alphaThreshold: clampNumber(
      Math.round(partialOptions.alphaThreshold ?? DEFAULT_TRACE_OPTIONS.alphaThreshold),
      0,
      255
    ),
    minIslandArea: clampNumber(
      Number(partialOptions.minIslandArea ?? DEFAULT_TRACE_OPTIONS.minIslandArea),
      0.00004,
      0.01
    ),
    smoothing: Math.round(clampNumber(Number(partialOptions.smoothing ?? DEFAULT_TRACE_OPTIONS.smoothing), 0, 3)),
    maxMainPoints: Math.round(
      clampNumber(Number(partialOptions.maxMainPoints ?? DEFAULT_TRACE_OPTIONS.maxMainPoints), 180, 280)
    ),
    maxMediumPoints: Math.round(
      clampNumber(Number(partialOptions.maxMediumPoints ?? DEFAULT_TRACE_OPTIONS.maxMediumPoints), 40, 140)
    ),
    maxSmallPoints: Math.round(
      clampNumber(Number(partialOptions.maxSmallPoints ?? DEFAULT_TRACE_OPTIONS.maxSmallPoints), 12, 48)
    )
  };
}

function createLandMask(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options: ImageTraceOptions
): Uint8Array {
  const mask = new Uint8Array(width * height);

  for (let index = 0; index < width * height; index += 1) {
    const pixelIndex = index * 4;
    const red = data[pixelIndex] ?? 0;
    const green = data[pixelIndex + 1] ?? 0;
    const blue = data[pixelIndex + 2] ?? 0;
    const alpha = data[pixelIndex + 3] ?? 255;
    const maxChannel = Math.max(red, green, blue);
    const minChannel = Math.min(red, green, blue);
    const brightness = (red + green + blue) / 3;
    const saturation = maxChannel - minChannel;
    const blueDominance = blue - Math.max(red, green);
    const isOceanBlue = blue > 105 && blueDominance > 22 && saturation > 32;
    const isLand =
      alpha >= options.alphaThreshold &&
      brightness >= options.landThreshold &&
      !isOceanBlue;

    mask[index] = isLand ? 1 : 0;
  }

  return mask;
}

function openMask(mask: Uint8Array, width: number, height: number): Uint8Array {
  return dilateMask(erodeMask(mask, width, height), width, height);
}

function erodeMask(mask: Uint8Array, width: number, height: number): Uint8Array {
  const result = new Uint8Array(mask.length);
  for (let row = 1; row < height - 1; row += 1) {
    for (let column = 1; column < width - 1; column += 1) {
      let keep = true;
      for (let dy = -1; dy <= 1 && keep; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (!mask[(row + dy) * width + column + dx]) {
            keep = false;
            break;
          }
        }
      }
      result[row * width + column] = keep ? 1 : 0;
    }
  }
  return result;
}

function dilateMask(mask: Uint8Array, width: number, height: number): Uint8Array {
  const result = new Uint8Array(mask.length);
  for (let row = 1; row < height - 1; row += 1) {
    for (let column = 1; column < width - 1; column += 1) {
      if (!mask[row * width + column]) {
        continue;
      }

      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          result[(row + dy) * width + column + dx] = 1;
        }
      }
    }
  }
  return result;
}

function collectComponent(
  startColumn: number,
  startRow: number,
  width: number,
  height: number,
  landMask: Uint8Array,
  visited: Uint8Array
): Cell[] {
  const stack: Cell[] = [{ column: startColumn, row: startRow }];
  const component: Cell[] = [];

  while (stack.length > 0) {
    const cell = stack.pop();
    if (!cell) {
      continue;
    }

    if (
      cell.column < 0 ||
      cell.column >= width ||
      cell.row < 0 ||
      cell.row >= height
    ) {
      continue;
    }

    const index = cell.row * width + cell.column;
    if (visited[index] || !landMask[index]) {
      continue;
    }

    visited[index] = 1;
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

function getLargestBoundaryLoop(component: Cell[], width: number, height: number): PixelPoint[] {
  const loops = traceBoundaryLoops(component, width, height);
  return loops.sort((left, right) => Math.abs(pixelPolygonArea(right)) - Math.abs(pixelPolygonArea(left)))[0] ?? [];
}

function traceBoundaryLoops(component: Cell[], width: number, height: number): PixelPoint[][] {
  const cells = new Set(component.map((cell) => cellKey(cell.column, cell.row)));
  const edgeMap = new Map<string, PixelEdge[]>();

  for (const cell of component) {
    const { column, row } = cell;
    addBoundaryEdge(cells, edgeMap, width, height, column, row, column, row - 1, {
      start: { x: column, y: row },
      end: { x: column + 1, y: row }
    });
    addBoundaryEdge(cells, edgeMap, width, height, column, row, column + 1, row, {
      start: { x: column + 1, y: row },
      end: { x: column + 1, y: row + 1 }
    });
    addBoundaryEdge(cells, edgeMap, width, height, column, row, column, row + 1, {
      start: { x: column + 1, y: row + 1 },
      end: { x: column, y: row + 1 }
    });
    addBoundaryEdge(cells, edgeMap, width, height, column, row, column - 1, row, {
      start: { x: column, y: row + 1 },
      end: { x: column, y: row }
    });
  }

  const loops: PixelPoint[][] = [];
  while (edgeMap.size > 0) {
    const firstKey = edgeMap.keys().next().value as string | undefined;
    if (!firstKey) {
      break;
    }

    const firstEdge = shiftEdge(edgeMap, firstKey);
    if (!firstEdge) {
      continue;
    }

    const loop: PixelPoint[] = [firstEdge.start];
    const startKey = pixelPointKey(firstEdge.start);
    let current = firstEdge.end;
    let guard = 0;

    while (pixelPointKey(current) !== startKey && guard < component.length * 8 + 64) {
      loop.push(current);
      const edge = shiftEdge(edgeMap, pixelPointKey(current));
      if (!edge) {
        break;
      }
      current = edge.end;
      guard += 1;
    }

    if (loop.length >= 8) {
      loops.push(removePixelDuplicatePoints(loop));
    }
  }

  return loops;
}

function addBoundaryEdge(
  cells: Set<string>,
  edgeMap: Map<string, PixelEdge[]>,
  width: number,
  height: number,
  _column: number,
  _row: number,
  neighborColumn: number,
  neighborRow: number,
  edge: PixelEdge
): void {
  const isOutside =
    neighborColumn < 0 ||
    neighborColumn >= width ||
    neighborRow < 0 ||
    neighborRow >= height;
  if (!isOutside && cells.has(cellKey(neighborColumn, neighborRow))) {
    return;
  }

  const key = pixelPointKey(edge.start);
  const edges = edgeMap.get(key);
  if (edges) {
    edges.push(edge);
  } else {
    edgeMap.set(key, [edge]);
  }
}

function shiftEdge(edgeMap: Map<string, PixelEdge[]>, key: string): PixelEdge | undefined {
  const edges = edgeMap.get(key);
  if (!edges || edges.length === 0) {
    edgeMap.delete(key);
    return undefined;
  }

  const edge = edges.shift();
  if (edges.length === 0) {
    edgeMap.delete(key);
  }
  return edge;
}

function preparePolygon(points: Point[], options: ImageTraceOptions): Point[] {
  const smoothed = smoothClosedPolygon(removeAdjacentDuplicatePoints(points), options.smoothing);
  const area = polygonArea(smoothed);
  const targetCount = getTargetPointCount(area, options);
  return resampleClosedPolygon(removeAdjacentDuplicatePoints(smoothed), targetCount);
}

function getTargetPointCount(area: number, options: ImageTraceOptions): number {
  if (area >= 0.075) {
    return options.maxMainPoints;
  }

  if (area >= 0.012) {
    return options.maxMediumPoints;
  }

  return options.maxSmallPoints;
}

function smoothClosedPolygon(points: Point[], iterations: number): Point[] {
  let current = points;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    if (current.length < 4) {
      return current;
    }

    const next: Point[] = [];
    for (let index = 0; index < current.length; index += 1) {
      const left = current[index];
      const right = current[(index + 1) % current.length];
      next.push({
        x: left.x * 0.76 + right.x * 0.24,
        y: left.y * 0.76 + right.y * 0.24
      });
      next.push({
        x: left.x * 0.24 + right.x * 0.76,
        y: left.y * 0.24 + right.y * 0.76
      });
    }
    current = next;
  }
  return current;
}

function resampleClosedPolygon(points: Point[], targetCount: number): Point[] {
  if (points.length <= targetCount) {
    return points;
  }

  const distances: number[] = [];
  let perimeter = 0;
  for (let index = 0; index < points.length; index += 1) {
    const start = points[index];
    const end = points[(index + 1) % points.length];
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    distances.push(length);
    perimeter += length;
  }

  if (perimeter <= 0) {
    return points.slice(0, targetCount);
  }

  const result: Point[] = [];
  for (let pointIndex = 0; pointIndex < targetCount; pointIndex += 1) {
    const targetDistance = (perimeter * pointIndex) / targetCount;
    let traveled = 0;

    for (let segmentIndex = 0; segmentIndex < points.length; segmentIndex += 1) {
      const segmentLength = distances[segmentIndex] ?? 0;
      if (traveled + segmentLength >= targetDistance) {
        const start = points[segmentIndex];
        const end = points[(segmentIndex + 1) % points.length];
        const ratio = segmentLength === 0 ? 0 : (targetDistance - traveled) / segmentLength;
        result.push({
          x: start.x + (end.x - start.x) * ratio,
          y: start.y + (end.y - start.y) * ratio
        });
        break;
      }
      traveled += segmentLength;
    }
  }

  return removeAdjacentDuplicatePoints(result);
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
  const scale = Math.min((1 - padding * 2) / width, (1 - padding * 2) / height);
  const offsetX = (1 - width * scale) / 2;
  const offsetY = (1 - height * scale) / 2;

  return polygons.map((polygon) =>
    polygon.map((point) => ({
      x: clamp01(offsetX + (point.x - minX) * scale),
      y: clamp01(offsetY + (point.y - minY) * scale)
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

function removePixelDuplicatePoints(points: PixelPoint[]): PixelPoint[] {
  const result: PixelPoint[] = [];
  for (const point of points) {
    const previous = result[result.length - 1];
    if (!previous || previous.x !== point.x || previous.y !== point.y) {
      result.push(point);
    }
  }
  return result;
}

function pixelPolygonArea(points: PixelPoint[]): number {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }
  return area / 2;
}

function cellKey(column: number, row: number): string {
  return `${column}:${row}`;
}

function pixelPointKey(point: PixelPoint): string {
  return `${point.x}:${point.y}`;
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
