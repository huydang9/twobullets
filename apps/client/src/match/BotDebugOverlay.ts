import { Color3, Matrix, MeshBuilder, Vector3, Viewport, type LinesMesh, type Scene } from "@babylonjs/core";
import { RIG_SHAPE_COUNT, RIG_SHAPE_STRIDE, RigShapeKind } from "@twobullets/shared";
import type { MatchSim } from "@twobullets/sim";
import { el } from "../ui/dom";
import type { BotBodies } from "./BotBodies";

const RING_SEGMENTS = 12;
/** Lines per posed rig shape (sphere: 3 rings; capsule: 2 rings + 4 sides; box: 12 edges). */
const RIG_LINES_PER_SHAPE = RING_SEGMENTS * 3;
const PATH_LINES = 48;
const RAY_LINES = 10;

/**
 * DEV `?botDebug=1` (F7 toggles): per bot a label (goal, sub-state, HP, target), its current nav path, perception rays to
 * visible actors and the procedural rig the match tests bot bullets against. Compare the rig with the bone hitboxes the
 * human's bullets hit via F8 (physics shapes). Line meshes are fixed-size and updated in place; unused lines collapse.
 */
export class BotDebugOverlay {
  private readonly rig: LineSet;
  private readonly paths: LineSet;
  private readonly rays: LineSet;
  private readonly labels: HTMLDivElement[] = [];
  private readonly layer: HTMLDivElement;
  private readonly projected = new Vector3();
  private readonly world = new Vector3();
  private readonly viewport = new Viewport(0, 0, 1, 1);
  private enabled = true;

  constructor(
    private readonly scene: Scene,
    private readonly match: MatchSim,
    private readonly bodies: BotBodies,
    parent: HTMLElement,
  ) {
    const count = bodies.list.length;
    this.rig = new LineSet(scene, "botDebugRig", count * RIG_SHAPE_COUNT * RIG_LINES_PER_SHAPE, new Color3(1, 0.85, 0.2));
    this.paths = new LineSet(scene, "botDebugPaths", count * PATH_LINES, new Color3(0.2, 0.9, 1));
    this.rays = new LineSet(scene, "botDebugRays", count * RAY_LINES, new Color3(0.3, 1, 0.3));
    this.layer = el("div", "tb-botdebug", undefined, parent);
    for (let i = 0; i < count; i++) this.labels.push(el("div", "tb-botdebug__label", undefined, this.layer));
  }

  toggle(): boolean {
    this.enabled = !this.enabled;
    this.layer.hidden = !this.enabled;
    this.rig.setEnabled(this.enabled);
    this.paths.setEnabled(this.enabled);
    this.rays.setEnabled(this.enabled);
    return this.enabled;
  }

  /** Per frame before scene.render. */
  update(): void {
    if (!this.enabled) return;
    const rig = this.rig.begin();
    const paths = this.paths.begin();
    const rays = this.rays.begin();
    const camera = this.scene.activeCamera;
    const canvas = this.scene.getEngine().getRenderingCanvas();
    const width = canvas?.clientWidth ?? 1;
    const height = canvas?.clientHeight ?? 1;
    this.viewport.width = width;
    this.viewport.height = height;
    const transform = this.scene.getTransformMatrix();

    this.bodies.list.forEach((body, i) => {
      const label = this.labels[i]!;
      const actor = body.actor;
      const brain = this.match.brainOf(body.slot);
      if (!actor || actor.life === "dead" || !brain) {
        label.hidden = true;
        return;
      }
      const shapes = this.match.hitboxesOf(body.slot);
      if (shapes) for (let s = 0; s < RIG_SHAPE_COUNT; s++) addShape(rig, shapes, s * RIG_SHAPE_STRIDE);

      const debug = brain.debug();
      const path = debug.path;
      if (path) {
        const pts = path.points;
        let x = actor.feet.x;
        let y = actor.feet.y + 0.15;
        let z = actor.feet.z;
        for (let p = 0; p < path.count && p < PATH_LINES; p++) {
          const nx = pts[p * 3]!;
          const ny = pts[p * 3 + 1]! + 0.15;
          const nz = pts[p * 3 + 2]!;
          paths.line(x, y, z, nx, ny, nz);
          x = nx;
          y = ny;
          z = nz;
        }
      }
      const eyeY = actor.feet.y + (actor.stance === "stand" ? 1.62 : 1.05);
      let rayCount = 0;
      for (const seen of brain.perception.actors) {
        if (!seen.visible || rayCount >= RAY_LINES) continue;
        const other = this.match.state.actors[seen.slot];
        if (!other) continue;
        rays.line(actor.feet.x, eyeY, actor.feet.z, other.feet.x, other.feet.y + 1.4, other.feet.z);
        rayCount++;
      }

      // Label above the head.
      this.world.set(actor.feet.x, actor.feet.y + 2.15, actor.feet.z);
      Vector3.ProjectToRef(this.world, Matrix.IdentityReadOnly, transform, this.viewport, this.projected);
      const onScreen = camera !== null && this.projected.z > 0 && this.projected.z < 1 && this.projected.x > -100 && this.projected.x < width + 100;
      label.hidden = !onScreen;
      if (!onScreen) return;
      const text = `${body.name} · ${debug.goal}/${debug.subState} · ${Math.round(actor.life === "downed" ? actor.downedHealth : actor.health)} HP${debug.targetSlot >= 0 ? ` → ${debug.targetSlot}` : ""}`;
      if (label.textContent !== text) label.textContent = text;
      label.style.transform = `translate3d(${Math.round(this.projected.x)}px,${Math.round(this.projected.y)}px,0) translate(-50%,-100%)`;
    });

    this.rig.end();
    this.paths.end();
    this.rays.end();
  }

  dispose(): void {
    this.rig.dispose();
    this.paths.dispose();
    this.rays.dispose();
    this.layer.remove();
  }
}

/** A fixed-capacity line system rewritten each frame; lines past the used count collapse to a point. */
class LineSet {
  private readonly lines: Vector3[][];
  private mesh: LinesMesh;
  private used = 0;

  constructor(
    private readonly scene: Scene,
    private readonly name: string,
    capacity: number,
    color: Color3,
  ) {
    this.lines = Array.from({ length: Math.max(1, capacity) }, () => [new Vector3(), new Vector3()]);
    this.mesh = MeshBuilder.CreateLineSystem(name, { lines: this.lines, updatable: true }, scene);
    this.mesh.color = color;
    this.mesh.isPickable = false;
    this.mesh.renderingGroupId = 1;
    this.mesh.alwaysSelectAsActiveMesh = true;
  }

  begin(): this {
    this.used = 0;
    return this;
  }

  line(ax: number, ay: number, az: number, bx: number, by: number, bz: number): void {
    const line = this.lines[this.used];
    if (!line) return;
    this.used++;
    line[0]!.set(ax, ay, az);
    line[1]!.set(bx, by, bz);
  }

  end(): void {
    for (let i = this.used; i < this.lines.length; i++) {
      const line = this.lines[i]!;
      line[0]!.setAll(0);
      line[1]!.setAll(0);
    }
    this.mesh = MeshBuilder.CreateLineSystem(this.name, { lines: this.lines, instance: this.mesh }, this.scene);
  }

  setEnabled(enabled: boolean): void {
    this.mesh.setEnabled(enabled);
  }

  dispose(): void {
    this.mesh.dispose();
  }
}

const QX = new Vector3();
const QY = new Vector3();
const QZ = new Vector3();

function addShape(out: LineSet, b: Float64Array, o: number): void {
  const kind = b[o]!;
  const r = b[o + 8]!;
  if (kind === RigShapeKind.sphere) {
    ring(out, b[o + 2]!, b[o + 3]!, b[o + 4]!, r, 0);
    ring(out, b[o + 2]!, b[o + 3]!, b[o + 4]!, r, 1);
    ring(out, b[o + 2]!, b[o + 3]!, b[o + 4]!, r, 2);
  } else if (kind === RigShapeKind.capsule) {
    const ax = b[o + 2]!, ay = b[o + 3]!, az = b[o + 4]!;
    const bx = b[o + 5]!, by = b[o + 6]!, bz = b[o + 7]!;
    ring(out, ax, ay, az, r, 1);
    ring(out, bx, by, bz, r, 1);
    out.line(ax + r, ay, az, bx + r, by, bz);
    out.line(ax - r, ay, az, bx - r, by, bz);
    out.line(ax, ay, az + r, bx, by, bz + r);
    out.line(ax, ay, az - r, bx, by, bz - r);
  } else {
    const cx = b[o + 2]!, cy = b[o + 3]!, cz = b[o + 4]!;
    const hx = b[o + 9]!, hy = b[o + 10]!, hz = b[o + 11]!;
    const qx = b[o + 12]!, qy = b[o + 13]!, qz = b[o + 14]!, qw = b[o + 15]!;
    rotate(qx, qy, qz, qw, hx, 0, 0, QX);
    rotate(qx, qy, qz, qw, 0, hy, 0, QY);
    rotate(qx, qy, qz, qw, 0, 0, hz, QZ);
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const px = cx + QY.x * sy + QZ.x * sz, py = cy + QY.y * sy + QZ.y * sz, pz = cz + QY.z * sy + QZ.z * sz;
        out.line(px - QX.x, py - QX.y, pz - QX.z, px + QX.x, py + QX.y, pz + QX.z);
        const ex = cx + QX.x * sy + QZ.x * sz, ey = cy + QX.y * sy + QZ.y * sz, ez = cz + QX.z * sy + QZ.z * sz;
        out.line(ex - QY.x, ey - QY.y, ez - QY.z, ex + QY.x, ey + QY.y, ez + QY.z);
        const fx = cx + QX.x * sy + QY.x * sz, fy = cy + QX.y * sy + QY.y * sz, fz = cz + QX.z * sy + QY.z * sz;
        out.line(fx - QZ.x, fy - QZ.y, fz - QZ.z, fx + QZ.x, fy + QZ.y, fz + QZ.z);
      }
    }
  }
}

/** Ring of radius r around (x, y, z) in plane 0 = XY, 1 = XZ, 2 = YZ. */
function ring(out: LineSet, x: number, y: number, z: number, r: number, plane: 0 | 1 | 2): void {
  for (let i = 0; i < RING_SEGMENTS; i++) {
    const a0 = (i / RING_SEGMENTS) * Math.PI * 2;
    const a1 = ((i + 1) / RING_SEGMENTS) * Math.PI * 2;
    const c0 = Math.cos(a0) * r, s0 = Math.sin(a0) * r, c1 = Math.cos(a1) * r, s1 = Math.sin(a1) * r;
    if (plane === 0) out.line(x + c0, y + s0, z, x + c1, y + s1, z);
    else if (plane === 1) out.line(x + c0, y, z + s0, x + c1, y, z + s1);
    else out.line(x, y + c0, z + s0, x, y + c1, z + s1);
  }
}

/** Rotates (vx, vy, vz) by the unit quaternion (qx, qy, qz, qw) into `out`. */
function rotate(qx: number, qy: number, qz: number, qw: number, vx: number, vy: number, vz: number, out: Vector3): void {
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  out.set(vx + qw * tx + (qy * tz - qz * ty), vy + qw * ty + (qz * tx - qx * tz), vz + qw * tz + (qx * ty - qy * tx));
}
