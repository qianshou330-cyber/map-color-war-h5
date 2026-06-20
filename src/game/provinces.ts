import type { Country, GameState, Point, Province, Soldier } from "../types";
import { distance, pointInPolygon, randomPointInPolygon } from "../utils/geometry";

export function getSpawnProvince(country: Country): Province {
  return (
    country.provinces.find((province) => province.id === country.spawnProvinceId) ??
    country.provinces[0]
  );
}

export function randomPointInProvince(province: Province): Point {
  return randomPointInPolygon(province.polygon);
}

export function findProvinceAtPoint(country: Country, point: Point): Province | undefined {
  return country.provinces.find((province) => pointInPolygon(point, province.polygon));
}

export function paintProvinceAtPoint(
  state: GameState,
  countryId: number,
  point: Point,
  paintCountryId: number
): Province | undefined {
  const country = state.countries[countryId - 1];
  if (!country || !pointInPolygon(point, country.polygon)) {
    return undefined;
  }

  const province = findProvinceAtPoint(country, point);
  if (!province) {
    return undefined;
  }

  province.paintCountryId = paintCountryId;
  return province;
}

export function isCountryFullyPaintedBy(country: Country, paintCountryId: number): boolean {
  return (
    country.provinces.length > 0 &&
    country.provinces.every((province) => province.paintCountryId === paintCountryId)
  );
}

export function getUnpaintedProvinces(country: Country, paintCountryId: number): Province[] {
  return country.provinces.filter((province) => province.paintCountryId !== paintCountryId);
}

export function getPaintedProvinceCount(country: Country, paintCountryId: number): number {
  return country.provinces.filter((province) => province.paintCountryId === paintCountryId).length;
}

export function getNearestUnpaintedProvince(
  country: Country,
  point: Point,
  paintCountryId: number
): Province | undefined {
  return getUnpaintedProvinces(country, paintCountryId).sort(
    (a, b) => distance(a.center, point) - distance(b.center, point)
  )[0];
}

export function paintWholeCountry(country: Country, paintCountryId: number): void {
  for (const province of country.provinces) {
    province.paintCountryId = paintCountryId;
  }
}

export function getProvinceColor(
  state: GameState,
  country: Country,
  province: Province
): number {
  return getCountryColorById(state, province.paintCountryId) ?? country.color;
}

export function getSoldierColor(state: GameState, soldier: Soldier): number {
  const country = state.countries[soldier.countryId - 1];
  if (!country) {
    return 0xffffff;
  }

  return getCountryColorById(state, country.controllerCountryId) ?? country.color;
}

export function getCountryColorById(state: GameState, countryId: number): number | undefined {
  const rebelFaction = state.rebelFactions.find((faction) => faction.id === countryId);
  if (rebelFaction) {
    return rebelFaction.color;
  }

  const country = state.countries[countryId - 1];
  return country?.color;
}
