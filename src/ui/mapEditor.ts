import {
  createDefaultMapGenerationConfig,
  createFantasyEditableMapData,
  normalizeMapGenerationConfig
} from "../map/fantasy";
import { importPolygonsFromGeoJsonText } from "../map/geojsonImport";
import { traceLandPolygonsFromImageData } from "../map/imageTrace";
import type { EditableMapData, FantasyWorldType, MapGenerationConfig, Point } from "../types";
import { distance, polygonArea } from "../utils/geometry";

const STORAGE_KEY = "map-color-war-h5:editable-map";
const MIN_POLYGON_POINTS = 6;
const MIN_PART_AREA = 0.00025;
const MIN_TOTAL_AREA = 0.05;
const DRAW_POINT_GAP = 0.008;
const SIMPLIFY_TOLERANCE = 0.0015;
const MAX_POINTS_PER_PART = 280;
const MAX_TRACE_IMAGE_SIZE = 720;

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
  upgradeAzgaarGeneratorMarkup(root);
  upgradeGeoJsonImportMarkup(root);

  const canvas = requiredElement<HTMLCanvasElement>(root, ".map-editor-canvas");
  const status = requiredElement<HTMLDivElement>(root, ".map-editor-status");
  const textarea = requiredElement<HTMLTextAreaElement>(root, ".map-editor-json");
  const seedInput = requiredElement<HTMLInputElement>(root, "[data-gen-field='seed']");
  const worldTypeInput = requiredElement<HTMLSelectElement>(root, "[data-gen-field='worldType']");
  const seaLevelInput = requiredElement<HTMLInputElement>(root, "[data-gen-field='seaLevel']");
  const mountainInput = requiredElement<HTMLInputElement>(root, "[data-gen-field='mountainStrength']");
  const moistureInput = requiredElement<HTMLInputElement>(root, "[data-gen-field='moisture']");
  const temperatureInput = requiredElement<HTMLInputElement>(root, "[data-gen-field='temperature']");
  const riverCountInput = requiredElement<HTMLInputElement>(root, "[data-gen-field='riverCount']");
  const mapViewModeInput = requiredElement<HTMLSelectElement>(root, "[data-gen-field='mapViewMode']");
  const randomSeedButton = requiredElement<HTMLButtonElement>(root, "[data-action='random-seed']");
  const fantasyPreviewButton = requiredElement<HTMLButtonElement>(root, "[data-action='fantasy-preview']");
  const imageFileInput = requiredElement<HTMLInputElement>(root, "[data-image-field='file']");
  const imageThresholdInput = requiredElement<HTMLInputElement>(root, "[data-image-field='threshold']");
  const imageSmoothingInput = requiredElement<HTMLInputElement>(root, "[data-image-field='smoothing']");
  const imageMinIslandInput = requiredElement<HTMLInputElement>(root, "[data-image-field='minIslandArea']");
  const imageTraceButton = requiredElement<HTMLButtonElement>(root, "[data-action='image-trace']");
  const geoJsonFileInput = requiredElement<HTMLInputElement>(root, "[data-geojson-field='file']");
  const geoJsonMinPartInput = requiredElement<HTMLInputElement>(root, "[data-geojson-field='minPartArea']");
  const geoJsonSimplifyInput = requiredElement<HTMLInputElement>(root, "[data-geojson-field='simplify']");
  const geoJsonInvertYInput = requiredElement<HTMLInputElement>(root, "[data-geojson-field='invertY']");
  const geoJsonUnionInput = requiredElement<HTMLInputElement>(root, "[data-geojson-field='union']");
  const geoJsonImportButton = requiredElement<HTMLButtonElement>(root, "[data-action='geojson-import']");
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
  let currentSourceAspectRatio: number | undefined;
  let drawingPath: Point[] = [];
  let drawing = false;
  let canvasWidth = 1;
  let canvasHeight = 1;

  const savedMap = loadSavedEditableMap();
  if (savedMap) {
    landParts = savedMap.landParts.map((part) => part.polygon);
    currentGenerationConfig = savedMap.generationConfig;
    currentSourceAspectRatio = savedMap.sourceAspectRatio;
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
    currentSourceAspectRatio = undefined;
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
    currentSourceAspectRatio = undefined;
    landParts = data.landParts.map((part) => part.polygon);
    textarea.value = JSON.stringify(data, null, 2);
    setGenerationForm(data.generationConfig ?? readGenerationConfig());
    setStatus("\u5df2\u751f\u6210 Fantasy \u5730\u56fe\u9884\u89c8\uff0c\u53ef\u4fdd\u5b58\u6216\u76f4\u63a5\u751f\u6210\u5730\u56fe");
    redraw();
  });

  imageTraceButton.addEventListener("click", () => {
    const file = imageFileInput.files?.[0];
    if (!file) {
      setStatus("请先选择一张参考图");
      return;
    }

    setStatus("正在读取图片并提取陆地轮廓...");
    void traceImageFile(file)
      .then((result) => {
        if (result.polygons.length === 0) {
          setStatus("没有识别到有效陆地，请调低阈值或换一张陆海更分明的图");
          return;
        }

        landParts = result.polygons;
        currentSourceAspectRatio = result.sourceSize.width / Math.max(1, result.sourceSize.height);
        currentGenerationConfig = normalizeMapGenerationConfig({
          ...readGenerationConfig(),
          seed: `image-trace-${Date.now().toString(36)}`,
          worldType: "twinContinents",
          mapViewMode: "mixed"
        });
        setGenerationForm(currentGenerationConfig);
        syncTextarea();
        setStatus(
          `已提取 ${landParts.length} 块陆地，删除 ${result.removedComponents} 个噪点，可保存或生成地图`
        );
        redraw();
      })
      .catch(() => {
        setStatus("图片读取失败，请换一张 PNG/JPG 参考图");
      });
  });

  geoJsonImportButton.addEventListener("click", () => {
    const file = geoJsonFileInput.files?.[0];
    if (!file) {
      setStatus("请先选择 GeoJSON 或 Alternate History JSON 文件");
      return;
    }

    setStatus("正在读取 GeoJSON 并转换陆地轮廓...");
    void importGeoJsonFile(file)
      .then((result) => {
        if (result.polygons.length === 0) {
          setStatus("没有可用轮廓，请检查文件是否包含 Polygon 或 MultiPolygon");
          return;
        }

        landParts = result.polygons;
        currentSourceAspectRatio = result.sourceAspectRatio;
        currentGenerationConfig = normalizeMapGenerationConfig({
          ...readGenerationConfig(),
          seed: `geojson-import-${Date.now().toString(36)}`,
          worldType: "twinContinents",
          mapViewMode: "mixed"
        });
        setGenerationForm(currentGenerationConfig);
        syncTextarea();
        setStatus(
          `已导入 ${landParts.length} 块轮廓，读取 ${result.featureCount} 个面，过滤 ${result.removedParts} 个小碎片`
        );
        redraw();
      })
      .catch(() => {
        setStatus("导入失败：文件里没有可识别的 GeoJSON 轮廓");
      });
  });

  undoButton.addEventListener("click", () => {
    landParts.pop();
    currentGenerationConfig = undefined;
    currentSourceAspectRatio = undefined;
    syncTextarea();
    setStatus(landParts.length ? "\u5df2\u64a4\u9500\u4e0a\u4e00\u5757\u9646\u5730" : "\u5730\u56fe\u5df2\u6e05\u7a7a");
    redraw();
  });

  clearButton.addEventListener("click", () => {
    landParts = [];
    currentGenerationConfig = undefined;
    currentSourceAspectRatio = undefined;
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
    currentSourceAspectRatio = imported.sourceAspectRatio;
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
      ...(currentSourceAspectRatio
        ? { sourceAspectRatio: roundNumber(currentSourceAspectRatio, 4) }
        : {}),
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
      ...(currentSourceAspectRatio
        ? { sourceAspectRatio: roundNumber(currentSourceAspectRatio, 4) }
        : {}),
      ...(currentGenerationConfig
        ? { generationConfig: normalizeMapGenerationConfig(currentGenerationConfig) }
        : {})
    };
  }

  async function traceImageFile(file: File) {
    const image = await loadImage(file);
    const scale = Math.min(1, MAX_TRACE_IMAGE_SIZE / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const offscreen = document.createElement("canvas");
    offscreen.width = width;
    offscreen.height = height;
    const offscreenContext = offscreen.getContext("2d", { willReadFrequently: true });
    if (!offscreenContext) {
      throw new Error("Image trace canvas unavailable");
    }

    offscreenContext.drawImage(image, 0, 0, width, height);
    const imageData = offscreenContext.getImageData(0, 0, width, height);
    return traceLandPolygonsFromImageData(imageData, {
      landThreshold: Number(imageThresholdInput.value),
      smoothing: Number(imageSmoothingInput.value),
      minIslandArea: Number(imageMinIslandInput.value)
    });
  }

  async function importGeoJsonFile(file: File) {
    const text = await file.text();
    return importPolygonsFromGeoJsonText(text, {
      minPartArea: Number(geoJsonMinPartInput.value),
      simplifyTolerance: Number(geoJsonSimplifyInput.value),
      invertY: geoJsonInvertYInput.checked,
      unionFeatures: geoJsonUnionInput.checked
    });
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
      temperature: Number(temperatureInput.value),
      riverCount: Number(riverCountInput.value),
      mapViewMode: mapViewModeInput.value as MapGenerationConfig["mapViewMode"]
    });
  }

  function setGenerationForm(config: MapGenerationConfig): void {
    seedInput.value = config.seed;
    worldTypeInput.value = config.worldType;
    seaLevelInput.value = String(config.seaLevel);
    mountainInput.value = String(config.mountainStrength);
    moistureInput.value = String(config.moisture);
    temperatureInput.value = String(config.temperature);
    riverCountInput.value = String(config.riverCount);
    mapViewModeInput.value = config.mapViewMode;
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
        <div class="map-editor-image-trace">
          <div class="map-editor-image-title">图片描边生成</div>
          <div class="map-editor-image-grid">
            <label class="map-editor-file-field">
              <span>参考图</span>
              <input data-image-field="file" type="file" accept="image/png,image/jpeg,image/webp,image/gif" />
            </label>
            <label>
              <span>陆地阈值</span>
              <input data-image-field="threshold" type="range" min="80" max="235" step="1" value="154" />
            </label>
            <label>
              <span>平滑</span>
              <input data-image-field="smoothing" type="number" min="0" max="3" step="1" value="1" />
            </label>
            <label>
              <span>最小岛屿</span>
              <input data-image-field="minIslandArea" type="number" min="0.00004" max="0.01" step="0.00005" value="0.00035" />
            </label>
          </div>
          <div class="map-editor-image-actions">
            <button type="button" data-action="image-trace">提取轮廓</button>
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

function upgradeGeoJsonImportMarkup(root: HTMLElement): void {
  const imagePanel = root.querySelector<HTMLElement>(".map-editor-image-trace");
  if (!imagePanel || root.querySelector("[data-action='geojson-import']")) {
    return;
  }

  imagePanel.insertAdjacentHTML(
    "afterend",
    `
      <div class="map-editor-geojson-import">
        <div class="map-editor-geojson-title">GeoJSON / Alternate History 导入</div>
        <div class="map-editor-geojson-grid">
          <label class="map-editor-file-field">
            <span>地图 JSON</span>
            <input data-geojson-field="file" type="file" accept=".json,.geojson,application/json,application/geo+json" />
          </label>
          <label>
            <span>最小碎片</span>
            <input data-geojson-field="minPartArea" type="number" min="0.00001" max="0.05" step="0.00005" value="0.00025" />
          </label>
          <label>
            <span>简化强度</span>
            <input data-geojson-field="simplify" type="number" min="0" max="0.02" step="0.0002" value="0.0012" />
          </label>
          <label class="map-editor-check-field">
            <input data-geojson-field="invertY" type="checkbox" checked />
            <span>翻转 Y 轴</span>
          </label>
          <label class="map-editor-check-field">
            <input data-geojson-field="union" type="checkbox" checked />
            <span>合并区域</span>
          </label>
        </div>
        <div class="map-editor-geojson-actions">
          <button type="button" data-action="geojson-import">导入轮廓</button>
        </div>
      </div>
    `
  );
}

export function loadSavedEditableMap(): EditableMapData | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? parseEditableMapData(raw) : null;
  } catch {
    return null;
  }
}

function upgradeAzgaarGeneratorMarkup(root: HTMLElement): void {
  const title = root.querySelector<HTMLElement>(".map-editor-generator-title");
  if (title) {
    title.textContent = "Azgaar 风格生成";
  }

  const grid = root.querySelector<HTMLElement>(".map-editor-generator-grid");
  patchAzgaarGeneratorLabels(root);
  if (!grid || grid.querySelector("[data-gen-field='temperature']")) {
    return;
  }

  grid.insertAdjacentHTML(
    "beforeend",
    `
      <label>
        <span>温度</span>
        <input data-gen-field="temperature" type="range" min="0.1" max="1" step="0.01" />
      </label>
      <label>
        <span>地图视图</span>
        <select data-gen-field="mapViewMode">
          <option value="mixed">混合图</option>
          <option value="political">政治图</option>
          <option value="terrain">地形图</option>
        </select>
      </label>
    `
  );
  patchAzgaarGeneratorLabels(root);
}

function patchAzgaarGeneratorLabels(root: HTMLElement): void {
  const title = root.querySelector<HTMLElement>(".map-editor-generator-title");
  if (title) {
    title.textContent = "Azgaar 风格生成";
  }

  setFieldLabel(root, "worldType", "大陆类型");
  setFieldLabel(root, "seaLevel", "海平面");
  setFieldLabel(root, "mountainStrength", "山脉");
  setFieldLabel(root, "moisture", "湿度");
  setFieldLabel(root, "riverCount", "河流");
  setFieldLabel(root, "temperature", "温度");
  setFieldLabel(root, "mapViewMode", "地图视图");
  replaceSelectOptions(root, "worldType", [
    ["continent", "大陆"],
    ["twinContinents", "双大陆"],
    ["archipelago", "群岛"]
  ]);
  replaceSelectOptions(root, "mapViewMode", [
    ["mixed", "混合图"],
    ["political", "政治图"],
    ["terrain", "地形图"]
  ]);
  setActionText(root, "random-seed", "随机 Seed");
  setActionText(root, "fantasy-preview", "生成预览");
}

function setFieldLabel(root: HTMLElement, field: string, text: string): void {
  const input = root.querySelector<HTMLElement>(`[data-gen-field='${field}']`);
  const label = input?.closest("label")?.querySelector("span");
  if (label) {
    label.textContent = text;
  }
}

function replaceSelectOptions(
  root: HTMLElement,
  field: string,
  options: Array<[string, string]>
): void {
  const select = root.querySelector<HTMLSelectElement>(`select[data-gen-field='${field}']`);
  if (!select) {
    return;
  }

  const previousValue = select.value;
  select.replaceChildren(
    ...options.map(([value, text]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      return option;
    })
  );
  select.value = options.some(([value]) => value === previousValue) ? previousValue : options[0]?.[0] ?? "";
}

function setActionText(root: HTMLElement, action: string, text: string): void {
  const button = root.querySelector<HTMLButtonElement>(`[data-action='${action}']`);
  if (button) {
    button.textContent = text;
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
      ...(isValidAspectRatio(value.sourceAspectRatio)
        ? { sourceAspectRatio: Number(value.sourceAspectRatio) }
        : {}),
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

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Image load failed"));
    };
    image.src = url;
  });
}

function isValidAspectRatio(value: unknown): boolean {
  const ratio = Number(value);
  return Number.isFinite(ratio) && ratio >= 0.3 && ratio <= 4;
}

function roundNumber(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
