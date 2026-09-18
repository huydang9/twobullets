import { PhysicsRaycastResult, Vector3, type HavokPlugin, type IRaycastQuery, type Scene } from "@babylonjs/core";
import { getMapProp, MAP_PROPS, type Vec3 } from "@twobullets/shared";
import { GLASS_PANEL, MIRROR_PANEL } from "../world/props/standInMeshes";
import { CollisionLayer } from "./hitboxes";

/**
 * Bullet holes in the panes a bullet goes straight through.
 *
 * `BULLET_COLLIDE_MASK` deliberately excludes `CollisionLayer.blocker`, which is where a prop with
 * `collision.bulletproof === false` lives — so a shoot-through pane (`wall_glass`, and since 2026-09-18 `wall_mirror`)
 * is invisible to the bullet ray: no hit, no impact event, nothing to hang an effect on. This walks the same segment a
 * second time against the blocker layer alone and reports each pane the bullet crossed, purely so the client can mark
 * it. Nothing here touches gameplay: the shot is resolved before this runs, and this is not bullet penetration — the
 * bullet never stopped in the pane in the first place.
 *
 * Cost: one extra ray per projectile per tick, plus one more per pane actually crossed (capped). Blocker-layer geometry
 * is a few dozen shapes on the whole map, so the clear case — no pane anywhere along the segment — is a single miss.
 */

/**
 * Props worth a hole, and where their visible face sits: distance from the panel's centre plane to the surface a player
 * actually looks at, m at scale 1 (from the stand-in geometry, so the two cannot drift apart). The collider is the full
 * 0.3 m wall box either way, so a hole left on the collider face would float a finger's width off the glass; these put
 * it on the glass. Chainlink and picket fences are shoot-through too and are not panes: they get nothing.
 */
const PANE_FACE: Readonly<Record<string, number>> = { wall_glass: GLASS_PANEL.paneOffset, wall_mirror: MIRROR_PANEL.faceOffset };

/** `world/props/PropColliders.ts` names each collider group mesh `propCollider_<prop>_<scale>`. */
const COLLIDER_PREFIX = "propCollider_";

/** Static world only, the way a bullet sees it: what a round that stopped somewhere actually stopped in. */
const WORLD_QUERY: IRaycastQuery = { shouldHitTriggers: false, collideWith: ~(CollisionLayer.hitbox | CollisionLayer.blocker | CollisionLayer.player) };

/** Panes a bullet may cross in one tick's segment before we stop looking. Three is a corridor and two side walls. */
const MAX_CROSSINGS = 3;

/** Past a hit, the next ray starts this far along so it doesn't re-hit the face it just found, m. */
const STEP_PAST = 0.02;

/**
 * Below this |cos| between the bullet and the pane normal the shot is a graze: the exit is somewhere along the pane's
 * edge rather than on the far face, so only the entry hole is marked.
 */
const MIN_INCIDENCE = 0.35;

/** One face a bullet punched through. The vectors are reused — copy anything you keep. */
export interface PenetrationHit {
  readonly point: Vector3;
  /** Unit surface normal, pointing out of the pane on the side the hole is on. */
  readonly normal: Vector3;
  readonly prop: string;
}

export type PenetrationSink = (hit: PenetrationHit) => void;

export class PenetrationProbe {
  private readonly plugin: HavokPlugin | null;
  private readonly result = new PhysicsRaycastResult();
  private readonly query: IRaycastQuery = { shouldHitTriggers: false, collideWith: CollisionLayer.blocker };
  private readonly from = new Vector3();
  private readonly to = new Vector3();
  private readonly hit: { point: Vector3; normal: Vector3; prop: string } = { point: new Vector3(), normal: new Vector3(), prop: "" };
  /** Collider mesh name → pane, or null for anything that is not one. Grows to a handful of entries, then never again. */
  private readonly panes = new Map<string, Pane | null>();

  constructor(scene: Scene) {
    const plugin = scene.getPhysicsEngine()?.getPhysicsPlugin();
    this.plugin = plugin && "raycast" in plugin ? (plugin as HavokPlugin) : null;
  }

  /**
   * Walks the segment the bullet actually flew this tick (it ends at the impact point, so panes behind whatever stopped
   * the round are never marked) and calls `sink` for every pane face crossed: the entry face, then the exit face when
   * the shot went through squarely enough to know where it left.
   */
  scan(from: Vec3, to: Vec3, sink: PenetrationSink): void {
    if (!this.plugin) return;
    let dx = to.x - from.x;
    let dy = to.y - from.y;
    let dz = to.z - from.z;
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (length < 1e-4) return;
    dx /= length;
    dy /= length;
    dz /= length;

    const end = this.to.set(to.x, to.y, to.z);
    const start = this.from.set(from.x, from.y, from.z);
    const hit = this.hit;
    for (let i = 0; i < MAX_CROSSINGS; i++) {
      this.plugin.raycast(start, end, this.result, this.query);
      if (!this.result.hasHit) return;
      const p = this.result.hitPointWorld;
      const n = this.result.hitNormalWorld;
      const px = p.x;
      const py = p.y;
      const pz = p.z;
      const pane = this.paneOf(this.result.body?.transformNode?.name ?? "");
      if (pane) {
        hit.prop = pane.prop;
        hit.normal.copyFrom(n);
        // Square enough to know where the round left the glass? Then walk the ray onto the near face and out of the far
        // one, which is the whole of the geometry needed: no second query, and a graze marks only where it went in.
        const incidence = -(dx * n.x + dy * n.y + dz * n.z);
        const square = incidence >= MIN_INCIDENCE && Math.abs(n.y) < 0.5;
        const enter = square ? (pane.halfDepth - pane.face) / incidence : 0;
        const ex = px + dx * enter;
        const ey = py + dy * enter;
        const ez = pz + dz * enter;
        hit.point.set(ex, ey, ez);
        sink(hit);
        if (square) {
          const through = (2 * pane.face) / incidence;
          hit.point.set(ex + dx * through, ey + dy * through, ez + dz * through);
          hit.normal.set(-n.x, -n.y, -n.z);
          sink(hit);
        }
      }
      start.set(px + dx * STEP_PAST, py + dy * STEP_PAST, pz + dz * STEP_PAST);
      // Past the end of the segment: the bullet stopped before here.
      if ((end.x - start.x) * dx + (end.y - start.y) * dy + (end.z - start.z) * dz <= 0) return;
    }
  }

  /**
   * The pane a bullet stopped dead in, or null for anything else it could have hit.
   *
   * A glazed pane is on the world layer exactly while it is stopping bullets (`shared/map/glassPhase.ts`), so one short
   * ray across the impact point against that layer — the trick the audio probe uses for the owner's voice line — both
   * names the pane and proves it was armoured at that instant. No clock is consulted and none is needed: the impact
   * only exists because the round stopped there.
   */
  paneAtImpact(point: Vec3, normal: Vec3): Pane | null {
    if (!this.plugin) return null;
    const from = this.from.set(point.x + normal.x * 0.15, point.y + normal.y * 0.15, point.z + normal.z * 0.15);
    const to = this.to.set(point.x - normal.x * 0.25, point.y - normal.y * 0.25, point.z - normal.z * 0.25);
    this.plugin.raycast(from, to, this.result, WORLD_QUERY);
    if (!this.result.hasHit) return null;
    return this.paneOf(this.result.body?.transformNode?.name ?? "");
  }

  /** The pane a collider group belongs to, or null. Parsed once per collider mesh name. */
  private paneOf(node: string): Pane | null {
    const cached = this.panes.get(node);
    if (cached !== undefined) return cached;
    const pane = paneFromCollider(node);
    this.panes.set(node, pane);
    return pane;
  }
}

/** One pane collider group's geometry, at that group's scale. */
interface Pane {
  readonly prop: string;
  /** Half the collider box's depth (where a ray reports the hit), m. */
  readonly halfDepth: number;
  /** Where the glass a player sees sits, from the panel's centre plane, m. */
  readonly face: number;
}

/**
 * `propCollider_wall_mirror_1`, or `propCollider_wall_glass_1_p2` for a pane that switches mode (one collider group per
 * phase group) → that group's pane, or null when the node is not a pane collider.
 */
export function paneFromCollider(name: string): Pane | null {
  if (!name.startsWith(COLLIDER_PREFIX)) return null;
  const phased = /_p\d+$/.exec(name);
  const node = phased ? name.slice(0, name.length - phased[0].length) : name;
  const split = node.lastIndexOf("_");
  if (split <= COLLIDER_PREFIX.length) return null;
  const prop = node.slice(COLLIDER_PREFIX.length, split);
  const face = PANE_FACE[prop];
  if (face === undefined || !MAP_PROPS.has(prop)) return null;
  const scale = Number(node.slice(split + 1));
  const collision = getMapProp(prop).collision;
  if (collision.kind !== "box" || !Number.isFinite(scale) || scale <= 0) return null;
  return { prop, halfDepth: (collision.size[2] / 2) * scale, face: face * scale };
}
