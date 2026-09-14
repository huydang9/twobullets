import { Color3, PointLight, Vector3, type Scene } from "@babylonjs/core";
import type { ViewmodelProfile } from "../viewmodel/weaponProfiles";
import { FxCell } from "./fxAtlas";
import type { FxBatch } from "./FxBatch";

const FLASH_SECONDS = 0.035;
const LIGHT_SECONDS = 0.07;
const LIGHT_RANGE = 9;

const CORE = Color3.FromHexString("#fff2b0");
const FLAME = Color3.FromHexString("#ffa53a");
const GLOW = Color3.FromHexString("#ff8a2a");

/**
 * Viewmodel-layer flash (star + flame tongues at the muzzle, drawn in the viewmodel rendering group so it sits on
 * the gun) plus a brief world PointLight. The light is created once and left enabled at zero intensity, so
 * flashing never changes shader defines.
 */
export class MuzzleFlash {
  private readonly light: PointLight;
  private remaining = 0;
  /** Guarantees at least one rendered frame even when a frame is longer than FLASH_SECONDS. */
  private shownFrames = 1;
  private lightRemaining = 0;
  private lightPeak = 0;
  private rotation = 0;
  private size = 0;
  private length = 0;
  private readonly tmp = new Vector3();
  private readonly tmp2 = new Vector3();

  constructor(
    scene: Scene,
    private readonly batch: FxBatch,
  ) {
    this.light = new PointLight("fx_muzzleLight", Vector3.Zero(), scene);
    this.light.diffuse = Color3.FromHexString("#ffb766");
    this.light.specular = new Color3(0.3, 0.2, 0.1);
    this.light.range = LIGHT_RANGE;
    this.light.intensity = 0;
  }

  trigger(profile: ViewmodelProfile): void {
    const flash = profile.muzzleFlash;
    this.remaining = FLASH_SECONDS;
    this.shownFrames = 0;
    this.rotation = Math.random() * Math.PI * 2;
    this.size = flash.size * (0.8 + Math.random() * 0.45);
    this.length = flash.length * (0.75 + Math.random() * 0.5);
    this.lightRemaining = LIGHT_SECONDS;
    this.lightPeak = flash.light;
  }

  /** `drawViewmodelFlash` is false while the viewmodel is hidden (scoped); the world light still flashes. */
  update(dt: number, muzzle: Vector3, forward: Vector3, drawViewmodelFlash: boolean): void {
    if (this.lightRemaining > 0) {
      const t = this.lightRemaining / LIGHT_SECONDS;
      this.light.intensity = this.lightPeak * t * t;
      this.light.position.set(muzzle.x + forward.x * 0.4, muzzle.y + forward.y * 0.4, muzzle.z + forward.z * 0.4);
      this.lightRemaining -= dt;
    } else if (this.light.intensity !== 0) {
      this.light.intensity = 0;
    }

    if (this.remaining <= 0 && this.shownFrames > 0) return;
    this.remaining -= dt;
    this.shownFrames++;
    if (!drawViewmodelFlash) return;

    const size = this.size;
    this.tmp.set(muzzle.x + forward.x * size * 0.3, muzzle.y + forward.y * size * 0.3, muzzle.z + forward.z * size * 0.3);
    this.batch.sprite(this.tmp, size * 1.7, 0, FxCell.glow, GLOW, 0.4);
    this.batch.sprite(this.tmp, size, this.rotation, FxCell.star, CORE, 1, 1.4);
    // Flame tongue along the barrel: a camera-facing ribbon, widest at the muzzle.
    this.tmp2.set(muzzle.x + forward.x * this.length, muzzle.y + forward.y * this.length, muzzle.z + forward.z * this.length);
    this.batch.streak(muzzle, this.tmp2, size * 0.7, FxCell.flame, FLAME, 1, 1, 0.9);
  }

  dispose(): void {
    this.light.dispose();
  }
}
