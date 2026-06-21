import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  createDefaultMapGenerationConfig,
  normalizeMapGenerationConfig
} from "../src/map/fantasy";
import { importPolygonsFromGeoJson } from "../src/map/geojsonImport";
import type { EditableMapData } from "../src/types";

const SCENARIO_URL =
  "https://raw.githubusercontent.com/Yulin-W/alternate-history-editor/master/Historic%20Scenarios/1206-Rise-of-Mongolia.json";
const ADMIN_MAP_URL =
  "https://raw.githubusercontent.com/Yulin-W/alternate-history-editor/master/docs/module/map_admin.js";
const OUTPUT_PATH = resolve("src/assets/defaultMaps/riseOfMongolia1206.json");

type AlternateHistoryScenario = {
  mapType?: string;
  customMap?: boolean;
  customMapGeojson?: unknown;
  entryDict?: Record<
    string,
    {
      order?: number;
      date?: string;
      event?: string;
      mapData?: Record<string, string>;
    }
  >;
};

type GeoJsonFeatureCollection = {
  type: "FeatureCollection";
  features: unknown[];
};

async function main(): Promise<void> {
  const scenario = await fetchJson<AlternateHistoryScenario>(SCENARIO_URL);
  if (scenario.mapType !== "admin") {
    throw new Error(`Expected scenario mapType=admin, got ${String(scenario.mapType)}`);
  }

  const scenarioEntry = getScenarioEntry(scenario);
  const regionIds = new Set(
    Object.keys(scenarioEntry.mapData ?? {})
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id >= 0)
  );
  if (regionIds.size === 0) {
    throw new Error("Scenario has no mapData region ids");
  }

  const adminMap = parseExportedGeoJson(await fetchText(ADMIN_MAP_URL), "geojson_admin");
  const filteredMap: GeoJsonFeatureCollection = {
    type: "FeatureCollection",
    features: adminMap.features.filter((_, index) => regionIds.has(index))
  };
  if (filteredMap.features.length === 0) {
    throw new Error("No admin map features matched the scenario region ids");
  }

  const imported = importPolygonsFromGeoJson(filteredMap, {
    minPartArea: 0.00035,
    simplifyTolerance: 0.0018,
    unionFeatures: true,
    invertY: true
  });
  if (imported.polygons.length === 0) {
    throw new Error("GeoJSON conversion produced no playable land parts");
  }

  const data: EditableMapData = {
    version: 1,
    name: "1206 Rise of Mongolia",
    sourceAspectRatio: Number(imported.sourceAspectRatio.toFixed(4)),
    landParts: imported.polygons.map((polygon, index) => ({
      id: `rise-of-mongolia-${index + 1}`,
      polygon
    })),
    generationConfig: normalizeMapGenerationConfig({
      ...createDefaultMapGenerationConfig(),
      seed: "rise-of-mongolia-1206",
      worldType: "twinContinents",
      mapViewMode: "mixed"
    })
  };

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(`${OUTPUT_PATH}`, `${JSON.stringify(data)}\n`, "utf8");

  console.log(
    JSON.stringify({
      output: OUTPUT_PATH,
      matchedFeatures: filteredMap.features.length,
      landParts: data.landParts.length,
      sourceAspectRatio: data.sourceAspectRatio,
      pointCounts: data.landParts.slice(0, 12).map((part) => part.polygon.length)
    })
  );
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      "user-agent": "map-color-war-h5-build-script"
    }
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  return (await response.json()) as T;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "user-agent": "map-color-war-h5-build-script"
    }
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.text();
}

function getScenarioEntry(scenario: AlternateHistoryScenario) {
  const entries = Object.values(scenario.entryDict ?? {}).filter((entry) => entry.mapData);
  const entry = entries.sort((left, right) => (left.order ?? 0) - (right.order ?? 0))[0];
  if (!entry) {
    throw new Error("Scenario has no entry with mapData");
  }
  return entry;
}

function parseExportedGeoJson(source: string, exportName: string): GeoJsonFeatureCollection {
  const prefix = `export var ${exportName} =`;
  const start = source.indexOf(prefix);
  if (start < 0) {
    throw new Error(`Could not find ${exportName} export`);
  }

  const jsonStart = source.indexOf("{", start + prefix.length);
  const jsonEnd = source.lastIndexOf("};");
  if (jsonStart < 0 || jsonEnd <= jsonStart) {
    throw new Error(`Could not isolate ${exportName} JSON`);
  }

  const parsed = JSON.parse(source.slice(jsonStart, jsonEnd + 1)) as Partial<GeoJsonFeatureCollection>;
  if (parsed.type !== "FeatureCollection" || !Array.isArray(parsed.features)) {
    throw new Error(`${exportName} is not a FeatureCollection`);
  }
  return parsed as GeoJsonFeatureCollection;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
