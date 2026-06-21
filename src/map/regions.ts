import type { EditableMapData, MapLandPart, MapRegion, Point } from "../types";
import { createFantasyRegion } from "./fantasy";

type RegionTemplate = {
  id: "china";
  name: string;
  landParts: Array<{
    id: string;
    polygon: Point[];
    minSeeds?: number;
  }>;
};

const CHINA_TEMPLATE: RegionTemplate = {
  id: "china",
  name: "\u4e2d\u56fd",
  landParts: [
    {
      id: "china-mainland",
      minSeeds: 94,
      polygon: [
        { x: 0.018, y: 0.474 },
        { x: 0.026, y: 0.438 },
        { x: 0.022, y: 0.416 },
        { x: 0.044, y: 0.402 },
        { x: 0.052, y: 0.380 },
        { x: 0.038, y: 0.366 },
        { x: 0.064, y: 0.344 },
        { x: 0.082, y: 0.354 },
        { x: 0.096, y: 0.348 },
        { x: 0.120, y: 0.334 },
        { x: 0.150, y: 0.342 },
        { x: 0.166, y: 0.314 },
        { x: 0.178, y: 0.278 },
        { x: 0.196, y: 0.248 },
        { x: 0.188, y: 0.208 },
        { x: 0.216, y: 0.166 },
        { x: 0.234, y: 0.158 },
        { x: 0.246, y: 0.186 },
        { x: 0.260, y: 0.202 },
        { x: 0.276, y: 0.214 },
        { x: 0.314, y: 0.206 },
        { x: 0.332, y: 0.216 },
        { x: 0.346, y: 0.224 },
        { x: 0.382, y: 0.244 },
        { x: 0.414, y: 0.262 },
        { x: 0.452, y: 0.284 },
        { x: 0.486, y: 0.280 },
        { x: 0.520, y: 0.260 },
        { x: 0.560, y: 0.246 },
        { x: 0.582, y: 0.238 },
        { x: 0.604, y: 0.252 },
        { x: 0.634, y: 0.232 },
        { x: 0.650, y: 0.214 },
        { x: 0.660, y: 0.196 },
        { x: 0.686, y: 0.158 },
        { x: 0.704, y: 0.104 },
        { x: 0.734, y: 0.060 },
        { x: 0.772, y: 0.036 },
        { x: 0.812, y: 0.032 },
        { x: 0.846, y: 0.056 },
        { x: 0.872, y: 0.094 },
        { x: 0.900, y: 0.132 },
        { x: 0.942, y: 0.136 },
        { x: 0.974, y: 0.174 },
        { x: 0.986, y: 0.196 },
        { x: 0.964, y: 0.210 },
        { x: 0.936, y: 0.232 },
        { x: 0.902, y: 0.226 },
        { x: 0.884, y: 0.238 },
        { x: 0.870, y: 0.218 },
        { x: 0.842, y: 0.252 },
        { x: 0.856, y: 0.292 },
        { x: 0.846, y: 0.314 },
        { x: 0.832, y: 0.326 },
        { x: 0.790, y: 0.340 },
        { x: 0.780, y: 0.362 },
        { x: 0.760, y: 0.382 },
        { x: 0.724, y: 0.398 },
        { x: 0.764, y: 0.408 },
        { x: 0.804, y: 0.424 },
        { x: 0.832, y: 0.444 },
        { x: 0.810, y: 0.466 },
        { x: 0.770, y: 0.466 },
        { x: 0.806, y: 0.488 },
        { x: 0.840, y: 0.484 },
        { x: 0.864, y: 0.506 },
        { x: 0.882, y: 0.520 },
        { x: 0.872, y: 0.540 },
        { x: 0.858, y: 0.558 },
        { x: 0.824, y: 0.578 },
        { x: 0.816, y: 0.596 },
        { x: 0.806, y: 0.612 },
        { x: 0.792, y: 0.626 },
        { x: 0.774, y: 0.632 },
        { x: 0.744, y: 0.674 },
        { x: 0.724, y: 0.684 },
        { x: 0.704, y: 0.692 },
        { x: 0.674, y: 0.730 },
        { x: 0.656, y: 0.736 },
        { x: 0.640, y: 0.746 },
        { x: 0.610, y: 0.790 },
        { x: 0.592, y: 0.806 },
        { x: 0.574, y: 0.824 },
        { x: 0.528, y: 0.854 },
        { x: 0.510, y: 0.880 },
        { x: 0.492, y: 0.900 },
        { x: 0.458, y: 0.876 },
        { x: 0.438, y: 0.834 },
        { x: 0.398, y: 0.828 },
        { x: 0.376, y: 0.818 },
        { x: 0.360, y: 0.806 },
        { x: 0.330, y: 0.824 },
        { x: 0.312, y: 0.810 },
        { x: 0.294, y: 0.788 },
        { x: 0.260, y: 0.754 },
        { x: 0.224, y: 0.768 },
        { x: 0.206, y: 0.758 },
        { x: 0.190, y: 0.744 },
        { x: 0.158, y: 0.706 },
        { x: 0.144, y: 0.688 },
        { x: 0.130, y: 0.672 },
        { x: 0.108, y: 0.626 },
        { x: 0.090, y: 0.616 },
        { x: 0.074, y: 0.604 },
        { x: 0.048, y: 0.584 },
        { x: 0.032, y: 0.540 }
      ]
    },
    {
      id: "taiwan",
      minSeeds: 4,
      polygon: [
        { x: 0.892, y: 0.640 },
        { x: 0.914, y: 0.616 },
        { x: 0.938, y: 0.650 },
        { x: 0.936, y: 0.704 },
        { x: 0.912, y: 0.764 },
        { x: 0.878, y: 0.788 },
        { x: 0.858, y: 0.744 },
        { x: 0.866, y: 0.690 }
      ]
    },
    {
      id: "hainan",
      minSeeds: 2,
      polygon: [
        { x: 0.548, y: 0.920 },
        { x: 0.594, y: 0.910 },
        { x: 0.632, y: 0.934 },
        { x: 0.626, y: 0.968 },
        { x: 0.586, y: 0.990 },
        { x: 0.538, y: 0.976 },
        { x: 0.512, y: 0.946 }
      ]
    }
  ]
};

export function createRandomRegion(width: number, height: number): MapRegion {
  return scaleRegion(CHINA_TEMPLATE, width, height);
}

export function createRegionFromEditableMap(
  width: number,
  height: number,
  data: EditableMapData
): MapRegion {
  if (data.generationConfig) {
    return createFantasyRegion(
      width,
      height,
      data.generationConfig,
      data.landParts.map((part) => part.polygon)
    );
  }

  const landParts: MapLandPart[] = data.landParts.map((part, index) => ({
    id: part.id || `custom-${index + 1}`,
    minSeeds: 1,
    polygon: part.polygon.map((point) => ({
      x: clamp01(point.x) * width,
      y: clamp01(point.y) * height
    }))
  }));

  return {
    id: "custom",
    name: data.name || "\u81ea\u5b9a\u4e49\u5730\u56fe",
    landParts,
    outlinePolygons: landParts.map((part) => part.polygon)
  };
}

function scaleRegion(template: RegionTemplate, width: number, height: number): MapRegion {
  const scaleX = width * 0.96;
  const scaleY = height * 0.72;
  const offsetX = width * 0.02;
  const offsetY = height * 0.13;
  const landParts: MapLandPart[] = template.landParts.map((part) => ({
    id: part.id,
    minSeeds: part.minSeeds,
    polygon: scalePolygon(part.polygon, scaleX, scaleY, offsetX, offsetY)
  }));

  return {
    id: template.id,
    name: template.name,
    landParts,
    outlinePolygons: landParts.map((part) => part.polygon)
  };
}

function scalePolygon(
  polygon: Point[],
  scaleX: number,
  scaleY: number,
  offsetX: number,
  offsetY: number
): Point[] {
  return polygon.map((point) => ({
    x: offsetX + point.x * scaleX,
    y: offsetY + point.y * scaleY
  }));
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}
