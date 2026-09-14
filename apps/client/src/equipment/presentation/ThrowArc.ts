import { Color3, Vector3 } from "@babylonjs/core";
import type { ThrowArcView } from "../types";
import { EqCell } from "./equipmentAtlas";
import type { EquipmentFx } from "./fxPools";
import type { HavokWorldRay } from "./support";

/** Distance between dots along the arc, m. */
const DOT_SPACING = 0.42;
/** The first stretch leaves the hand under the viewmodel; skip it. */
const START_SKIP = 0.9;
const MAX_DOTS = 110;
const DOT_SIZE = 0.028;
const MARCH_SPEED = 0.7;

const COLOR = new Color3(0.96, 0.95, 0.9);
const COOK_COLOR = new Color3(1, 0.45, 0.2);
const MARKER = new Color3(1, 1, 1);

/**
 * Trajectory preview from the predicted arc (same math as the flight): dots marching along the polyline, fading toward
 * the landing point, plus a landing ring and dot lying on the surface there (normal from the contract when provided,
 * else one short Havok probe along the last segment). Tints toward orange as a cooked fuse burns.
 */
export class ThrowArc {
  private phase = 0;
  private readonly a = new Vector3();
  private readonly b = new Vector3();
  private readonly point = new Vector3();
  private readonly end = new Vector3();
  private readonly normal = new Vector3(0, 1, 0);
  private readonly hit = new Vector3();
  private readonly color = new Color3();
  private time = 0;
  /** Dots drawn last frame, for checks. */
  drawn = 0;

  constructor(
    private readonly fx: EquipmentFx,
    private readonly ray: HavokWorldRay | null,
  ) {}

  render(dt: number, arc: ThrowArcView, cookProgress: number): void {
    this.time += dt;
    this.phase = (this.phase + dt * MARCH_SPEED) % DOT_SPACING;
    this.drawn = 0;
    const count = arc.count;
    if (!arc.visible || count < 2) return;
    const points = arc.points;
    Color3.LerpToRef(COLOR, COOK_COLOR, Math.min(1, cookProgress * 1.2), this.color);

    let total = 0;
    for (let i = 1; i < count; i++) {
      const o = i * 3;
      total += Math.hypot(points[o]! - points[o - 3]!, points[o + 1]! - points[o - 2]!, points[o + 2]! - points[o - 1]!);
    }
    if (total <= START_SKIP) return;

    let travelled = 0;
    let next = START_SKIP + this.phase;
    for (let i = 1; i < count && this.drawn < MAX_DOTS; i++) {
      const o = i * 3;
      this.a.set(points[o - 3]!, points[o - 2]!, points[o - 1]!);
      this.b.set(points[o]!, points[o + 1]!, points[o + 2]!);
      const length = Vector3.Distance(this.a, this.b);
      while (next <= travelled + length && this.drawn < MAX_DOTS) {
        const t = length > 0 ? (next - travelled) / length : 0;
        Vector3.LerpToRef(this.a, this.b, t, this.point);
        const along = next / total;
        const alpha = 0.85 * Math.min(1, (next - START_SKIP) / 0.6) * (1 - 0.55 * along);
        this.fx.arcBatch.sprite(this.point, DOT_SIZE, 0, EqCell.dot, this.color, alpha);
        this.drawn++;
        next += DOT_SPACING;
      }
      travelled += length;
    }

    const e = (count - 1) * 3;
    this.end.set(points[e]!, points[e + 1]!, points[e + 2]!);
    let marker = this.end;
    if (arc.endNormal) {
      this.normal.set(arc.endNormal.x, arc.endNormal.y, arc.endNormal.z);
    } else if (this.ray) {
      // Probe along the last segment, a little past the end point.
      this.a.set(points[e - 3]!, points[e - 2]!, points[e - 1]!);
      this.b.copyFrom(this.end).subtractInPlace(this.a);
      const length = this.b.length();
      if (length > 1e-4) this.b.scaleInPlace(1 / length);
      else this.b.set(0, -1, 0);
      if (this.ray.castToRef(this.end.x - this.b.x * 0.25, this.end.y - this.b.y * 0.25, this.end.z - this.b.z * 0.25, this.end.x + this.b.x * 0.35, this.end.y + this.b.y * 0.35, this.end.z + this.b.z * 0.35, this.hit, this.normal) < 0) {
        this.normal.set(0, 1, 0);
      } else {
        marker = this.hit;
      }
    }
    const pulse = 1 + 0.08 * Math.sin(this.time * 6);
    this.fx.decalBatch.decal(marker, this.normal, 0.32 * pulse, this.time * 0.6, EqCell.ring, MARKER, 0.75);
    this.fx.decalBatch.decal(marker, this.normal, 0.07, 0, EqCell.dot, this.color, 0.8);
  }
}
