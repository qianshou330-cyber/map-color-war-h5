import {
  createDefaultMapGenerationConfig,
  createFantasyEditableMapData,
  normalizeMapGenerationConfig
} from "../map/fantasy";
import type { EditableMapData, FantasyWorldType, MapGenerationConfig, Point } from "../types";
import { distance, polygonArea } from "../utils/geometry";

const STORAGE_KEY = "map-color-war-h5:editable-map";
const MIN_POLYGON_POINTS = 6;
const MIN_PART_AREA = 0.001;
const MIN_TOTAL_AREA = 0.05;
const DRAW_POINT_GAP = 0.008;
const SIMPLIFY_TOLERANCE = 0.006;
const MAX_POINTS_PER_PART = 180;

type MapEditorOptions = {
  root: HTMLElement;
  onGenerate: (data: EditableMapData) => void;
};

export type MapEditorController = {
  show: () => void;
  hide: () => void;
  getData: () => EditableMapData | null;
};

export function mountMapEditor({ root, onGenerate }: MapEditorOptions): MapEditorController {
  root.innerHTML = editorMarkup();

  const canvas = requiredElement<HTMLCanvasElement>(root, ".map-editor-canvas");
  const status = requiredElement<HTMLDivElement>(root, ".map-editor-status");
  const textarea = requiredElement<HTMLTextAreaElement>(root, ".map-editor-json");
  const seedInput = requiredElement<HTMLInputElement>(root, "[data-gen-field='seed']");
  const worldTypeInput = requiredElement<HTMLSelectElement>(root, "[data-gen-field='worldType']");
  const seaLevelInput = requiredElement<HTMLInputElement>(root, "[data-gen-field='seaLevel']");
  const mountainInput = requiredElement<HTMLInputElement>(root, "[data-gen-field='mountainStrength']");
  const moistureInput = requiredElement<HTMLInputElement>(root, "[data-gen-field='moisture']");
  const riverCountInput = requiredElement<HTMLInputElement>(root, "[data-gen-field='riverCount']");
  const randomSeedButton = requiredElement<HTMLButtonElement>(root, "[data-action='random-seed']");
  const fantasyPreviewButton = requiredElement<HTMLButtonElement>(root, "[data-action='fantasy-preview']");
  const undoButton = requiredElement<HTMLButtonElement>(root, "[data-action='undo']");
  const clearButton = requiredElement<HTMLButtonElement>(root, "[data-action='clear']");
  const saveButton = requiredElement<HTMLButtonElement>(root, "[data-action='save']");
  const advancedButton = requiredElement<HTMLButtonElement>(root, "[data-action='advanced']");
  const advancedPanel = requiredElement<HTMLDivElement>(root, ".map-editor-advanced");
  const exportButton = requiredElement<HTMLButtonElement>(root, "[data-action='export']");
  const importButton = requiredElement<HTMLButtonElement>(root, "[data-action='import']");
  const generateButton = requiredElement<HTMLButtonElement>(root, "[data-action='generate']");
  const context = getCanvasContext(canvas);

  let landParts: Point[][] = [];
  let currentGenerationConfig: MapGenerationConfig | undefined;
  let drawingPath: Point[] = [];
  let drawing = false;
  let canvasWidth = 1;
  let canvasHeight = 1;

  const savedMap = loadSavedEditableMap();
  if (savedMap) {
    landParts = savedMap.landParts.map((part) => part.polygon);
    currentGenerationConfig = savedMap.generationConfig;
    textarea.value = JSON.stringify(savedMap, null, 2);
    setGenerationForm(currentGenerationConfig ?? createDefaultMapGenerationConfig());
    setStatus("\u5df2\u8f7d\u5165\u672c\u673a\u4fdd\u5b58\u5730\u56fe");
  } else {
    setGenerationForm(createDefaultMapGenerationConfig());
    setStatus("\u8bf7\u62d6\u52a8\u753b\u51fa\u5730\u56fe\u8f6e\u5ed3");
  }

  const resizeObserver = new ResizeObserver(() => resizeCanvas());
  resizeObserver.observe(canvas.parentElement ?? root);
  resizeCanvas();

  canvas.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    currentGenerationConfig = undefined;
    drawing = true;
    drawingPath = [eventToPoint(event)];
    redraw();
  });

  canvas.addEventListener("pointermove", (event) => {
    if (!drawing) {
      return;
    }

    event.preventDefault();
    const point = eventToPoint(event);
    const previous = drawingPath[drawingPath.length - 1];
    if (!previous || distance(previous, point) >= DRAW_POINT_GAP) {
      drawingPath.push(point);
      redraw();
    }
  });

  canvas.addEventListener("pointerup", (event) => finishDrawing(event));
  canvas.addEventListener("pointercancel", (event) => finishDrawing(event));

  randomSeedButton.addEventListener("click", () => {
    seedInput.value = `fantasy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  });

  fantasyPreviewButton.addEventListener("click", () => {
    const data = createFantasyEditableMapData(readGenerationConfig());
    currentGenerationConfig = data.generationConfig;
    landParts = data.landParts.map((part) => part.polygon);
    textarea.value = JSON.stringify(data, null, 2);
    setGenerationForm(data.generationConfig ?? readGenerationConfig());
    setStatus("\u5df2\u751f\u6210 Fantasy \u5730\u56fe\u9884\u89c8\uff0c\u53ef\u4fdd\u5b58\u6216\u76f4\u63a5\u751f\u6210\u5730\u56fe");
    redraw();
  });

  undoButton.addEventListener("click", () => {
    landParts.pop();
    currentGenerationConfig = undefined;
    syncTextarea();
    setStatus(landParts.length ? "\u5df2\u64a4\u9500\u4e0a\u4e00\u5757\u9646\u5730" : "\u5730\u56fe\u5df2\u6e05\u7a7a");
    redraw();
  });

  clearButton.addEventListener("click", () => {
    landParts = [];
    currentGenerationConfig = undefined;
    drawingPath = [];
    textarea.value = "";
    setStatus("\u5730\u56fe\u5df2\u6e05\u7a7a");
    redraw();
  });

  saveButton.addEventListener("click", () => {
    const data = buildEditableMapData();
    if (!data) {
      return;
    }

    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    textarea.value = JSON.stringify(data, null, 2);
    setStatus("\u5df2\u4fdd\u5b58\u5230\u672c\u673a");
  });

  advancedButton.addEventListener("click", () => {
    const shouldShow = advancedPanel.hidden;
    advancedPanel.hidden = !shouldShow;
    advancedButton.textContent = shouldShow ? "\u6536\u8d77" : "\u5bfc\u5165/\u5bfc\u51fa";
    resizeCanvas();
  });

  exportButton.addEventListener("click", () => {
    const data = buildEditableMapData();
    if (!data) {
      return;
    }

    textarea.value = JSON.stringify(data, null, 2);
    textarea.focus();
    textarea.select();
    setStatus("\u5df2\u751f\u6210 JSON\uff0c\u53ef\u590d\u5236\u4fdd\u5b58");
  });

  importButton.addEventListener("click", () => {
    const imported = parseEditableMapData(textarea.value);
    if (!imported) {
      setStatus("\u5bfc\u5165\u5931\u8d25\uff1aJSON \u683c\u5f0f\u6216\u8f6e\u5ed3\u65e0\u6548");
      return;
    }

    landParts = imported.landParts.map((part) => part.polygon);
    currentGenerationConfig = imported.generationConfig;
    setGenerationForm(currentGenerationConfig ?? createDefaultMapGenerationConfig());
    textarea.value = JSON.stringify(imported, null, 2);
    setStatus("\u5df2\u5bfc\u5165\u5730\u56fe");
    redraw();
  });

  generateButton.addEventListener("click", () => {
    const data = buildEditableMapData();
    if (!data) {
      return;
    }

    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    onGenerate(data);
  });

  function finishDrawing(event: PointerEvent): void {
    if (!drawing) {
      return;
    }

    event.preventDefault();
    drawing = false;
    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }

    const polygon = cleanPolygon(drawingPath);
    drawingPath = [];

    const validation = validatePolygon(polygon);
    if (!validation.ok) {
      setStatus(validation.message);
      redraw();
      return;
    }

    landParts.push(polygon);
    syncTextarea();
    setStatus(`\u5df2\u6dfb\u52a0 ${landParts.length} \u5757\u9646\u5730`);
    redraw();
  }

  function buildEditableMapData(): EditableMapData | null {
    const validParts = landParts
      .map((polygon) => cleanPolygon(polygon))
      .filter((polygon) => validatePolygon(polygon).ok);

    if (validParts.length === 0) {
      setStatus("\u8bf7\u5148\u753b\u51fa\u81f3\u5c11\u4e00\u4e2a\u6709\u6548\u8f6e\u5ed3");
      return null;
    }

    const totalArea = validParts.reduce((sum, polygon) => sum + polygonArea(polygon), 0);
    if (totalArea < MIN_TOTAL_AREA) {
      setStatus("\u5730\u56fe\u8f6e\u5ed3\u592a\u5c0f\uff0c\u8bf7\u753b\u5f97\u66f4\u5927");
      return null;
    }

    return {
      version: 1,
      name: "\u81ea\u5b9a\u4e49\u5730\u56fe",
      landParts: validParts.map((polygon, index) => ({
        id: `custom-${index + 1}`,
        polygon
      })),
      ...(currentGenerationConfig
        ? { generationConfig: normalizeMapGenerationConfig(currentGenerationConfig) }
        : {})
    };
  }

  function syncTextarea(): void {
    const data = buildEditableMapDataWithoutStatus();
    textarea.value = data ? JSON.stringify(data, null, 2) : "";
  }

  function buildEditableMapDataWithoutStatus(): EditableMapData | null {
    const validParts = landParts
      .map((polygon) => cleanPolygon(polygon))
      .filter((polygon) => validatePolygon(polygon).ok);

    if (validParts.length === 0) {
      return null;
    }

    return {
      version: 1,
      name: "\u81ea\u5b9a\u4e49\u5730\u56fe",
      landParts: validParts.map((polygon, index) => ({
        id: `custom-${index + 1}`,
        polygon
      })),
      ...(currentGenerationConfig
        ? { generationConfig: normalizeMapGenerationConfig(currentGenerationConfig) }
        : {})
    };
  }

  function redraw(): void {
    context.clearRect(0, 0, canvasWidth, canvasHeight);
    context.fillStyle = "#0e1726";
    context.fillRect(0, 0, canvasWidth, canvasHeight);
    drawGrid();

    landParts.forEach((polygon, index) => drawPolygon(polygon, index));

    if (drawingPath.length > 1) {
      context.beginPath();
      drawingPath.forEach((point, index) => {
        const pixel = toPixel(point);
        if (index === 0) {
          context.moveTo(pixel.x, pixel.y);
        } else {
          context.lineTo(pixel.x, pixel.y);
        }
      });
      context.strokeStyle = "#19b7ff";
      context.lineWidth = 3;
      context.lineCap = "round";
      context.lineJoin = "round";
      context.stroke();
    }
  }

  function drawGrid(): void {
    context.save();
    context.strokeStyle = "rgba(255, 255, 255, 0.06)";
    context.lineWidth = 1;
    const step = 36;
    for (let x = 0; x <= canvasWidth; x += step) {
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, canvasHeight);
      context.stroke();
    }
    for (let y = 0; y <= canvasHeight; y += step) {
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(canvasWidth, y);
      context.stroke();
    }
    context.restore();
  }

  function drawPolygon(polygon: Point[], index: number): void {
    if (polygon.length < 3) {
      return;
    }

    context.beginPath();
    polygon.forEach((point, pointIndex) => {
      const pixel = toPixel(point);
      if (pointIndex === 0) {
        context.moveTo(pixel.x, pixel.y);
      } else {
        context.lineTo(pixel.x, pixel.y);
      }
    });
    context.closePath();
    context.fillStyle = index % 2 === 0 ? "rgba(25, 183, 255, 0.24)" : "rgba(124, 230, 170, 0.22)";
    context.strokeStyle = "rgba(223, 246, 255, 0.96)";
    context.lineWidth = 3;
    context.fill();
    context.stroke();
  }

  function resizeCanvas(): void {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvasWidth = Math.max(1, Math.round(rect.width));
    canvasHeight = Math.max(1, Math.round(rect.height));
    canvas.width = Math.round(canvasWidth * dpr);
    canvas.height = Math.round(canvasHeight * dpr);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    redraw();
  }

  function eventToPoint(event: PointerEvent): Point {
    const rect = canvas.getBoundingClientRect();
    return {
      x: clamp01((event.clientX - rect.left) / Math.max(1, rect.width)),
      y: clamp01((event.clientY - rect.top) / Math.max(1, rect.height))
    };
  }

  function toPixel(point: Point): Point {
    return {
      x: point.x * canvasWidth,
      y: point.y * canvasHeight
    };
  }

  function setStatus(message: string): void {
    status.textContent = message;
  }

  function readGenerationConfig(): MapGenerationConfig {
    return normalizeMapGenerationConfig({
      seed: seedInput.value.trim(),
      worldType: worldTypeInput.value as FantasyWorldType,
      seaLevel: Number(seaLevelInput.value),
      mountainStrength: Number(mountainInput.value),
      moisture: Number(moistureInput.value),
      riverCount: Number(riverCountInput.value)
    });
  }

  function setGenerationForm(config: MapGenerationConfig): void {
    seedInput.value = config.seed;
    worldTypeInput.value = config.worldType;
    seaLevelInput.value = String(config.seaLevel);
    mountainInput.value = String(config.mountainStrength);
    moistureInput.value = String(config.moisture);
    riverCountInput.value = String(config.riverCount);
  }

  return {
    show() {
      root.hidden = false;
      resizeCanvas();
    },
    hide() {
      root.hidden = true;
    },
    getData() {
      return buildEditableMapDataWithoutStatus();
    }
  };
}

function editorMarkup(): string {
  return `
    <section class="map-editor">
      <div class="map-editor-header">
        <div class="map-editor-title">\u7ba1\u7406\u5458\u5730\u56fe\u7f16\u8f91\u5668</div>
        <div class="map-editor-status" aria-live="polite"></div>
      </div>
      <div class="map-editor-canvas-wrap">
        <canvas class="map-editor-canvas"></canvas>
      </div>
      <div class="map-editor-panel">
        <div class="map-editor-generator">
          <div class="map-editor-generator-title">Fantasy 自动生成</div>
          <div class="map-editor-generator-grid">
            <label>
              <span>Seed</span>
              <input data-gen-field="seed" type="text" spellcheck="false" />
            </label>
            <label>
              <span>大陆类型</span>
              <select data-gen-field="worldType">
                <option value="continent">大陆</option>
                <option value="twinContinents">双大陆</option>
                <option value="archipelago">群岛</option>
              </select>
            </label>
            <label>
              <span>海平面</span>
              <input data-gen-field="seaLevel" type="range" min="0.35" max="0.6" step="0.01" />
            </label>
            <label>
              <span>山脉</span>
              <input data-gen-field="mountainStrength" type="range" min="0.15" max="1" step="0.01" />
            </label>
            <label>
              <span>湿度</span>
              <input data-gen-field="moisture" type="range" min="0.15" max="1" step="0.01" />
            </label>
            <label>
              <span>河流</span>
              <input data-gen-field="riverCount" type="number" min="0" max="20" step="1" />
            </label>
          </div>
          <div class="map-editor-generator-actions">
            <button type="button" data-action="random-seed">随机 Seed</button>
            <button type="button" data-action="fantasy-preview">生成预览</button>
          </div>
        </div>
        <div class="map-editor-actions">
          <button type="button" data-action="undo">\u64a4\u9500</button>
          <button type="button" data-action="clear">\u6e05\u7a7a</button>
          <button type="button" data-action="save">\u4fdd\u5b58</button>
          <button type="button" data-action="advanced">\u5bfc\u5165/\u5bfc\u51fa</button>
          <button type="button" data-action="generate" class="map-editor-primary">\u751f\u6210\u5730\u56fe</button>
        </div>
        <div class="map-editor-advanced" hidden>
          <div class="map-editor-advanced-actions">
            <button type="button" data-action="export">\u5bfc\u51fa JSON</button>
            <button type="button" data-action="import">\u5bfc\u5165 JSON</button>
          </div>
          <textarea class="map-editor-json" spellcheck="false" placeholder="JSON"></textarea>
        </div>
      </div>
    </section>
  `;
}

export function loadSavedEditableMap(): EditableMapData | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? parseEditableMapData(raw) : null;
  } catch {
    return null;
  }
}

function parseEditableMapData(raw: string): EditableMapData | null {
  try {
    const value = JSON.parse(raw) as Partial<EditableMapData>;
    if (!value || !Array.isArray(value.landParts)) {
      return null;
    }

    const landParts = value.landParts.flatMap((part, index) => {
      if (!part || !Array.isArray(part.polygon)) {
        return [];
      }

      const polygon = cleanPolygon(
        part.polygon.map((point) => ({
          x: clamp01(Number(point.x)),
          y: clamp01(Number(point.y))
        }))
      );

      return validatePolygon(polygon).ok
        ? [
            {
              id: typeof part.id === "string" && part.id ? part.id : `custom-${index + 1}`,
              polygon
            }
          ]
        : [];
    });

    if (landParts.length === 0) {
      return null;
    }

    const data: EditableMapData = {
      version: 1,
      name: typeof value.name === "string" && value.name ? value.name : "\u81ea\u5b9a\u4e49\u5730\u56fe",
      landParts,
      ...(value.generationConfig
        ? { generationConfig: normalizeMapGenerationConfig(value.generationConfig) }
        : {})
    };

    const totalArea = data.landParts.reduce((sum, part) => sum + polygonArea(part.polygon), 0);
    return totalArea >= MIN_TOTAL_AREA ? data : null;
  } catch {
    return null;
  }
}

function cleanPolygon(points: Point[]): Point[] {
  const finitePoints = points
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .map((point) => ({
      x: clamp01(point.x),
      y: clamp01(point.y)
    }));
  const deduped = removeClosePoints(finitePoints);
  const simplified = simplifyPoints(deduped, SIMPLIFY_TOLERANCE);
  return limitPoints(removeClosePoints(simplified), MAX_POINTS_PER_PART);
}

function validatePolygon(polygon: Point[]): { ok: true } | { ok: false; message: string } {
  if (polygon.length < MIN_POLYGON_POINTS) {
    return { ok: false, message: "\u8f6e\u5ed3\u70b9\u592a\u5c11\uff0c\u8bf7\u753b\u5f97\u66f4\u5b8c\u6574" };
  }

  if (polygonArea(polygon) < MIN_PART_AREA) {
    return { ok: false, message: "\u8f6e\u5ed3\u592a\u5c0f\uff0c\u8bf7\u753b\u5f97\u66f4\u5927" };
  }

  if (hasSelfIntersection(polygon)) {
    return { ok: false, message: "\u8f6e\u5ed3\u6709\u4ea4\u53c9\uff0c\u8bf7\u91cd\u65b0\u753b\u4e00\u7b14" };
  }

  return { ok: true };
}

function removeClosePoints(points: Point[]): Point[] {
  const result: Point[] = [];
  for (const point of points) {
    const previous = result[result.length - 1];
    if (!previous || distance(previous, point) >= DRAW_POINT_GAP) {
      result.push(point);
    }
  }

  if (result.length > 1 && distance(result[0], result[result.length - 1]) < DRAW_POINT_GAP) {
    result.pop();
  }

  return result;
}

function simplifyPoints(points: Point[], tolerance: number): Point[] {
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

  const left = simplifyPoints(points.slice(0, splitIndex + 1), tolerance);
  const right = simplifyPoints(points.slice(splitIndex), tolerance);
  return [...left.slice(0, -1), ...right];
}

function limitPoints(points: Point[], maxPoints: number): Point[] {
  if (points.length <= maxPoints) {
    return points;
  }

  const step = Math.ceil(points.length / maxPoints);
  return points.filter((_, index) => index % step === 0).slice(0, maxPoints);
}

function distanceToLine(point: Point, start: Point, end: Point): number {
  const lengthSquared = (end.x - start.x) ** 2 + (end.y - start.y) ** 2;
  if (lengthSquared === 0) {
    return distance(point, start);
  }

  const area = Math.abs(
    (end.x - start.x) * (start.y - point.y) -
      (start.x - point.x) * (end.y - start.y)
  );
  return area / Math.sqrt(lengthSquared);
}

function hasSelfIntersection(polygon: Point[]): boolean {
  for (let leftIndex = 0; leftIndex < polygon.length; leftIndex += 1) {
    const leftStart = polygon[leftIndex];
    const leftEnd = polygon[(leftIndex + 1) % polygon.length];

    for (let rightIndex = leftIndex + 1; rightIndex < polygon.length; rightIndex += 1) {
      if (
        Math.abs(leftIndex - rightIndex) <= 1 ||
        (leftIndex === 0 && rightIndex === polygon.length - 1)
      ) {
        continue;
      }

      const rightStart = polygon[rightIndex];
      const rightEnd = polygon[(rightIndex + 1) % polygon.length];
      if (segmentsIntersect(leftStart, leftEnd, rightStart, rightEnd)) {
        return true;
      }
    }
  }

  return false;
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  return o1 !== o2 && o3 !== o4;
}

function orientation(a: Point, b: Point, c: Point): number {
  const value = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  if (Math.abs(value) < 0.000001) {
    return 0;
  }
  return value > 0 ? 1 : -1;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

function requiredElement<T extends HTMLElement>(root: HTMLElement, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Map editor element missing: ${selector}`);
  }
  return element;
}

function getCanvasContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Map editor canvas context is unavailable");
  }
  return context;
}
