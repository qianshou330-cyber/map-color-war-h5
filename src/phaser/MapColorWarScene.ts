import Phaser from "phaser";
import {
  MAP_BACKGROUND_COLOR,
  MOBILE_MAP_HEIGHT,
  MOBILE_MAP_WIDTH,
  NEUTRAL_STROKE_COLOR,
  PLAYER_STROKE_COLOR,
  SOLDIER_RADIUS,
  SOLDIER_RENDER_SMOOTHING
} from "../constants";
import type { AttackTask, Biome, Country, GameState, Point, Size, Soldier } from "../types";
import { getAttackRoute } from "../game/attackRules";
import { tickGame } from "../game/tick";
import { getCountryColorById, getProvinceColor, getSoldierColor } from "../game/provinces";
import { getDisplayNickname } from "../game/playerProfile";
import { distance, distanceToSegment, pointInPolygon, polygonArea } from "../utils/geometry";

type RouteCurve = {
  start: Point;
  control: Point;
  end: Point;
};

type RouteHitArea = {
  attackId: string;
  sourceCountryId: number;
  targetCountryId: number;
  curve: RouteCurve;
  message: string;
};

type RouteVisualState = {
  color: number;
  alpha: number;
  width: number;
  phase: AttackTask["phase"];
  kind: AttackTask["kind"];
  isFocused: boolean;
  isSea: boolean;
};

type LabelGroup = {
  controllerCountryId: number;
  countries: Country[];
  isPlayerGroup: boolean;
  nickname: string | null;
  labelPoint: Point;
  labelArea: number;
  fontSize: number;
};

const SOLDIER_DISPLAY_SNAP_DISTANCE = 48;

export class MapColorWarScene extends Phaser.Scene {
  private state: GameState;
  private terrainGraphics!: Phaser.GameObjects.Graphics;
  private countryGraphics!: Phaser.GameObjects.Graphics;
  private routeGraphics!: Phaser.GameObjects.Graphics;
  private soldierGraphics!: Phaser.GameObjects.Graphics;
  private combatGraphics!: Phaser.GameObjects.Graphics;
  private routeLabelLayer!: Phaser.GameObjects.Container;
  private labelLayer!: Phaser.GameObjects.Container;
  private labels = new Map<number, Phaser.GameObjects.Text>();
  private routeHitAreas: RouteHitArea[] = [];
  private soldierDisplayPoints = new Map<string, Point>();
  private soldierDisplaySignature = "";
  private focusedAttackId: string | null = null;
  private focusedCountryId: number | null = null;
  private onStateChanged: () => void;
  private onCountrySelected?: (countryId: number, routeMessage?: string) => void;
  private onRouteSelected?: (message: string) => void;
  private readonly authoritativeRemote: boolean;
  private readonly commandOnlyMode: boolean;
  private elapsedSinceHud = 0;
  private lastLabelRound = 0;
  private lastLabelSignature = "";
  private lastTerrainSignature = "";

  constructor(
    state: GameState,
    onStateChanged: () => void,
    onCountrySelected?: (countryId: number, routeMessage?: string) => void,
    onRouteSelected?: (message: string) => void,
    authoritativeRemote = false,
    commandOnlyMode = false
  ) {
    super("MapColorWarScene");
    this.state = state;
    this.onStateChanged = onStateChanged;
    this.onCountrySelected = onCountrySelected;
    this.onRouteSelected = onRouteSelected;
    this.authoritativeRemote = authoritativeRemote;
    this.commandOnlyMode = commandOnlyMode;
  }

  create(): void {
    this.cameras.main.setBackgroundColor(MAP_BACKGROUND_COLOR);
    this.terrainGraphics = this.add.graphics();
    this.countryGraphics = this.add.graphics();
    this.routeGraphics = this.add.graphics();
    this.soldierGraphics = this.add.graphics();
    this.combatGraphics = this.add.graphics();
    this.routeLabelLayer = this.add.container(0, 0);
    this.labelLayer = this.add.container(0, 0);
    this.terrainGraphics.setDepth(0);
    this.countryGraphics.setDepth(1);
    this.routeGraphics.setDepth(3);
    this.soldierGraphics.setDepth(4);
    this.combatGraphics.setDepth(5);
    this.routeLabelLayer.setDepth(6);
    this.labelLayer.setDepth(8);
    this.scale.on("resize", this.handleResize, this);
    this.input.on("pointerdown", this.handlePointerDown, this);
    this.handleResize();
    this.drawTerrain();
    this.drawCountries();
    this.drawLabels();
    this.drawAttackRoutes(0);
    this.drawSoldiers(16);
    this.drawCombatMarkers(0);
  }

  update(time: number, delta: number): void {
    if (!this.authoritativeRemote) {
      tickGame(this.state, delta, performance.now(), this.getCurrentMapSize());
    }

    const labelSignature = this.getLabelSignature();
    const terrainSignature = this.getTerrainSignature();
    if (this.lastTerrainSignature !== terrainSignature) {
      this.drawTerrain();
    }
    const labelGroupCount = this.getVisibleLabelGroups().length;
    if (
      this.lastLabelRound !== this.state.round ||
      this.labels.size !== labelGroupCount ||
      this.lastLabelSignature !== labelSignature
    ) {
      this.handleResize();
      this.drawLabels();
    }

    this.drawCountries();
    this.drawAttackRoutes(time);
    this.drawSoldiers(delta);
    this.drawCombatMarkers(time);

    this.elapsedSinceHud += delta;
    if (this.elapsedSinceHud > 120) {
      this.elapsedSinceHud = 0;
      this.onStateChanged();
    }
  }

  private drawCountries(): void {
    this.countryGraphics.clear();
    this.drawRegionBase();

    for (const country of this.state.countries) {
      this.drawCountry(country);
    }

    this.drawFactionOuterBorders();
    this.drawRivers();
    this.drawRegionOutline();
  }

  private drawTerrain(): void {
    this.terrainGraphics.clear();
    const terrain = this.state.region.terrain;
    if (!terrain) {
      this.lastTerrainSignature = this.getTerrainSignature();
      return;
    }

    const cellWidth = this.state.mapSize.width / terrain.width;
    const cellHeight = this.state.mapSize.height / terrain.height;
    for (let row = 0; row < terrain.height; row += 1) {
      for (let column = 0; column < terrain.width; column += 1) {
        const index = row * terrain.width + column;
        const biome = terrain.biomes[index] ?? "ocean";
        this.terrainGraphics.fillStyle(this.getBiomeColor(biome), biome === "ocean" ? 0.82 : 0.88);
        this.terrainGraphics.fillRect(
          column * cellWidth,
          row * cellHeight,
          Math.ceil(cellWidth) + 0.5,
          Math.ceil(cellHeight) + 0.5
        );
      }
    }

    this.drawTerrainOverlays();
    this.lastTerrainSignature = this.getTerrainSignature();
  }

  private drawTerrainOverlays(): void {
    const terrain = this.state.region.terrain;
    if (!terrain) {
      return;
    }

    for (const contour of terrain.contours ?? []) {
      if (contour.length < 2) {
        continue;
      }
      this.terrainGraphics.lineStyle(0.65, 0xf3ead0, this.getMapViewMode() === "terrain" ? 0.16 : 0.08);
      this.strokePolyline(this.terrainGraphics, contour);
    }

    for (const ridge of terrain.mountainRidges ?? []) {
      if (ridge.length < 2) {
        continue;
      }
      this.terrainGraphics.lineStyle(2.4, 0x2a2b2f, this.getMapViewMode() === "terrain" ? 0.32 : 0.18);
      this.strokePolyline(this.terrainGraphics, ridge);
      this.terrainGraphics.lineStyle(0.95, 0xd7d1bf, this.getMapViewMode() === "terrain" ? 0.44 : 0.22);
      this.strokePolyline(this.terrainGraphics, ridge);
    }

    for (const coastline of terrain.coastline ?? []) {
      if (coastline.length < 3) {
        continue;
      }
      this.terrainGraphics.lineStyle(2.6, 0x072031, 0.34);
      this.terrainGraphics.strokePoints(coastline, true);
      this.terrainGraphics.lineStyle(1.1, 0x82dff2, this.getMapViewMode() === "terrain" ? 0.52 : 0.32);
      this.terrainGraphics.strokePoints(coastline, true);
    }
  }

  private strokePolyline(graphics: Phaser.GameObjects.Graphics, points: Point[]): void {
    graphics.beginPath();
    points.forEach((point, index) => {
      if (index === 0) {
        graphics.moveTo(point.x, point.y);
      } else {
        graphics.lineTo(point.x, point.y);
      }
    });
    graphics.strokePath();
  }

  private drawRegionBase(): void {
    if (this.state.region.terrain) {
      return;
    }

    this.countryGraphics.fillStyle(0x14253a, 0.42);
    for (const outline of this.state.region.outlinePolygons) {
      const regionPath = new Phaser.Geom.Polygon(outline);
      this.countryGraphics.fillPoints(regionPath.points, true);
    }
  }

  private drawRivers(): void {
    const rivers = this.state.region.rivers ?? [];
    for (const river of rivers) {
      if (river.points.length < 2) {
        continue;
      }

      this.countryGraphics.lineStyle(2.2, 0x06101f, 0.12);
      this.countryGraphics.beginPath();
      river.points.forEach((point, index) => {
        if (index === 0) {
          this.countryGraphics.moveTo(point.x, point.y);
        } else {
          this.countryGraphics.lineTo(point.x, point.y);
        }
      });
      this.countryGraphics.strokePath();

      this.countryGraphics.lineStyle(1, 0x54d4ff, this.getMapViewMode() === "terrain" ? 0.32 : 0.22);
      this.countryGraphics.beginPath();
      river.points.forEach((point, index) => {
        if (index === 0) {
          this.countryGraphics.moveTo(point.x, point.y);
        } else {
          this.countryGraphics.lineTo(point.x, point.y);
        }
      });
      this.countryGraphics.strokePath();
    }
  }

  private drawRegionOutline(): void {
    this.countryGraphics.lineStyle(6, 0x06101f, 0.9);
    for (const outline of this.state.region.outlinePolygons) {
      const regionPath = new Phaser.Geom.Polygon(outline);
      this.countryGraphics.strokePoints(regionPath.points, true);
    }

    this.countryGraphics.lineStyle(2.6, 0xd8f3ff, 0.96);
    for (const outline of this.state.region.outlinePolygons) {
      const regionPath = new Phaser.Geom.Polygon(outline);
      this.countryGraphics.strokePoints(regionPath.points, true);
    }
  }

  private drawCountry(country: Country): void {
    const controllerColor = getCountryColorById(this.state, country.controllerCountryId) ?? country.color;

    this.countryGraphics.fillStyle(controllerColor, this.getCountryFillAlpha());
    for (const polygon of this.getCountryTerritoryPolygons(country)) {
      const countryPath = new Phaser.Geom.Polygon(polygon);
      this.countryGraphics.fillPoints(countryPath.points, true);
    }

    for (const province of country.provinces) {
      const provincePath = new Phaser.Geom.Polygon(province.polygon);
      const isContestedProvince = province.paintCountryId !== country.controllerCountryId;
      if (isContestedProvince) {
        this.countryGraphics.fillStyle(
          getProvinceColor(this.state, country, province),
          this.getContestedProvinceFillAlpha()
        );
        this.countryGraphics.fillPoints(provincePath.points, true);
      }
      this.countryGraphics.lineStyle(
        0.45,
        0xffffff,
        isContestedProvince ? 0.16 : this.getProvinceLineAlpha()
      );
      this.countryGraphics.strokePoints(provincePath.points, true);
    }
  }

  private drawFactionOuterBorders(): void {
    this.drawFactionBorderPass(4.8, 0x06101f, 0.9);

    for (const country of this.state.countries) {
      const isPlayerControlled = this.isPlayerControlledGroup(country.controllerCountryId, [country]);
      const strokeColor = isPlayerControlled ? PLAYER_STROKE_COLOR : NEUTRAL_STROKE_COLOR;
      this.countryGraphics.lineStyle(isPlayerControlled ? 2.35 : 1.65, strokeColor, isPlayerControlled ? 0.95 : 0.72);
      this.strokeFactionBorderEdges(country);
    }
  }

  private drawFactionBorderPass(width: number, color: number, alpha: number): void {
    this.countryGraphics.lineStyle(width, color, alpha);
    for (const country of this.state.countries) {
      this.strokeFactionBorderEdges(country);
    }
  }

  private strokeFactionBorderEdges(country: Country): void {
    for (const polygon of this.getCountryTerritoryPolygons(country)) {
      for (let index = 0; index < polygon.length; index += 1) {
        const start = polygon[index];
        const end = polygon[(index + 1) % polygon.length];
        if (this.isInternalControllerBorder(country, start, end)) {
          continue;
        }

        this.countryGraphics.beginPath();
        this.countryGraphics.moveTo(start.x, start.y);
        this.countryGraphics.lineTo(end.x, end.y);
        this.countryGraphics.strokePath();
      }
    }
  }

  private isInternalControllerBorder(country: Country, start: Point, end: Point): boolean {
    const midpoint = {
      x: (start.x + end.x) / 2,
      y: (start.y + end.y) / 2
    };

    return country.neighbors.some((neighborId) => {
      const neighbor = this.state.countries[neighborId - 1];
      return (
        Boolean(neighbor) &&
        neighbor.controllerCountryId === country.controllerCountryId &&
        this.isPointNearPolygonBoundary(midpoint, neighbor.polygon, 3.5)
      );
    });
  }

  private isPointNearPolygonBoundary(point: Point, polygon: Point[], tolerance: number): boolean {
    for (let index = 0; index < polygon.length; index += 1) {
      const start = polygon[index];
      const end = polygon[(index + 1) % polygon.length];
      if (distanceToSegment(point, start, end) <= tolerance) {
        return true;
      }
    }

    return false;
  }

  private drawLabels(): void {
    this.labelLayer.removeAll(true);
    this.labels.clear();

    for (const group of this.getVisibleLabelGroups()) {
      const labelText = group.isPlayerGroup
        ? `${group.controllerCountryId}\n${group.nickname ?? getDisplayNickname(this.state.playerProfile)}`
        : String(group.controllerCountryId);
      const label = this.add
        .text(group.labelPoint.x, group.labelPoint.y, labelText, {
          fontFamily: "Arial, sans-serif",
          fontSize: `${group.fontSize}px`,
          color: "#06101f",
          fontStyle: "900",
          align: "center",
          lineSpacing: -3
        })
        .setOrigin(0.5);
      label.setStroke("#ffffff", this.getLabelStrokeWidth(group.fontSize));
      label.setDepth(8);
      this.labelLayer.add(label);
      this.labels.set(group.controllerCountryId, label);
    }

    this.lastLabelRound = this.state.round;
    this.lastLabelSignature = this.getLabelSignature();
  }

  private drawSoldiers(delta = 16): void {
    this.soldierGraphics.clear();
    this.resetSoldierDisplayCacheIfNeeded();
    const visibleSoldierIds = new Set<string>();

    for (const soldier of this.state.soldiers) {
      if (!soldier.alive) {
        continue;
      }
      visibleSoldierIds.add(soldier.id);
      this.drawSoldier(soldier, this.getSoldierRenderPoint(soldier, delta));
    }

    for (const soldierId of this.soldierDisplayPoints.keys()) {
      if (!visibleSoldierIds.has(soldierId)) {
        this.soldierDisplayPoints.delete(soldierId);
      }
    }
  }

  private drawAttackRoutes(time: number): void {
    this.routeGraphics.clear();
    this.routeLabelLayer.removeAll(true);
    this.routeHitAreas = [];

    if (
      this.focusedAttackId &&
      !this.state.activeAttacks.some((attack) => attack.id === this.focusedAttackId)
    ) {
      this.focusedAttackId = null;
    }

    if (this.state.activeAttacks.length === 0) {
      this.focusedCountryId = null;
      return;
    }

    const routeCountByPair = new Map<string, number>();
    this.state.activeAttacks.forEach((attack, attackIndex) => {
      const targetCountry = this.state.countries[attack.targetCountryId - 1];
      if (!targetCountry) {
        return;
      }

      attack.participantCountryIds.forEach((participantCountryId, participantIndex) => {
        const sourceCountry = this.state.countries[participantCountryId - 1];
        if (!sourceCountry) {
          return;
        }

        const pairKey = `${sourceCountry.id}-${targetCountry.id}-${attack.kind}`;
        const pairIndex = routeCountByPair.get(pairKey) ?? 0;
        routeCountByPair.set(pairKey, pairIndex + 1);
        const routeIndex = attackIndex + participantIndex + pairIndex;
        const curve = this.createRouteCurve(
          sourceCountry.center,
          targetCountry.center,
          this.getRouteSideOffset(routeIndex, pairIndex)
        );
        const visualState = this.getRouteVisualState(attack, sourceCountry, targetCountry);
        if (participantIndex === 0) {
          this.drawTargetPressure(targetCountry, visualState, time, attackIndex);
        }
        this.routeHitAreas.push({
          attackId: attack.id,
          sourceCountryId: sourceCountry.id,
          targetCountryId: targetCountry.id,
          curve,
          message: ""
        });

        this.drawRouteLine(curve, {
          ...visualState,
          dashOffset: (time / 48 + attackIndex * 7 + participantIndex * 4) % 28
        });
        this.drawRouteParticles(curve, visualState, time, routeIndex);
      });
    });
  }

  private drawCombatMarkers(time: number): void {
    this.combatGraphics.clear();

    for (const attack of this.state.activeAttacks) {
      if (attack.phase !== "fighting") {
        continue;
      }

      const markerPoint = this.getCombatMarkerPoint(attack);
      if (!markerPoint) {
        continue;
      }

      const pulse = (Math.sin(time / 260 + attack.id.length) + 1) / 2;
      this.drawCrossedBlades(markerPoint, 5.6 + pulse * 0.8, 0.72 + pulse * 0.22);
    }
  }

  private getCombatMarkerPoint(attack: AttackTask): Point | null {
    const attackers = attack.attackerSoldierIds
      .map((soldierId) => this.state.soldiers.find((soldier) => soldier.id === soldierId))
      .filter((soldier): soldier is Soldier => Boolean(soldier?.alive));
    const targetCountry = this.state.countries[attack.targetCountryId - 1];
    if (!targetCountry) {
      return null;
    }

    const defenders = this.state.soldiers.filter(
      (soldier) =>
        soldier.alive &&
        soldier.countryId === targetCountry.id &&
        soldier.status === "fighting"
    );

    if (attackers.length === 0 || defenders.length === 0) {
      return null;
    }

    const frontLineSoldiers = [...attackers, ...defenders];
    const total = frontLineSoldiers.reduce(
      (sum, soldier) => {
        const point = this.getCachedSoldierPoint(soldier);
        sum.x += point.x;
        sum.y += point.y;
        return sum;
      },
      { x: 0, y: 0 }
    );

    const average = {
      x: total.x / frontLineSoldiers.length,
      y: total.y / frontLineSoldiers.length
    };

    return pointInPolygon(average, targetCountry.polygon) ? average : targetCountry.center;
  }

  private getCachedSoldierPoint(soldier: Soldier): Point {
    return this.soldierDisplayPoints.get(soldier.id) ?? { x: soldier.x, y: soldier.y };
  }

  private drawCrossedBlades(center: Point, size: number, alpha: number): void {
    const leftToRightStart = { x: center.x - size, y: center.y - size };
    const leftToRightEnd = { x: center.x + size, y: center.y + size };
    const rightToLeftStart = { x: center.x + size, y: center.y - size };
    const rightToLeftEnd = { x: center.x - size, y: center.y + size };

    this.combatGraphics.lineStyle(4.2, 0x06101f, alpha * 0.88);
    this.strokeBlade(leftToRightStart, leftToRightEnd);
    this.strokeBlade(rightToLeftStart, rightToLeftEnd);

    this.combatGraphics.lineStyle(2, 0xf7fbff, alpha);
    this.strokeBlade(leftToRightStart, leftToRightEnd);
    this.strokeBlade(rightToLeftStart, rightToLeftEnd);

    this.combatGraphics.lineStyle(1, 0x93a7b8, alpha * 0.9);
    this.strokeBlade(
      { x: leftToRightStart.x + size * 0.22, y: leftToRightStart.y + size * 0.22 },
      { x: leftToRightEnd.x - size * 0.26, y: leftToRightEnd.y - size * 0.26 }
    );
    this.strokeBlade(
      { x: rightToLeftStart.x - size * 0.22, y: rightToLeftStart.y + size * 0.22 },
      { x: rightToLeftEnd.x + size * 0.26, y: rightToLeftEnd.y - size * 0.26 }
    );

    this.combatGraphics.fillStyle(0xf6c95a, alpha);
    this.combatGraphics.fillRect(center.x - 1.2, center.y - 1.2, 2.4, 2.4);
  }

  private strokeBlade(start: Point, end: Point): void {
    this.combatGraphics.beginPath();
    this.combatGraphics.moveTo(start.x, start.y);
    this.combatGraphics.lineTo(end.x, end.y);
    this.combatGraphics.strokePath();
  }

  private createRouteCurve(from: Point, to: Point, sideOffset: number): RouteCurve {
    const length = distance(from, to);
    if (length < 4) {
      return { start: from, control: from, end: to };
    }

    const dx = (to.x - from.x) / length;
    const dy = (to.y - from.y) / length;
    const perpendicularX = -dy;
    const perpendicularY = dx;
    const startPadding = Math.min(18, length * 0.15);
    const endPadding = Math.min(30, length * 0.22);
    const start = {
      x: from.x + dx * startPadding + perpendicularX * sideOffset,
      y: from.y + dy * startPadding + perpendicularY * sideOffset
    };
    const end = {
      x: to.x - dx * endPadding + perpendicularX * sideOffset,
      y: to.y - dy * endPadding + perpendicularY * sideOffset
    };
    const bend = Phaser.Math.Clamp(length * 0.16, 18, 78);
    const bendDirection = sideOffset >= 0 ? 1 : -1;
    const control = {
      x: (start.x + end.x) / 2 + perpendicularX * (sideOffset + bend * bendDirection),
      y: (start.y + end.y) / 2 + perpendicularY * (sideOffset + bend * bendDirection)
    };

    return { start, control, end };
  }

  private getRouteSideOffset(routeIndex: number, pairIndex: number): number {
    const direction = routeIndex % 2 === 0 ? 1 : -1;
    return direction * (10 + pairIndex * 8 + (routeIndex % 4) * 2);
  }

  private getRouteVisualState(
    attack: AttackTask,
    sourceCountry: Country,
    targetCountry: Country
  ): RouteVisualState {
    const hasFocus = this.focusedAttackId !== null || this.focusedCountryId !== null;
    const isFocused =
      !hasFocus ||
      this.focusedAttackId === attack.id ||
      this.focusedCountryId === sourceCountry.id ||
      this.focusedCountryId === targetCountry.id;
    const isSea = getAttackRoute(this.state, sourceCountry, targetCountry) === "sea";
    const baseColor =
      attack.kind === "counter"
        ? 0xff6a3d
          : isSea
            ? 0x35c9ff
            : (getCountryColorById(this.state, sourceCountry.controllerCountryId) ?? sourceCountry.color);
    const phaseAlpha =
      attack.phase === "fighting" ? 0.9 : attack.phase === "painting" ? 0.48 : 0.7;
    const phaseWidth = attack.phase === "painting" ? 1.55 : attack.phase === "fighting" ? 3.15 : 2.4;
    const focusMultiplier = isFocused ? 1 : 0.24;

    return {
      color: baseColor,
      alpha: phaseAlpha * focusMultiplier,
      width: isFocused ? phaseWidth : Math.max(1, phaseWidth - 0.8),
      phase: attack.phase,
      kind: attack.kind,
      isFocused,
      isSea
    };
  }

  private drawTargetPressure(
    country: Country,
    visualState: RouteVisualState,
    time: number,
    attackIndex: number
  ): void {
    if (visualState.alpha < 0.18) {
      return;
    }

    const pulse = (Math.sin(time / 360 + attackIndex * 0.9) + 1) / 2;
    const baseAlpha =
      visualState.phase === "fighting" ? 0.34 : visualState.phase === "painting" ? 0.2 : 0.26;
    const width =
      visualState.phase === "fighting" ? 2.8 + pulse * 1.1 : 1.6 + pulse * 0.7;
    const alpha = Math.min(0.5, baseAlpha * visualState.alpha + pulse * 0.08);

    this.routeGraphics.lineStyle(width + 1.4, 0x06101f, alpha * 0.45);
    this.routeGraphics.strokePoints(country.polygon, true);
    this.routeGraphics.lineStyle(width, visualState.color, alpha);
    this.routeGraphics.strokePoints(country.polygon, true);
  }

  private drawRouteLine(
    curve: RouteCurve,
    options: {
      color: number;
      alpha: number;
      width: number;
      dashOffset: number;
      isSea: boolean;
    }
  ): void {
    this.routeGraphics.lineStyle(options.width + 2.2, 0x06101f, options.alpha * 0.34);
    this.strokeDashedCurve(curve, options.dashOffset, options.isSea ? 13 : 18, options.isSea ? 12 : 10);

    const highlightColor = options.isSea ? 0xcdf7ff : 0xffffff;
    this.routeGraphics.lineStyle(Math.max(1, options.width - 1.1), highlightColor, options.alpha * 0.55);
    this.strokeDashedCurve(curve, options.dashOffset + 8, 9, 19);

    this.routeGraphics.lineStyle(options.width, options.color, options.alpha);
    this.strokeDashedCurve(curve, options.dashOffset, options.isSea ? 13 : 18, options.isSea ? 12 : 10);
    this.drawArrowHead(curve, options.color, Math.min(0.95, options.alpha + 0.12));
  }

  private strokeDashedCurve(
    curve: RouteCurve,
    offset: number,
    dashLength: number,
    gapLength: number
  ): void {
    const patternLength = dashLength + gapLength;
    let traveled = 0;
    let previous = this.getCurvePoint(curve, 0);

    for (let step = 1; step <= 72; step += 1) {
      const point = this.getCurvePoint(curve, step / 72);
      const segmentLength = distance(previous, point);
      const patternPosition = (((traveled + offset) % patternLength) + patternLength) % patternLength;
      if (patternPosition < dashLength) {
        this.routeGraphics.beginPath();
        this.routeGraphics.moveTo(previous.x, previous.y);
        this.routeGraphics.lineTo(point.x, point.y);
        this.routeGraphics.strokePath();
      }
      traveled += segmentLength;
      previous = point;
    }
  }

  private drawArrowHead(
    curve: RouteCurve,
    color: number,
    alpha: number
  ): void {
    const to = this.getCurvePoint(curve, 0.965);
    const tangent = this.getCurveTangent(curve, 0.965);
    if (distance(curve.start, curve.end) < 8) {
      return;
    }

    const angle = Math.atan2(tangent.y, tangent.x);
    const arrowLength = 11;
    const spread = 0.58;
    const left = {
      x: to.x - Math.cos(angle - spread) * arrowLength,
      y: to.y - Math.sin(angle - spread) * arrowLength
    };
    const right = {
      x: to.x - Math.cos(angle + spread) * arrowLength,
      y: to.y - Math.sin(angle + spread) * arrowLength
    };

    this.routeGraphics.lineStyle(4.8, 0x06101f, alpha * 0.34);
    this.routeGraphics.beginPath();
    this.routeGraphics.moveTo(left.x, left.y);
    this.routeGraphics.lineTo(to.x, to.y);
    this.routeGraphics.lineTo(right.x, right.y);
    this.routeGraphics.strokePath();

    this.routeGraphics.lineStyle(2.4, color, alpha);
    this.routeGraphics.beginPath();
    this.routeGraphics.moveTo(left.x, left.y);
    this.routeGraphics.lineTo(to.x, to.y);
    this.routeGraphics.lineTo(right.x, right.y);
    this.routeGraphics.strokePath();
  }

  private drawRouteParticles(
    curve: RouteCurve,
    visualState: RouteVisualState,
    time: number,
    routeIndex: number
  ): void {
    if (visualState.alpha < 0.25) {
      return;
    }

    const isMobile = this.scale.width < 760;
    const particleCount = isMobile ? 1 : visualState.isFocused ? 3 : 2;
    const speed =
      visualState.phase === "fighting" ? 1450 : visualState.phase === "painting" ? 2100 : 1050;
    this.routeGraphics.fillStyle(visualState.color, Math.min(0.92, visualState.alpha + 0.16));

    for (let index = 0; index < particleCount; index += 1) {
      const t = ((time + routeIndex * 173) / speed + index / particleCount) % 1;
      const point = this.getCurvePoint(curve, t);
      const tangent = this.getCurveTangent(curve, t);
      const angle = Math.atan2(tangent.y, tangent.x);
      const size = visualState.isFocused ? 5.2 : 4;
      const nose = {
        x: point.x + Math.cos(angle) * size,
        y: point.y + Math.sin(angle) * size
      };
      const left = {
        x: point.x + Math.cos(angle + 2.45) * size * 0.7,
        y: point.y + Math.sin(angle + 2.45) * size * 0.7
      };
      const right = {
        x: point.x + Math.cos(angle - 2.45) * size * 0.7,
        y: point.y + Math.sin(angle - 2.45) * size * 0.7
      };
      this.routeGraphics.fillTriangle(nose.x, nose.y, left.x, left.y, right.x, right.y);
    }
  }

  private getCurvePoint(curve: RouteCurve, t: number): Point {
    const oneMinusT = 1 - t;
    return {
      x:
        oneMinusT * oneMinusT * curve.start.x +
        2 * oneMinusT * t * curve.control.x +
        t * t * curve.end.x,
      y:
        oneMinusT * oneMinusT * curve.start.y +
        2 * oneMinusT * t * curve.control.y +
        t * t * curve.end.y
    };
  }

  private getCurveTangent(curve: RouteCurve, t: number): Point {
    return {
      x: 2 * (1 - t) * (curve.control.x - curve.start.x) + 2 * t * (curve.end.x - curve.control.x),
      y: 2 * (1 - t) * (curve.control.y - curve.start.y) + 2 * t * (curve.end.y - curve.control.y)
    };
  }

  private getSoldierRenderPoint(soldier: Soldier, delta: number): Point {
    const targetPoint = { x: soldier.x, y: soldier.y };
    if (!this.authoritativeRemote) {
      this.soldierDisplayPoints.set(soldier.id, targetPoint);
      return targetPoint;
    }

    const currentPoint = this.soldierDisplayPoints.get(soldier.id);
    if (!currentPoint || distance(currentPoint, targetPoint) > SOLDIER_DISPLAY_SNAP_DISTANCE) {
      this.soldierDisplayPoints.set(soldier.id, targetPoint);
      return targetPoint;
    }

    const clampedDelta = Math.min(Math.max(delta, 0), 100);
    const alpha = 1 - Math.exp(-SOLDIER_RENDER_SMOOTHING * (clampedDelta / 1000));
    const nextPoint = {
      x: currentPoint.x + (targetPoint.x - currentPoint.x) * alpha,
      y: currentPoint.y + (targetPoint.y - currentPoint.y) * alpha
    };

    if (distance(nextPoint, targetPoint) < 0.05) {
      this.soldierDisplayPoints.set(soldier.id, targetPoint);
      return targetPoint;
    }

    this.soldierDisplayPoints.set(soldier.id, nextPoint);
    return nextPoint;
  }

  private resetSoldierDisplayCacheIfNeeded(): void {
    const signature = [
      this.state.round,
      this.state.startedAt,
      this.state.region.id,
      this.state.region.generationConfig?.seed ?? "",
      `${this.state.mapSize.width}x${this.state.mapSize.height}`
    ].join(":");

    if (this.soldierDisplaySignature === signature) {
      return;
    }

    this.soldierDisplaySignature = signature;
    this.soldierDisplayPoints.clear();
  }

  private drawSoldier(soldier: Soldier, renderPoint: Point): void {
    const color = getSoldierColor(this.state, soldier);
    const active = soldier.status === "attacking" || soldier.status === "fighting";
    const isMinotaur = soldier.rank === "minotaur";
    const size = SOLDIER_RADIUS * 2 + (isMinotaur ? 1 : 0);
    const x = renderPoint.x - size / 2;
    const y = renderPoint.y - size / 2;

    if (active) {
      this.soldierGraphics.lineStyle(1.05, 0xffffff, 0.92);
      this.soldierGraphics.strokeRect(x - 1.15, y - 1.15, size + 2.3, size + 2.3);
    }

    this.soldierGraphics.fillStyle(color, soldier.status === "wandering" ? 0.88 : 0.98);
    this.soldierGraphics.fillRect(x, y, size, size);
    if (isMinotaur) {
      this.soldierGraphics.lineStyle(1, 0xf9c74f, 0.98);
      this.soldierGraphics.strokeRect(x - 0.75, y - 0.75, size + 1.5, size + 1.5);
      this.soldierGraphics.fillStyle(0xf9c74f, 0.96);
      this.soldierGraphics.fillTriangle(
        x - 0.65,
        y + 0.15,
        x + 0.8,
        y - 1.9,
        x + 1.45,
        y + 0.15
      );
      this.soldierGraphics.fillTriangle(
        x + size + 0.65,
        y + 0.15,
        x + size - 0.8,
        y - 1.9,
        x + size - 1.45,
        y + 0.15
      );
    }
    this.soldierGraphics.lineStyle(0.65, 0x0b1724, soldier.status === "wandering" ? 0.5 : 0.82);
    this.soldierGraphics.strokeRect(x, y, size, size);
  }

  private handleResize(): void {
    const width = this.scale.width;
    const height = this.scale.height;
    const cameraBounds = this.commandOnlyMode
      ? this.getPlayableCameraBounds()
      : this.getFullMapCameraBounds();
    const zoom = Math.min(width / cameraBounds.width, height / cameraBounds.height);
    this.cameras.main.setViewport(0, 0, width, height);
    this.cameras.main.setZoom(zoom);
    this.cameras.main.centerOn(
      cameraBounds.x + cameraBounds.width / 2,
      cameraBounds.y + cameraBounds.height / 2
    );
  }

  private getFullMapCameraBounds(): { x: number; y: number; width: number; height: number } {
    return {
      x: 0,
      y: 0,
      width: Math.max(1, this.state.mapSize.width),
      height: Math.max(1, this.state.mapSize.height)
    };
  }

  private getPlayableCameraBounds(): { x: number; y: number; width: number; height: number } {
    if (this.state.countries.length === 0) {
      return this.getFullMapCameraBounds();
    }

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    for (const country of this.state.countries) {
      for (const polygon of this.getCountryTerritoryPolygons(country)) {
        for (const point of polygon) {
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
        }
      }
    }

    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      return this.getFullMapCameraBounds();
    }

    const mapWidth = Math.max(1, this.state.mapSize.width);
    const mapHeight = Math.max(1, this.state.mapSize.height);
    const padding = 30;
    const minBoundsWidth = mapWidth * 0.72;
    const minBoundsHeight = mapHeight * 0.72;
    const rawLeft = Math.max(0, minX - padding);
    const rawTop = Math.max(0, minY - padding);
    const rawRight = Math.min(mapWidth, maxX + padding);
    const rawBottom = Math.min(mapHeight, maxY + padding);
    const rawCenterX = (rawLeft + rawRight) / 2;
    const rawCenterY = (rawTop + rawBottom) / 2;
    const boundsWidth = Math.min(mapWidth, Math.max(minBoundsWidth, rawRight - rawLeft));
    const boundsHeight = Math.min(mapHeight, Math.max(minBoundsHeight, rawBottom - rawTop));
    const x = Phaser.Math.Clamp(rawCenterX - boundsWidth / 2, 0, mapWidth - boundsWidth);
    const y = Phaser.Math.Clamp(rawCenterY - boundsHeight / 2, 0, mapHeight - boundsHeight);

    return {
      x,
      y,
      width: boundsWidth,
      height: boundsHeight
    };
  }

  private getCurrentMapSize(): Size {
    if (this.commandOnlyMode) {
      return {
        width: MOBILE_MAP_WIDTH,
        height: MOBILE_MAP_HEIGHT
      };
    }

    return {
      width: Math.max(320, Math.round(this.scale.width)),
      height: Math.max(360, Math.round(this.scale.height))
    };
  }

  private getTerrainSignature(): string {
    const config = this.state.region.generationConfig;
    const terrain = this.state.region.terrain;
    return [
      this.state.round,
      this.state.region.id,
      config?.seed ?? "",
      config?.worldType ?? "",
      config?.temperature ?? "",
      config?.mapViewMode ?? "",
      terrain?.width ?? 0,
      terrain?.height ?? 0,
      terrain?.coastline?.length ?? 0,
      terrain?.mountainRidges?.length ?? 0,
      terrain?.contours?.length ?? 0
    ].join(":");
  }

  private getMapViewMode(): "political" | "terrain" | "mixed" {
    return this.state.region.generationConfig?.mapViewMode ?? "mixed";
  }

  private getCountryFillAlpha(): number {
    switch (this.getMapViewMode()) {
      case "terrain":
        return 0.52;
      case "political":
        return 0.98;
      case "mixed":
      default:
        return 0.82;
    }
  }

  private getContestedProvinceFillAlpha(): number {
    return this.getMapViewMode() === "terrain" ? 0.74 : 0.96;
  }

  private getProvinceLineAlpha(): number {
    return this.getMapViewMode() === "terrain" ? 0.035 : 0.06;
  }

  private getBiomeColor(biome: Biome): number {
    switch (biome) {
      case "coast":
        return 0x4b9fb9;
      case "plains":
        return 0x6fa963;
      case "forest":
        return 0x31724f;
      case "desert":
        return 0xc9ad64;
      case "wetland":
        return 0x5ba486;
      case "mountain":
        return 0x8c8b82;
      case "snow":
        return 0xdce7ec;
      case "ocean":
      default:
        return 0x0d2235;
    }
  }

  private handlePointerDown(pointer: Phaser.Input.Pointer): void {
    if (this.commandOnlyMode) {
      return;
    }

    const worldPoint = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    const point = { x: worldPoint.x, y: worldPoint.y };
    const routeHit = this.findRouteAtPoint(point);
    if (routeHit) {
      this.focusedAttackId = routeHit.attackId;
      this.focusedCountryId = null;
      this.onStateChanged();
      return;
    }

    const country = this.state.countries.find((candidate) =>
      this.isPointInCountryTerritory(point, candidate)
    );

    if (country) {
      const relatedRoute = this.findBestRouteForCountry(country.id);
      this.focusedCountryId = country.id;
      this.focusedAttackId = relatedRoute?.attackId ?? null;
      this.onCountrySelected?.(country.id);
      this.onStateChanged();
      return;
    }

    this.focusedAttackId = null;
    this.focusedCountryId = null;
    this.onStateChanged();
  }

  private findRouteAtPoint(point: Point): RouteHitArea | undefined {
    return [...this.routeHitAreas]
      .reverse()
      .find((route) => this.distanceToCurve(point, route.curve) <= 16);
  }

  private findBestRouteForCountry(countryId: number): RouteHitArea | undefined {
    return (
      this.routeHitAreas.find((route) => route.targetCountryId === countryId) ??
      this.routeHitAreas.find((route) => route.sourceCountryId === countryId)
    );
  }

  private distanceToCurve(point: Point, curve: RouteCurve): number {
    let bestDistance = Number.POSITIVE_INFINITY;
    let previous = this.getCurvePoint(curve, 0);

    for (let step = 1; step <= 48; step += 1) {
      const current = this.getCurvePoint(curve, step / 48);
      bestDistance = Math.min(bestDistance, this.distanceToSegment(point, previous, current));
      previous = current;
    }

    return bestDistance;
  }

  private distanceToSegment(point: Point, start: Point, end: Point): number {
    const lengthSquared = (end.x - start.x) ** 2 + (end.y - start.y) ** 2;
    if (lengthSquared === 0) {
      return distance(point, start);
    }

    const t = Phaser.Math.Clamp(
      ((point.x - start.x) * (end.x - start.x) + (point.y - start.y) * (end.y - start.y)) /
        lengthSquared,
      0,
      1
    );
    return distance(point, {
      x: start.x + (end.x - start.x) * t,
      y: start.y + (end.y - start.y) * t
    });
  }

  private getLabelSignature(): string {
    const nickname = getDisplayNickname(this.state.playerProfile);
    const labelGroupsSignature = this.getLabelGroups()
      .map((group) => {
        const countryIds = group.countries.map((country) => country.id).join(",");
        return group.isPlayerGroup
          ? `${group.controllerCountryId}[${countryIds}]:${nickname}`
          : `${group.controllerCountryId}[${countryIds}]`;
      })
      .join("|");
    return `${this.getMapGeometrySignature()}::${labelGroupsSignature}`;
  }

  private getMapGeometrySignature(): string {
    const config = this.state.region.generationConfig;
    const countryGeometry = this.state.countries
      .map((country) =>
        [
          country.id,
          country.center.x.toFixed(1),
          country.center.y.toFixed(1),
          country.area.toFixed(0),
          this.getCountryTerritoryPolygons(country).length
        ].join(":")
      )
      .join("|");
    return [
      this.state.round,
      this.state.startedAt.toFixed(0),
      this.state.region.id,
      config?.seed ?? "",
      `${this.state.mapSize.width}x${this.state.mapSize.height}`,
      countryGeometry
    ].join("#");
  }

  private getLabelGroups(): LabelGroup[] {
    const grouped = new Map<number, Country[]>();
    for (const country of this.state.countries) {
      const countries = grouped.get(country.controllerCountryId) ?? [];
      countries.push(country);
      grouped.set(country.controllerCountryId, countries);
    }

    return [...grouped.entries()]
      .sort(([leftId], [rightId]) => leftId - rightId)
      .map(([controllerCountryId, countries]) => {
        const sortedCountries = [...countries].sort((left, right) => left.id - right.id);
        const networkPlayer = this.getNetworkPlayerForGroup(controllerCountryId, sortedCountries);
        const isPlayerGroup =
          Boolean(networkPlayer) || this.isPlayerControlledGroup(controllerCountryId, sortedCountries);
        return {
          controllerCountryId,
          countries: sortedCountries,
          isPlayerGroup,
          nickname: networkPlayer?.nickname ?? null,
          labelPoint: this.getLabelPointForCountries(sortedCountries, isPlayerGroup),
          labelArea: this.getLabelAreaForCountries(sortedCountries),
          fontSize: this.getLabelFontSize(sortedCountries, isPlayerGroup)
        };
      });
  }

  private getVisibleLabelGroups(): LabelGroup[] {
    return this.getLabelGroups();
  }

  private getNetworkPlayerForGroup(controllerCountryId: number, countries: Country[]) {
    return this.state.networkPlayers.find((player) => {
      if (
        player.factionId === controllerCountryId ||
        player.controllerCountryId === controllerCountryId
      ) {
        return true;
      }

      return countries.some((country) => player.countryIds.includes(country.id));
    });
  }

  private isPlayerControlledGroup(controllerCountryId: number, countries: Country[]): boolean {
    const playerCountryIds = new Set(this.state.playerCountryIds);
    if (countries.some((country) => playerCountryIds.has(country.id))) {
      return true;
    }

    return this.state.playerCountryIds.some((countryId) => {
      const country = this.state.countries[countryId - 1];
      return country?.controllerCountryId === controllerCountryId;
    });
  }

  private getLabelPointForCountries(countries: Country[], preferPlayerArea = false): Point {
    if (countries.length === 0) {
      return { x: 0, y: 0 };
    }

    const playerCountryIds = new Set(this.state.playerCountryIds);
    const preferredCountries =
      preferPlayerArea
        ? countries.filter((country) => playerCountryIds.has(country.id))
        : countries;
    const weightedCountries = preferredCountries.length > 0 ? preferredCountries : countries;
    const totalArea = weightedCountries.reduce((sum, country) => sum + country.area, 0);
    const weightedPoint =
      totalArea > 0
        ? {
            x:
              weightedCountries.reduce((sum, country) => sum + country.center.x * country.area, 0) /
              totalArea,
            y:
              weightedCountries.reduce((sum, country) => sum + country.center.y * country.area, 0) /
              totalArea
          }
        : weightedCountries[0].center;

    if (countries.some((country) => this.isPointInCountryTerritory(weightedPoint, country))) {
      const containingCountry = countries.find((country) => this.isPointInCountryTerritory(weightedPoint, country));
      return containingCountry ? this.getSafeCountryLabelPoint(containingCountry, weightedPoint) : weightedPoint;
    }

    const mainCountry = this.state.playerMainCountryId
      ? countries.find((country) => country.id === this.state.playerMainCountryId)
      : undefined;
    if (preferPlayerArea && mainCountry) {
      return this.getSafeCountryLabelPoint(mainCountry);
    }

    const nearestCountry = [...weightedCountries].sort(
      (left, right) => distance(left.center, weightedPoint) - distance(right.center, weightedPoint)
    )[0];
    return this.getSafeCountryLabelPoint(nearestCountry);
  }

  private getSafeCountryLabelPoint(country: Country, preferredPoint?: Point): Point {
    if (preferredPoint && this.isPointInCountryTerritory(preferredPoint, country)) {
      return preferredPoint;
    }

    const largestProvince = [...country.provinces].sort((left, right) => right.area - left.area)[0];
    if (largestProvince && pointInPolygon(largestProvince.center, country.polygon)) {
      return largestProvince.center;
    }

    if (pointInPolygon(country.center, country.polygon)) {
      return country.center;
    }

    return [...country.polygon].sort(
      (left, right) => distance(left, country.center) - distance(right, country.center)
    )[0];
  }

  private getCountryTerritoryPolygons(country: Country): Point[][] {
    return country.territoryPolygons && country.territoryPolygons.length > 0
      ? country.territoryPolygons
      : [country.polygon];
  }

  private isPointInCountryTerritory(point: Point, country: Country): boolean {
    return this.getCountryTerritoryPolygons(country).some((polygon) => pointInPolygon(point, polygon));
  }

  private getLabelAreaForCountries(countries: Country[]): number {
    return countries.reduce((sum, country) => sum + this.getCountryTerritoryArea(country), 0);
  }

  private getLabelFontSize(countries: Country[], isPlayerGroup: boolean): number {
    const labelArea = this.getLabelAreaForCountries(countries);
    const maxSize = isPlayerGroup ? 14 : 17;
    const minSize = isPlayerGroup ? 10 : 8;
    return Math.round(Phaser.Math.Clamp(Math.sqrt(labelArea) / 2.6, minSize, maxSize));
  }

  private getCountryTerritoryArea(country: Country): number {
    return this.getCountryTerritoryPolygons(country).reduce(
      (sum, polygon) => sum + polygonArea(polygon),
      0
    );
  }

  private getLabelStrokeWidth(fontSize: number): number {
    return Math.round(Phaser.Math.Clamp(fontSize * 0.3, 3, 5));
  }
}
