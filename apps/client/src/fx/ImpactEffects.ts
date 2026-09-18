import { Color3, Vector3 } from "@babylonjs/core";
import { FxCell } from "./fxAtlas";
import type { FxBatch } from "./FxBatch";
import type { ParticlePool } from "./ParticlePool";

const DECAL_CAPACITY = 96;
const DECAL_LIFE = 7;
const DECAL_FADE = 1.5;
const DECAL_SURFACE_OFFSET = 0.004;
/**
 * A hole punched clean through a pane is damage to the map, not a scuff: it outlasts the scorch on a concrete wall. The
 * ring is still the ring, so a long firefight against one mirror eventually overwrites its own earliest holes.
 */
const PIERCE_LIFE = 45;
const PIERCE_FADE = 3;
/** Half sizes, m: the rim of shattered glass and the dark bore through it. The pane is 4 m across. */
const PIERCE_RIM = 0.045;
const PIERCE_BORE = 0.017;
/** The ring decal's own shape peaks at 0.8 of its half size, so a ring drawn round a real hole is scaled up to sit on its rim. */
const RING_SCALE = 1.3;

const SPARK = Color3.FromHexString("#ffb347");
const SPARK_HOT = Color3.FromHexString("#ffe08a");
const DUST = Color3.FromHexString("#e6dcc6");
const HOLE = Color3.FromHexString("#1b1c22");
/** A pane that stopped a round: amber, gone in a blink. The only colour these walls ever show. */
const PANE_AMBER = Color3.FromHexString("#ff8a1e");
const PANE_FLASH_LIFE = 0.18;
const PANE_RING_LIFE = 0.28;
/** Half size the ring reaches, m: it reads at a glance from across a corridor without lighting the whole 4 m pane. */
const PANE_RING_SIZE = 0.34;
/** Crazed glass round the bore: pale and bright, the way a star crack catches the light. */
const PIERCE_CRACKS = Color3.FromHexString("#d7e4ee");
/** The bore itself: near black, so the hole reads as a hole and not as a smudge. */
const PIERCE_HOLE = Color3.FromHexString("#0a0c10");

class Decal {
  readonly position = new Vector3();
  readonly normal = new Vector3(0, 1, 0);
  size = 0.05;
  rotation = 0;
  born = -Infinity;
  /** A bullet hole through glass (two quads: cracked rim, then the bore on top) rather than a mark on a surface. */
  pierced = false;
  /** Width of the real hole the pane cut in itself, m; 0 when the glass is still there and the bore has to be drawn. */
  aperture = 0;
}

/** World impact sparks, dust and bullet holes. Character hits are BloodEffects. */
export class ImpactEffects {
  private readonly decals = Array.from({ length: DECAL_CAPACITY }, () => new Decal());
  private nextDecal = 0;
  private time = 0;
  private readonly dir = new Vector3();
  private readonly tangent = new Vector3();
  private readonly bitangent = new Vector3();

  constructor(
    private readonly additive: ParticlePool,
    private readonly dust: ParticlePool,
    private readonly decalBatch: FxBatch,
  ) {}

  world(point: Vector3, normal: Vector3, heavy: boolean): void {
    const scale = heavy ? 1.5 : 1;

    const flash = this.additive.spawn();
    offsetAlong(flash.position, point, normal, 0.02);
    flash.life = 0.07;
    flash.size0 = 0.09 * scale;
    flash.size1 = 0.14 * scale;
    flash.cell = FxCell.star;
    flash.rotation = Math.random() * Math.PI;
    flash.color.copyFrom(SPARK_HOT);
    flash.hot = 1.2;

    const sparks = Math.round((5 + Math.random() * 4) * scale);
    for (let i = 0; i < sparks; i++) {
      const p = this.additive.spawn();
      p.position.copyFrom(point);
      this.randomHemisphere(normal, 0.9, this.dir);
      p.velocity.copyFrom(this.dir).scaleInPlace(3 + Math.random() * 6);
      p.life = 0.18 + Math.random() * 0.22;
      p.size0 = 0.012;
      p.size1 = 0.006;
      p.gravity = 14;
      p.drag = 2.5;
      p.cell = FxCell.streak;
      p.streakSeconds = 0.035;
      p.color.copyFrom(SPARK);
      p.hot = 1;
      p.fadePower = 0.6;
    }

    const puffs = heavy ? 3 : 2;
    for (let i = 0; i < puffs; i++) {
      const p = this.dust.spawn();
      this.randomHemisphere(normal, 0.5, this.dir);
      offsetAlong(p.position, point, normal, 0.03);
      p.velocity.copyFrom(this.dir).scaleInPlace(0.6 + Math.random() * 0.8);
      p.life = 0.5 + Math.random() * 0.35;
      p.size0 = 0.05 * scale;
      p.size1 = (0.22 + Math.random() * 0.1) * scale;
      p.drag = 4;
      p.gravity = -0.25;
      p.cell = FxCell.puff;
      p.rotation = Math.random() * Math.PI * 2;
      p.spin = (Math.random() - 0.5) * 1.5;
      p.color.copyFrom(DUST);
      p.alpha = 0.55;
      p.fadePower = 1.4;
    }

    const decal = this.take();
    offsetAlong(decal.position, point, normal, DECAL_SURFACE_OFFSET);
    decal.normal.copyFrom(normal);
    decal.size = (0.035 + Math.random() * 0.012) * scale;
    decal.rotation = Math.random() * Math.PI * 2;
    decal.pierced = false;
    decal.born = this.time;
  }

  /**
   * A bullet went straight through a pane (`combat/penetration.ts`): a hole on the face it crossed, and nothing else.
   * No sparks, no dust, no sound — the round never slowed down, and the sparks of a bullet biting into a wall would say
   * it did.
   *
   * `aperture` is the width, in m, of a real see-through hole the pane cut in itself (mirrors do; `MirrorWalls.punch`).
   * Then this only draws the crazing round its rim, because the middle is gone. Zero means the pane is still whole
   * where the round crossed it — a window you could already see through — and the hole is drawn: dark bore, pale rim.
   */
  pierce(point: Vector3, normal: Vector3, aperture = 0): void {
    const decal = this.take();
    offsetAlong(decal.position, point, normal, DECAL_SURFACE_OFFSET);
    decal.normal.copyFrom(normal);
    decal.size = 1 + Math.random() * 0.25;
    decal.rotation = Math.random() * Math.PI * 2;
    decal.pierced = true;
    decal.aperture = aperture;
    decal.born = this.time;
  }

  /**
   * A round stopped dead in a transparent pane. The panes give nothing away until this happens — you fire at one to
   * find out whether it is armoured right now — so this is the answer: a short amber flare on the glass where it
   * struck, and a ring of the same colour spreading off it. At the impact point, not over the pane: a 4 m wall lighting
   * up would tell everyone in the corridor as much as it tells the shooter.
   */
  paneStop(point: Vector3, normal: Vector3): void {
    const flare = this.additive.spawn();
    offsetAlong(flare.position, point, normal, 0.02);
    flare.life = PANE_FLASH_LIFE;
    flare.size0 = 0.1;
    flare.size1 = 0.3;
    flare.cell = FxCell.glow;
    flare.rotation = Math.random() * Math.PI;
    flare.color.copyFrom(PANE_AMBER);
    flare.hot = 0.9;
    flare.fadePower = 1.6;

    const ripple = this.additive.spawn();
    offsetAlong(ripple.position, point, normal, 0.025);
    ripple.life = PANE_RING_LIFE;
    ripple.size0 = 0.06;
    ripple.size1 = PANE_RING_SIZE;
    ripple.cell = FxCell.ring;
    ripple.rotation = Math.random() * Math.PI;
    ripple.color.copyFrom(PANE_AMBER);
    ripple.alpha = 0.85;
    ripple.fadePower = 1.2;
  }

  update(dt: number): void {
    this.time += dt;
    for (const decal of this.decals) {
      const age = this.time - decal.born;
      if (decal.pierced) {
        if (age >= PIERCE_LIFE) continue;
        const alpha = Math.min(1, (PIERCE_LIFE - age) / PIERCE_FADE);
        if (decal.aperture > 0) {
          // The hole is real and the middle of it is gone: only the crazed ring round its edge is drawn.
          this.decalBatch.decal(decal.position, decal.normal, (decal.aperture / 2) * RING_SCALE * decal.size, decal.rotation, FxCell.ring, PIERCE_CRACKS, alpha * 0.5);
          continue;
        }
        // Rim first, bore second: within one batch the later quad draws over the earlier one.
        this.decalBatch.decal(decal.position, decal.normal, PIERCE_RIM * decal.size, decal.rotation, FxCell.hole, PIERCE_CRACKS, alpha * 0.55);
        this.decalBatch.decal(decal.position, decal.normal, PIERCE_BORE * decal.size, decal.rotation, FxCell.spark, PIERCE_HOLE, alpha * 0.95);
        continue;
      }
      if (age >= DECAL_LIFE) continue;
      const alpha = Math.min(1, (DECAL_LIFE - age) / DECAL_FADE) * 0.9;
      this.decalBatch.decal(decal.position, decal.normal, decal.size, decal.rotation, FxCell.hole, HOLE, alpha);
    }
  }

  private take(): Decal {
    const decal = this.decals[this.nextDecal] as Decal;
    this.nextDecal = (this.nextDecal + 1) % DECAL_CAPACITY;
    return decal;
  }

  clear(): void {
    for (const decal of this.decals) decal.born = -Infinity;
  }

  private buildBasis(normal: Vector3): void {
    const ref = Math.abs(normal.y) < 0.95 ? Vector3.UpReadOnly : Vector3.RightReadOnly;
    Vector3.CrossToRef(ref, normal, this.tangent);
    this.tangent.normalize();
    Vector3.CrossToRef(normal, this.tangent, this.bitangent);
  }

  /** Random unit vector around `normal`, spread 0 (along the normal) .. ~1.5 (nearly flat). */
  private randomHemisphere(normal: Vector3, spread: number, result: Vector3): Vector3 {
    this.buildBasis(normal);
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.random() * spread;
    result.copyFrom(normal);
    result.addInPlaceFromFloats(
      (this.tangent.x * Math.cos(angle) + this.bitangent.x * Math.sin(angle)) * radius,
      (this.tangent.y * Math.cos(angle) + this.bitangent.y * Math.sin(angle)) * radius,
      (this.tangent.z * Math.cos(angle) + this.bitangent.z * Math.sin(angle)) * radius,
    );
    return result.normalize();
  }
}

function offsetAlong(result: Vector3, point: Vector3, normal: Vector3, distance: number): void {
  result.set(point.x + normal.x * distance, point.y + normal.y * distance, point.z + normal.z * distance);
}
