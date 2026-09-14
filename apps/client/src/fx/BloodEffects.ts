import {
  Color3,
  Matrix,
  PhysicsRaycastResult,
  Vector3,
  type HavokPlugin,
  type IRaycastQuery,
  type PhysicsBody,
  type Scene,
  type TransformNode,
} from "@babylonjs/core";
import type { HitZone } from "@twobullets/shared";
import { CollisionLayer } from "../combat/hitboxes";
import { BloodCell } from "./bloodAtlas";
import { bloodSettings } from "./bloodSettings";
import type { FxBatch, FxDecal } from "./FxBatch";
import { ParticlePool } from "./ParticlePool";

/** A character that bleeds: practice soldiers now, remote players later. */
export interface BloodBody {
  /** Changes on every respawn; wounds and pools from an earlier life are removed. */
  readonly life: number;
  /** Bone closest to a world-space hit in `zone`. Its world matrix must follow the rendered pose, dead or alive. */
  woundBone(point: Vector3, zone: HitZone): TransformNode | null;
  /** Node the death pool gathers under. */
  readonly pelvis: TransformNode;
}

/** Ray against static world geometry (terrain, buildings, level blocks); characters and triggers are ignored. */
export interface BloodWorldQuery {
  cast(from: Vector3, to: Vector3, hitPoint: Vector3, hitNormal: Vector3): boolean;
}

export const BLOOD_MIST_CAPACITY = 96;
export const BLOOD_DROPLET_CAPACITY = 192;
export const BLOOD_DECAL_CAPACITY = 48;
export const BLOOD_POOL_CAPACITY = 12;
export const BLOOD_WOUND_CAPACITY = 64;
/** Instances each blood batch needs with every pool at capacity. */
export const BLOOD_DECAL_BATCH_CAPACITY = BLOOD_DECAL_CAPACITY + BLOOD_POOL_CAPACITY + BLOOD_WOUND_CAPACITY;
export const BLOOD_PARTICLE_BATCH_CAPACITY = BLOOD_MIST_CAPACITY + BLOOD_DROPLET_CAPACITY;

const MAX_PENDING_HITS = 8;
const WOUNDS_PER_BODY = 6;
/** Wounds attached per target per frame, so one shotgun blast doesn't use up the body's wounds. */
const WOUNDS_PER_MERGED_HIT = 2;

/** How far behind a hit blood can reach a surface, m. */
const EXIT_REACH = 2.5;
const EXIT_REACH_HEAVY = 3.2;
const GROUND_REACH = 3;
/** Rough spray speed, m/s, for delaying splatter until the drops could have landed. */
const SPRAY_SPEED = 14;
const DECAL_LIFE = 26;
const DECAL_FADE = 6;
const DECAL_FADE_IN = 0.06;
const SURFACE_OFFSET = 0.006;
/** Wounds sit this far inside the hitbox surface along the bullet, closer to the skinned mesh under the hitbox. */
const WOUND_INSET = 0.02;
const WOUND_GROW = 0.15;

const POOL_DELAY = 0.6;
const POOL_GROW = 2.2;
const POOL_MIN = 0.08;
const POOL_MAX = 0.55;
const POOL_RELEASE = 0.5;
/** A pool whose body never respawns (e.g. a player who left) still goes eventually. */
const POOL_MAX_LIFE = 90;

/** Display-space colors; the FX shader is unlit and writes after tone mapping, like the PBR output. */
const MIST = Color3.FromHexString("#7e1712");
const DROPLET = Color3.FromHexString("#620c09");
const SPLATTER = Color3.FromHexString("#520a07");
const POOL = Color3.FromHexString("#420706");
/** Brighter than the splatter so it reads on the dark uniform. */
const WOUND = Color3.FromHexString("#7a110c");
/** Brightness in full shadow; sunlit is 1. */
const SHADE = 0.45;
const SUN_PROBE_REACH = 60;

/** Head hits are the biggest; body hits (the common case) must still read clearly; limbs are smaller but visible. */
const ZONE_SIZE: Readonly<Record<HitZone, number>> = { head: 1.35, body: 1.1, limb: 0.85 };
const ZONE_DENSITY: Readonly<Record<HitZone, number>> = { head: 1.6, body: 1.2, limb: 0.8 };
const ZONE_WOUND: Readonly<Record<HitZone, number>> = { head: 0.045, body: 0.06, limb: 0.045 };
const ZONE_RANK: Readonly<Record<HitZone, number>> = { limb: 0, body: 1, head: 2 };

class PendingHit {
  targetId = "";
  body: BloodBody | null = null;
  readonly point = new Vector3();
  readonly direction = new Vector3();
  zone: HitZone = "body";
  count = 0;
  wounds = 0;
  killed = false;
  heavy = false;
}

class Decal implements FxDecal {
  readonly position = new Vector3();
  readonly normal = new Vector3(0, 1, 0);
  readonly color = new Color3();
  halfSize = 0.1;
  rotation = 0;
  cell: number = BloodCell.spatter;
  /** Alpha drawn this frame (`opacity` faded by age). */
  alpha = 0;
  opacity = 1;
  born = -Infinity;
}

class Pool implements FxDecal {
  body: BloodBody | null = null;
  life = 0;
  start = 0;
  releaseAt = Infinity;
  placed = false;
  scale = 1;
  readonly position = new Vector3();
  readonly normal = new Vector3(0, 1, 0);
  readonly color = new Color3();
  halfSize = 0;
  rotation = 0;
  readonly cell = BloodCell.pool;
  alpha = 0;
}

class Wound {
  body: BloodBody | null = null;
  bone: TransformNode | null = null;
  life = 0;
  readonly local = new Vector3();
  readonly localNormal = new Vector3();
  halfSize = 0.05;
  rotation = 0;
  born = 0;
}

/**
 * Realistic hit feedback on characters: a dark mist puff and droplets sprayed along the bullet's exit direction,
 * splatter decals on the world behind and below the target, wounds that follow the hit bone, and a pool under a
 * killed body. Hits on one target within a frame (shotgun pellets) merge into one bigger burst.
 *
 * Everything is preallocated: particles recycle the oldest, decals and wounds are ring buffers, and the per-frame
 * draw loops don't allocate. World rays (Havok) happen only when a hit is flushed (3 for a typical hit, at most 7 for a
 * kill), plus one or two when a death pool is placed.
 */
export class BloodEffects {
  private readonly mist: ParticlePool;
  private readonly droplets: ParticlePool;
  private readonly pending = Array.from({ length: MAX_PENDING_HITS }, () => new PendingHit());
  private pendingCount = 0;
  private readonly decals = Array.from({ length: BLOOD_DECAL_CAPACITY }, () => new Decal());
  private nextDecal = 0;
  private readonly pools = Array.from({ length: BLOOD_POOL_CAPACITY }, () => new Pool());
  private readonly wounds = Array.from({ length: BLOOD_WOUND_CAPACITY }, () => new Wound());
  private readonly woundDraw: FxDecal = { position: new Vector3(), normal: new Vector3(), halfSize: 0, rotation: 0, cell: BloodCell.wound, color: WOUND, alpha: 0.95 };
  private time = 0;

  // Parameters of the burst being spawned (fields rather than arguments keep doubles unboxed across calls).
  private size = 1;
  private density = 1;
  private light = 1;
  private intensity = 1;

  private readonly toSun = new Vector3();
  private readonly dir = new Vector3();
  private readonly jitter = new Vector3();
  private readonly from = new Vector3();
  private readonly to = new Vector3();
  private readonly hitPoint = new Vector3();
  private readonly hitNormal = new Vector3();
  private readonly probe = new Vector3();
  private readonly probeNormal = new Vector3();
  private readonly tangent = new Vector3();
  private readonly bitangent = new Vector3();
  private readonly inverse = new Matrix();

  constructor(
    particleBatch: FxBatch,
    private readonly decalBatch: FxBatch,
    private readonly world: BloodWorldQuery,
    /** Direction light travels from the sun. */
    sunDirection: Vector3,
  ) {
    this.mist = new ParticlePool(BLOOD_MIST_CAPACITY, particleBatch);
    this.droplets = new ParticlePool(BLOOD_DROPLET_CAPACITY, particleBatch);
    sunDirection.normalizeToRef(this.toSun).scaleInPlace(-1);
  }

  /**
   * Queues a bullet hit on a character; effects spawn on the next `update`. The wound attaches immediately, while the
   * bones still hold the pose the bullet was tested against. Returns true for the first hit on this target this
   * frame, so callers can play one flesh impact per merged hit.
   * @param normal Hitbox surface normal at `point`.
   * @param direction Unit bullet travel direction.
   */
  hit(targetId: string, body: BloodBody | null, point: Vector3, normal: Vector3, direction: Vector3, zone: HitZone, heavy = false): boolean {
    let hit: PendingHit | null = null;
    for (let i = 0; i < this.pendingCount; i++) {
      const candidate = this.pending[i] as PendingHit;
      if (candidate.targetId === targetId) {
        hit = candidate;
        break;
      }
    }
    const first = hit === null;
    if (!hit) {
      // Out of slots: fold into the last one rather than dropping the hit's blood entirely.
      hit = this.pending[Math.min(this.pendingCount, MAX_PENDING_HITS - 1)] as PendingHit;
      if (this.pendingCount < MAX_PENDING_HITS) {
        this.pendingCount++;
        hit.targetId = targetId;
        hit.body = body;
        hit.point.setAll(0);
        hit.direction.setAll(0);
        hit.zone = zone;
        hit.count = 0;
        hit.wounds = 0;
        hit.killed = false;
        hit.heavy = false;
      }
    }
    hit.point.addInPlace(point);
    hit.direction.addInPlace(direction);
    hit.count++;
    hit.heavy ||= heavy;
    if (ZONE_RANK[zone] > ZONE_RANK[hit.zone]) hit.zone = zone;

    if (body && bloodSettings.enabled && bloodSettings.wounds && hit.wounds < WOUNDS_PER_MERGED_HIT) {
      if (this.attachWound(body, point, normal, direction, zone)) hit.wounds++;
    }
    return first;
  }

  /** Marks the target's pending hit as the killing one: a bigger burst and a pool under the body. */
  kill(targetId: string): void {
    for (let i = 0; i < this.pendingCount; i++) {
      const hit = this.pending[i] as PendingHit;
      if (hit.targetId !== targetId) continue;
      hit.killed = true;
      if (hit.body && bloodSettings.enabled) this.startPool(hit.body);
      return;
    }
  }

  /** Per render frame, between the batches' begin() and end(). */
  update(dt: number): void {
    this.time += dt;
    for (let i = 0; i < this.pendingCount; i++) {
      const hit = this.pending[i] as PendingHit;
      if (bloodSettings.enabled) this.burst(hit);
      hit.body = null;
    }
    this.pendingCount = 0;

    this.mist.update(dt);
    this.droplets.update(dt);
    this.drawDecals();
    this.drawPools(dt);
    this.drawWounds();
  }

  clear(): void {
    this.pendingCount = 0;
    this.mist.clear();
    this.droplets.clear();
    for (const decal of this.decals) decal.born = -Infinity;
    for (const pool of this.pools) pool.body = null;
    for (const wound of this.wounds) wound.body = wound.bone = null;
  }

  /** Active / capacity per pool, for the DEV console. */
  stats(): Record<string, string> {
    const live = (d: Decal) => this.time - d.born < DECAL_LIFE;
    return {
      mist: `${this.mist.active}/${this.mist.capacity}`,
      droplets: `${this.droplets.active}/${this.droplets.capacity}`,
      decals: `${this.decals.filter(live).length}/${BLOOD_DECAL_CAPACITY}`,
      pools: `${this.pools.filter((p) => p.body).length}/${BLOOD_POOL_CAPACITY}`,
      wounds: `${this.wounds.filter((w) => w.body).length}/${BLOOD_WOUND_CAPACITY}`,
    };
  }

  // --- Spawning ------------------------------------------------------------------------------------------------------

  private burst(hit: PendingHit): void {
    this.intensity = Math.min(2, Math.max(0, bloodSettings.intensity));
    if (this.intensity <= 0) return;
    const point = hit.point.scaleInPlace(1 / hit.count);
    const dir = hit.direction;
    if (dir.lengthSquared() < 1e-8) dir.set(0, 0, 1);
    dir.normalize();

    const merged = Math.min(hit.count - 1, 8);
    const kill = hit.killed ? 1 : 0;
    this.size = ZONE_SIZE[hit.zone] * (1 + merged * 0.06) * (1 + kill * 0.3) * (0.75 + 0.25 * this.intensity);
    this.density = ZONE_DENSITY[hit.zone] * (1 + merged * 0.15) * (1 + kill * 0.8) * this.intensity;
    this.light = SHADE + (1 - SHADE) * this.sunVisibility(point);

    this.spawnMist(point, dir);
    this.spawnDroplets(point, dir);

    const heavy = hit.heavy || hit.zone === "head";
    const splatters = hit.killed || hit.count >= 4 ? 2 : 1;
    for (let i = 0; i < splatters; i++) this.splatterBehind(point, dir, heavy, i > 0);
    const drips = hit.killed ? 2 : 1;
    for (let i = 0; i < drips; i++) this.dripBelow(point, dir, i > 0);
  }

  private spawnMist(point: Vector3, dir: Vector3): void {
    const { size, light, intensity } = this;
    const opacity = Math.min(1, 0.6 + 0.4 * intensity);

    // Dense core right at the wound: what makes a hit read instantly, even at range or on a limb.
    const core = this.mist.spawn();
    core.position.set(point.x + dir.x * 0.03, point.y + dir.y * 0.03, point.z + dir.z * 0.03);
    core.velocity.set(dir.x * 0.4, dir.y * 0.4, dir.z * 0.4);
    core.life = 0.2;
    core.size0 = 0.06 * size;
    core.size1 = 0.17 * size;
    core.drag = 6;
    core.cell = BloodCell.mist;
    core.rotation = Math.random() * Math.PI * 2;
    MIST.scaleToRef(light * 0.8, core.color);
    core.alpha = 0.9 * opacity;
    core.fadePower = 1.8;

    const count = Math.min(8, Math.max(2, Math.round(2.5 * this.density)));
    for (let i = 0; i < count; i++) {
      const p = this.mist.spawn();
      randomUnit(this.jitter);
      const ahead = 0.03 + Math.random() * 0.1;
      p.position.set(
        point.x + dir.x * ahead + this.jitter.x * 0.03,
        point.y + dir.y * ahead + this.jitter.y * 0.03,
        point.z + dir.z * ahead + this.jitter.z * 0.03,
      );
      const speed = 0.7 + Math.random() * 1.6;
      p.velocity.set(dir.x * speed + this.jitter.x * 0.35, dir.y * speed + this.jitter.y * 0.35, dir.z * speed + this.jitter.z * 0.35);
      p.life = (0.45 + Math.random() * 0.35) * (0.8 + 0.2 * size);
      p.size0 = 0.05 * size;
      p.size1 = (0.2 + Math.random() * 0.12) * size;
      p.drag = 4.5;
      p.gravity = 0.5;
      p.cell = BloodCell.mist;
      p.rotation = Math.random() * Math.PI * 2;
      p.spin = (Math.random() - 0.5) * 1.2;
      MIST.scaleToRef(light * (0.85 + Math.random() * 0.15), p.color);
      p.alpha = 0.68 * opacity;
      p.fadePower = 1.5;
    }

    // Faint back-spatter toward the shooter.
    const back = this.mist.spawn();
    back.position.set(point.x - dir.x * 0.02, point.y - dir.y * 0.02, point.z - dir.z * 0.02);
    back.velocity.set(-dir.x * 0.5, -dir.y * 0.5, -dir.z * 0.5);
    back.life = 0.28;
    back.size0 = 0.03 * size;
    back.size1 = 0.11 * size;
    back.drag = 5;
    back.cell = BloodCell.mist;
    back.rotation = Math.random() * Math.PI * 2;
    MIST.scaleToRef(light, back.color);
    back.alpha = 0.42 * opacity;
    back.fadePower = 1.2;
  }

  private spawnDroplets(point: Vector3, dir: Vector3): void {
    const count = Math.min(26, Math.round(7 * this.density));
    const width = 0.011 * Math.sqrt(this.size);
    for (let i = 0; i < count; i++) {
      const p = this.droplets.spawn();
      p.position.copyFrom(point);
      randomUnit(this.jitter);
      // Most drops leave with the bullet; a few splash back out of the entry wound.
      const forward = Math.random() < 0.8;
      const sign = forward ? 1 : -1;
      const spread = forward ? 0.45 : 0.7;
      this.dir.set(dir.x * sign + this.jitter.x * spread, dir.y * sign + this.jitter.y * spread, dir.z * sign + this.jitter.z * spread).normalize();
      const speed = forward ? 2.5 + Math.random() * 4.5 : 1 + Math.random() * 1.5;
      p.velocity.copyFrom(this.dir).scaleInPlace(speed);
      p.life = 0.3 + Math.random() * 0.35;
      p.size0 = width * (0.7 + Math.random() * 0.6);
      p.size1 = width * 0.55;
      p.gravity = 9.8;
      p.drag = 1.2;
      p.cell = BloodCell.droplet;
      p.streakSeconds = 0.028;
      DROPLET.scaleToRef(this.light, p.color);
      p.alpha = 0.95;
      p.fadePower = 0.35;
    }
  }

  /** Splatter on whatever is right behind the target along the bullet's path. */
  private splatterBehind(point: Vector3, dir: Vector3, heavy: boolean, scattered: boolean): void {
    const reach = heavy ? EXIT_REACH_HEAVY : EXIT_REACH;
    const spread = scattered ? 0.22 : 0.06;
    randomUnit(this.jitter);
    this.dir.set(dir.x + this.jitter.x * spread, dir.y + this.jitter.y * spread, dir.z + this.jitter.z * spread).normalize();
    this.from.set(point.x + this.dir.x * 0.02, point.y + this.dir.y * 0.02, point.z + this.dir.z * 0.02);
    this.to.set(point.x + this.dir.x * reach, point.y + this.dir.y * reach, point.z + this.dir.z * reach);
    if (!this.world.cast(this.from, this.to, this.hitPoint, this.hitNormal)) return;

    const distance = Vector3.Distance(point, this.hitPoint);
    const far = distance / reach;
    const decal = this.nextDecalSlot();
    offsetAlong(decal.position, this.hitPoint, this.hitNormal, SURFACE_OFFSET);
    decal.normal.copyFrom(this.hitNormal);
    // Spray spreads out and thins with distance.
    decal.halfSize = (0.16 + Math.random() * 0.12) * this.size * (0.8 + 0.6 * far);
    decal.opacity = 0.92 * Math.min(1, 0.55 + 0.45 * this.intensity) * (1 - 0.35 * far);
    decal.born = this.time + distance / SPRAY_SPEED;
    const grazing = -Vector3.Dot(this.dir, this.hitNormal) < 0.55;
    if (grazing || Math.random() < 0.3) {
      decal.cell = BloodCell.spray;
      decal.rotation = this.rotationAlong(this.hitNormal, this.dir);
    } else {
      decal.cell = Math.random() < 0.6 ? BloodCell.spatter : BloodCell.cluster;
      decal.rotation = Math.random() * Math.PI * 2;
    }
    SPLATTER.scaleToRef(this.surfaceLight(decal.position, this.hitNormal), decal.color);
  }

  /** A drop landing on the ground under the hit, slightly ahead along the bullet. */
  private dripBelow(point: Vector3, dir: Vector3, large: boolean): void {
    const horizontal = Math.hypot(dir.x, dir.z);
    const ahead = 0.1 + Math.random() * 0.45;
    const kx = horizontal > 1e-4 ? (dir.x / horizontal) * ahead : 0;
    const kz = horizontal > 1e-4 ? (dir.z / horizontal) * ahead : 0;
    this.from.set(point.x + kx + (Math.random() - 0.5) * 0.2, point.y, point.z + kz + (Math.random() - 0.5) * 0.2);
    this.to.set(this.from.x, point.y - GROUND_REACH, this.from.z);
    if (!this.world.cast(this.from, this.to, this.hitPoint, this.hitNormal)) return;

    const decal = this.nextDecalSlot();
    offsetAlong(decal.position, this.hitPoint, this.hitNormal, SURFACE_OFFSET);
    decal.normal.copyFrom(this.hitNormal);
    decal.halfSize = (0.06 + Math.random() * 0.05) * this.size * (large ? 1.4 : 1);
    decal.rotation = Math.random() * Math.PI * 2;
    decal.cell = Math.random() < 0.7 ? BloodCell.splat : BloodCell.cluster;
    decal.opacity = 0.9 * Math.min(1, 0.55 + 0.45 * this.intensity);
    // Free-fall time from the hit height.
    decal.born = this.time + Math.sqrt((2 * Math.max(0, point.y - this.hitPoint.y)) / 9.81);
    SPLATTER.scaleToRef(this.light, decal.color);
  }

  private startPool(body: BloodBody): void {
    let slot: Pool | null = null;
    for (const pool of this.pools) {
      if (pool.body === body && pool.life === body.life) return;
      if (!slot || (slot.body && (!pool.body || pool.start < slot.start))) slot = pool;
    }
    if (!slot) return;
    slot.body = body;
    slot.life = body.life;
    slot.start = this.time + POOL_DELAY;
    slot.releaseAt = Infinity;
    slot.placed = false;
    slot.rotation = Math.random() * Math.PI * 2;
    slot.scale = 0.85 + Math.random() * 0.3;
  }

  private attachWound(body: BloodBody, point: Vector3, normal: Vector3, direction: Vector3, zone: HitZone): boolean {
    const bone = body.woundBone(point, zone);
    if (!bone) return false;

    // This body's oldest wound once it has its share, otherwise a free (or the globally oldest) slot.
    let own = 0;
    let ownOldest: Wound | null = null;
    let free: Wound | null = null;
    for (const wound of this.wounds) {
      if (wound.body === body && wound.life === body.life) {
        own++;
        if (!ownOldest || wound.born < ownOldest.born) ownOldest = wound;
      } else if (!free || (free.body && (!wound.body || wound.born < free.born))) {
        free = wound;
      }
    }
    const wound = own >= WOUNDS_PER_BODY ? ownOldest : free;
    if (!wound) return false;

    // Stored in bone space so the wound rides the animation, the death fall included.
    bone.getWorldMatrix().invertToRef(this.inverse);
    this.probe.set(point.x + direction.x * WOUND_INSET, point.y + direction.y * WOUND_INSET, point.z + direction.z * WOUND_INSET);
    Vector3.TransformCoordinatesToRef(this.probe, this.inverse, wound.local);
    Vector3.TransformNormalToRef(normal, this.inverse, wound.localNormal);
    wound.body = body;
    wound.bone = bone;
    wound.life = body.life;
    wound.halfSize = ZONE_WOUND[zone] * (0.85 + Math.random() * 0.3);
    wound.rotation = Math.random() * Math.PI * 2;
    wound.born = this.time;
    return true;
  }

  // --- Drawing -------------------------------------------------------------------------------------------------------

  private drawDecals(): void {
    for (let i = 0; i < BLOOD_DECAL_CAPACITY; i++) {
      const decal = this.decals[i] as Decal;
      const age = this.time - decal.born;
      if (age < 0 || age >= DECAL_LIFE) continue;
      decal.alpha = decal.opacity * Math.min(1, age / DECAL_FADE_IN, (DECAL_LIFE - age) / DECAL_FADE);
      this.decalBatch.decalFrom(decal);
    }
  }

  private drawPools(dt: number): void {
    for (let i = 0; i < BLOOD_POOL_CAPACITY; i++) {
      const pool = this.pools[i] as Pool;
      const body = pool.body;
      if (!body) continue;
      if (pool.releaseAt === Infinity && (body.life !== pool.life || this.time - pool.start > POOL_MAX_LIFE)) pool.releaseAt = this.time;
      const fade = pool.releaseAt === Infinity ? 1 : 1 - (this.time - pool.releaseAt) / POOL_RELEASE;
      const age = this.time - pool.start;
      if (fade <= 0 || (!pool.placed && pool.releaseAt !== Infinity)) {
        pool.body = null;
        continue;
      }
      if (age < 0) continue;

      const pelvis = body.pelvis.getAbsolutePosition();
      const center = pool.position;
      if (!pool.placed) {
        this.from.set(pelvis.x, pelvis.y + 0.4, pelvis.z);
        this.to.set(pelvis.x, pelvis.y - 2, pelvis.z);
        if (!this.world.cast(this.from, this.to, this.hitPoint, this.hitNormal) || this.hitNormal.y < 0.5) {
          pool.body = null;
          continue;
        }
        offsetAlong(center, this.hitPoint, this.hitNormal, SURFACE_OFFSET);
        pool.normal.copyFrom(this.hitNormal);
        POOL.scaleToRef(this.surfaceLight(center, pool.normal), pool.color);
        pool.placed = true;
      } else if (age < POOL_GROW) {
        // Drift with the settling body, staying on the ground plane found at placement.
        const n = pool.normal;
        const k = 1 - Math.exp(-4 * dt);
        const x = center.x + (pelvis.x - center.x) * k;
        const z = center.z + (pelvis.z - center.z) * k;
        center.y -= (n.x * (x - center.x) + n.z * (z - center.z)) / n.y;
        center.x = x;
        center.z = z;
      }
      const t = Math.min(1, age / POOL_GROW);
      const grown = 1 - (1 - t) * (1 - t);
      pool.halfSize = (POOL_MIN + (POOL_MAX - POOL_MIN) * grown) * pool.scale * (0.8 + 0.2 * Math.min(2, bloodSettings.intensity));
      pool.alpha = 0.94 * fade * Math.min(1, age / 0.2);
      this.decalBatch.decalFrom(pool);
    }
  }

  private drawWounds(): void {
    const show = bloodSettings.enabled && bloodSettings.wounds;
    const draw = this.woundDraw;
    for (let i = 0; i < BLOOD_WOUND_CAPACITY; i++) {
      const wound = this.wounds[i] as Wound;
      const body = wound.body;
      if (!body || !wound.bone) continue;
      if (body.life !== wound.life) {
        wound.body = wound.bone = null;
        continue;
      }
      if (!show) continue;
      const matrix = wound.bone.getWorldMatrix();
      Vector3.TransformCoordinatesToRef(wound.local, matrix, draw.position);
      Vector3.TransformNormalToRef(wound.localNormal, matrix, draw.normal);
      draw.normal.normalize();
      draw.halfSize = wound.halfSize * (0.6 + 0.4 * Math.min(1, (this.time - wound.born) / WOUND_GROW));
      draw.rotation = wound.rotation;
      this.decalBatch.decalFrom(draw);
    }
  }

  // --- Helpers -------------------------------------------------------------------------------------------------------

  private nextDecalSlot(): Decal {
    const decal = this.decals[this.nextDecal] as Decal;
    this.nextDecal = (this.nextDecal + 1) % BLOOD_DECAL_CAPACITY;
    return decal;
  }

  /** 1 when the sun reaches `point`, 0 in shadow (one ray). */
  private sunVisibility(point: Vector3): number {
    const s = this.toSun;
    this.from.set(point.x + s.x * 0.3, point.y + s.y * 0.3, point.z + s.z * 0.3);
    this.to.set(point.x + s.x * SUN_PROBE_REACH, point.y + s.y * SUN_PROBE_REACH, point.z + s.z * SUN_PROBE_REACH);
    return this.world.cast(this.from, this.to, this.probe, this.probeNormal) ? 0 : 1;
  }

  /** Brightness of a surface decal: shadow floor plus a Lambert term when the sun reaches it. */
  private surfaceLight(position: Vector3, normal: Vector3): number {
    const facing = Vector3.Dot(normal, this.toSun);
    if (facing <= 0) return SHADE;
    offsetAlong(this.probe, position, normal, 0.03);
    const visible = this.sunVisibility(this.probe);
    return SHADE + (1 - SHADE) * visible * Math.min(1, facing * 1.3);
  }

  /** Decal rotation that lines the atlas U axis up with `direction` projected onto the surface (FxBatch's basis). */
  private rotationAlong(normal: Vector3, direction: Vector3): number {
    const ref = Math.abs(normal.y) < 0.95 ? Vector3.UpReadOnly : Vector3.RightReadOnly;
    Vector3.CrossToRef(ref, normal, this.tangent);
    this.tangent.normalize();
    Vector3.CrossToRef(normal, this.tangent, this.bitangent);
    return Math.atan2(Vector3.Dot(direction, this.bitangent), Vector3.Dot(direction, this.tangent));
  }
}

/** Havok-backed BloodWorldQuery: skips hitbox triggers, player blockers and the given body (the local player). */
export class HavokBloodWorld implements BloodWorldQuery {
  private readonly plugin: HavokPlugin | null;
  private readonly result = new PhysicsRaycastResult();
  private readonly query: IRaycastQuery = { shouldHitTriggers: false, collideWith: ~(CollisionLayer.hitbox | CollisionLayer.blocker) };
  /** Rays cast so far, for tests and the DEV console. */
  rays = 0;

  constructor(scene: Scene, ignoreBody?: PhysicsBody) {
    const plugin = scene.getPhysicsEngine()?.getPhysicsPlugin();
    this.plugin = plugin && "raycast" in plugin ? (plugin as HavokPlugin) : null;
    this.query.ignoreBody = ignoreBody;
  }

  cast(from: Vector3, to: Vector3, hitPoint: Vector3, hitNormal: Vector3): boolean {
    if (!this.plugin) return false;
    this.rays++;
    const result = this.result;
    this.plugin.raycast(from, to, result, this.query);
    if (!result.hasHit) return false;
    hitPoint.copyFrom(result.hitPointWorld);
    hitNormal.copyFrom(result.hitNormalWorld).normalize();
    return true;
  }
}

function offsetAlong(result: Vector3, point: Vector3, normal: Vector3, distance: number): void {
  result.set(point.x + normal.x * distance, point.y + normal.y * distance, point.z + normal.z * distance);
}

/** Uniform random unit vector. */
function randomUnit(result: Vector3): Vector3 {
  const z = Math.random() * 2 - 1;
  const a = Math.random() * Math.PI * 2;
  const r = Math.sqrt(1 - z * z);
  return result.set(r * Math.cos(a), r * Math.sin(a), z);
}
