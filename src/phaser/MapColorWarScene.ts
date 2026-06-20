import Phaser from "phaser";
import {
  MAP_BACKGROUND_COLOR,
  NEUTRAL_STROKE_COLOR,
  PLAYER_STROKE_COLOR,
  SOLDIER_RADIUS
} from "../constants";
import type { AttackTask, Country, GameState, Point, Size, Soldier } from "../types";
import { getAttackRoute } from "../game/attackRules";
import { tickGame } from "../game/tick";
import { getCountryColorById, getProvinceColor, getSoldierColor } from "../game/provinces";
import { getDisplayNickname } from "../game/playerProfile";
import { distance, pointInPolygon } from "../utils/geometry";

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
  label: string;
  statusText: string;
  soldierCount: number;
  isFocused: boolean;
  isSea: boolean;
};

type LabelGroup = {
  controllerCountryId: number;
  countries: Country[];
  isPlayerGroup: boolean;
  nickname: string | null;
  labelPoint: Point;
};

export class MapColorWarScene extends Phaser.Scene {
  private state: GameState;
  private countryGraphics!: Phaser.GameObjects.Graphics;
  private routeGraphics!: Phaser.GameObjects.Graphics;
  private soldierGraphics!: Phaser.GameObjects.Graphics;
  private routeLabelLayer!: Phaser.GameObjects.Container;
  private labelLayer!: Phaser.GameObjects.Container;
  private labels = new Map<number, Phaser.GameObjects.Text>();
  private routeHitAreas: RouteHitArea[] = [];
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
    this.countryGraphics = this.add.graphics();
    this.routeGraphics = this.add.graphics();
    this.soldierGraphics = this.add.graphics();
    this.routeLabelLayer = this.add.container(0, 0);
    this.labelLayer = this.add.container(0, 0);
    this.countryGraphics.setDepth(1);
    this.routeGraphics.setDepth(3);
    this.soldierGraphics.setDepth(4);
    this.routeLabelLayer.setDepth(6);
    this.labelLayer.setDepth(8);
    this.scale.on("resize", this.handleResize, this);
    this.input.on("pointerdown", this.handlePointerDown, this);
    this.handleResize();
    this.drawCountries();
    this.drawLabels();
    this.drawAttackRoutes(0);
    this.drawSoldiers();
  }

  update(time: number, delta: number): void {
    if (!this.authoritativeRemote) {
      tickGame(this.state, delta, performance.now(), this.getCurrentMapSize());
    }

    const labelSignature = this.getLabelSignature();
    const labelGroupCount = this.getLabelGroups().length;
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
    this.drawSoldiers();

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

    this.drawRegionOutline();
  }

  private drawRegionBase(): void {
    this.countryGraphics.fillStyle(0x14253a, 0.42);
    for (const outline of this.state.region.outlinePolygons) {
      const regionPath = new Phaser.Geom.Polygon(outline);
      this.countryGraphics.fillPoints(regionPath.points, true);
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
    const isPlayerControlled = this.isPlayerControlledGroup(country.controllerCountryId, [country]);
    const strokeColor = isPlayerControlled ? PLAYER_STROKE_COLOR : NEUTRAL_STROKE_COLOR;

    for (const province of country.provinces) {
      const provincePath = new Phaser.Geom.Polygon(province.polygon);
      this.countryGraphics.fillStyle(getProvinceColor(this.state, country, province), 0.98);
      this.countryGraphics.fillPoints(provincePath.points, true);
      this.countryGraphics.lineStyle(0.55, 0xffffff, 0.18);
      this.countryGraphics.strokePoints(provincePath.points, true);
    }

    const countryPath = new Phaser.Geom.Polygon(country.polygon);
    this.countryGraphics.lineStyle(isPlayerControlled ? 3 : 1.65, strokeColor, 1);
    this.countryGraphics.strokePoints(countryPath.points, true);
  }

  private drawLabels(): void {
    this.labelLayer.removeAll(true);
    this.labels.clear();

    for (const group of this.getLabelGroups()) {
      const labelText = group.isPlayerGroup
        ? `${group.controllerCountryId}\n${group.nickname ?? getDisplayNickname(this.state.playerProfile)}`
        : String(group.controllerCountryId);
      const label = this.add
        .text(group.labelPoint.x, group.labelPoint.y, labelText, {
          fontFamily: "Arial, sans-serif",
          fontSize: group.isPlayerGroup ? "14px" : "17px",
          color: "#06101f",
          fontStyle: "900",
          align: "center",
          lineSpacing: -3
        })
        .setOrigin(0.5);
      label.setStroke("#ffffff", 5);
      label.setDepth(8);
      this.labelLayer.add(label);
      this.labels.set(group.controllerCountryId, label);
    }

    this.lastLabelRound = this.state.round;
    this.lastLabelSignature = this.getLabelSignature();
  }

  private drawSoldiers(): void {
    this.soldierGraphics.clear();

    for (const soldier of this.state.soldiers) {
      if (!soldier.alive) {
        continue;
      }
      this.drawSoldier(soldier);
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
        const message = this.formatRouteMessage(attack, sourceCountry, targetCountry, visualState);

        this.routeHitAreas.push({
          attackId: attack.id,
          sourceCountryId: sourceCountry.id,
          targetCountryId: targetCountry.id,
          curve,
          message
        });

        if (attack.phase === "fighting") {
          this.drawTargetPulse(targetCountry, time, visualState.color, visualState.alpha);
        }

        this.drawRouteLine(curve, {
          ...visualState,
          dashOffset: (time / 48 + attackIndex * 7 + participantIndex * 4) % 28
        });
        this.drawRouteParticles(curve, visualState, time, routeIndex);
        this.drawRouteLabel(curve, visualState, message);
      });
    });
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
    const soldierCount = attack.attackerSoldierIds.filter((soldierId) =>
      this.state.soldiers.some((soldier) => soldier.id === soldierId && soldier.alive)
    ).length;
    const isSea = getAttackRoute(this.state, sourceCountry, targetCountry) === "sea";
    const baseColor =
      attack.kind === "counter"
        ? 0xff6a3d
          : isSea
            ? 0x35c9ff
            : (getCountryColorById(this.state, sourceCountry.controllerCountryId) ?? sourceCountry.color);
    const statusText =
      attack.phase === "fighting"
        ? "交战"
        : attack.phase === "painting"
          ? "填色"
          : attack.kind === "counter"
            ? "反推"
            : "进攻";
    const phaseAlpha =
      attack.phase === "fighting" ? 0.9 : attack.phase === "painting" ? 0.48 : 0.7;
    const phaseWidth = attack.phase === "painting" ? 1.55 : attack.phase === "fighting" ? 3.15 : 2.4;
    const focusMultiplier = isFocused ? 1 : 0.24;

    return {
      color: baseColor,
      alpha: phaseAlpha * focusMultiplier,
      width: isFocused ? phaseWidth : Math.max(1, phaseWidth - 0.8),
      label: `${statusText} ${soldierCount}兵`,
      statusText,
      soldierCount,
      isFocused,
      isSea
    };
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

  private drawRouteLabel(curve: RouteCurve, visualState: RouteVisualState, message: string): void {
    if (!visualState.isFocused && visualState.alpha < 0.35) {
      return;
    }

    const labelPoint = this.getCurvePoint(curve, 0.52);
    const label = this.add
      .text(labelPoint.x, labelPoint.y, visualState.label, {
        fontFamily: "Arial, sans-serif",
        fontSize: "11px",
        color: "#ffffff",
        fontStyle: "900",
        align: "center"
      })
      .setOrigin(0.5);
    label.setPadding(5, 3, 5, 3);
    label.setBackgroundColor("rgba(6, 16, 31, 0.78)");
    label.setStroke("#06101f", 3);
    label.setAlpha(Math.max(0.42, visualState.alpha));
    label.setData("routeMessage", message);
    this.routeLabelLayer.add(label);
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
      visualState.statusText === "交战" ? 1450 : visualState.statusText === "填色" ? 2100 : 1050;
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

  private drawTargetPulse(country: Country, time: number, color: number, alpha: number): void {
    const pulse = 0.55 + Math.sin(time / 150) * 0.25;
    this.routeGraphics.lineStyle(4.2, 0x06101f, alpha * 0.26 * pulse);
    this.routeGraphics.strokePoints(country.polygon, true);
    this.routeGraphics.lineStyle(2.2, color, alpha * 0.7 * pulse);
    this.routeGraphics.strokePoints(country.polygon, true);
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

  private drawSoldier(soldier: Soldier): void {
    const color = getSoldierColor(this.state, soldier);
    const active = soldier.status === "attacking" || soldier.status === "fighting";
    const size = SOLDIER_RADIUS * 2;
    const x = soldier.x - size / 2;
    const y = soldier.y - size / 2;

    if (active) {
      this.soldierGraphics.lineStyle(1.4, 0xffffff, 0.95);
      this.soldierGraphics.strokeRect(x - 1.8, y - 1.8, size + 3.6, size + 3.6);
    }

    this.soldierGraphics.fillStyle(color, soldier.status === "wandering" ? 0.88 : 0.98);
    this.soldierGraphics.fillRect(x, y, size, size);
    this.soldierGraphics.lineStyle(0.8, 0x0b1724, soldier.status === "wandering" ? 0.55 : 0.9);
    this.soldierGraphics.strokeRect(x, y, size, size);
  }

  private handleResize(): void {
    const width = this.scale.width;
    const height = this.scale.height;
    const zoom = Math.min(width / this.state.mapSize.width, height / this.state.mapSize.height);
    const offsetX = (width - this.state.mapSize.width * zoom) / 2;
    const offsetY = (height - this.state.mapSize.height * zoom) / 2;
    this.cameras.main.setZoom(zoom);
    this.cameras.main.setScroll(-offsetX / zoom, -offsetY / zoom);
  }

  private getCurrentMapSize(): Size {
    return {
      width: Math.max(320, Math.round(this.scale.width)),
      height: Math.max(360, Math.round(this.scale.height))
    };
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
      this.onRouteSelected?.(routeHit.message);
      this.onStateChanged();
      return;
    }

    const country = this.state.countries.find((candidate) =>
      pointInPolygon(point, candidate.polygon)
    );

    if (country) {
      const relatedRoute = this.findBestRouteForCountry(country.id);
      this.focusedCountryId = country.id;
      this.focusedAttackId = relatedRoute?.attackId ?? null;
      this.onCountrySelected?.(country.id, relatedRoute?.message);
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

  private formatRouteMessage(
    attack: AttackTask,
    sourceCountry: Country,
    targetCountry: Country,
    visualState: RouteVisualState
  ): string {
    return `${sourceCountry.displayCountryId} -> ${targetCountry.displayCountryId}｜${visualState.statusText}｜${visualState.soldierCount}兵｜阶段：${this.getPhaseText(attack)}`;
  }

  private getPhaseText(attack: AttackTask): string {
    if (attack.phase === "fighting") {
      return "交战";
    }
    if (attack.phase === "painting") {
      return "填色";
    }
    return attack.kind === "counter" ? "反推移动" : "进攻移动";
  }

  private getLabelSignature(): string {
    const nickname = getDisplayNickname(this.state.playerProfile);
    return this.getLabelGroups()
      .map((group) => {
        const countryIds = group.countries.map((country) => country.id).join(",");
        return group.isPlayerGroup
          ? `${group.controllerCountryId}[${countryIds}]:${nickname}`
          : `${group.controllerCountryId}[${countryIds}]`;
      })
      .join("|");
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
          labelPoint: this.getLabelPointForCountries(sortedCountries, isPlayerGroup)
        };
      });
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

    if (countries.some((country) => pointInPolygon(weightedPoint, country.polygon))) {
      return weightedPoint;
    }

    const mainCountry = this.state.playerMainCountryId
      ? countries.find((country) => country.id === this.state.playerMainCountryId)
      : undefined;
    if (preferPlayerArea && mainCountry) {
      return mainCountry.center;
    }

    return [...weightedCountries].sort(
      (left, right) => distance(left.center, weightedPoint) - distance(right.center, weightedPoint)
    )[0].center;
  }
}
