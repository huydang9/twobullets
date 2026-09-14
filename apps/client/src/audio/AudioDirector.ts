import { Vector3, type Scene } from "@babylonjs/core";
import type { HitZone, Projectile, WeaponId } from "@twobullets/shared";
import type { CombatView } from "../combat/types";
import type { PlayerController } from "../player/PlayerController";
import type { TargetRange } from "../targets/TargetRange";
import type { ClipPlan } from "../viewmodel/clipPlans";
import { AmbienceSystem } from "./AmbienceSystem";
import { AudioDebug } from "./AudioDebug";
import { AudioEngine } from "./AudioEngine";
import { AudioSettings } from "./AudioSettings";
import { AudioWorldProbe } from "./AudioWorldProbe";
import { FootstepSystem, type FootstepEmitterSource } from "./FootstepSystem";
import { GameAudio } from "./GameAudio";
import { NearMissDetector } from "./NearMissDetector";
import { WEAPON_SOUNDS } from "./soundDesign";
import { SoundBank } from "./SoundBank";
import { WeaponAudio } from "./WeaponAudio";

/**
 * Audio composition root for the local player's view of the world: builds the engine, sound bank and world probe,
 * and drives listener, footsteps, near misses and ambience every frame. Presentation code forwards combat events;
 * network code (M3–M4) calls `audio` (GameAudio) directly with remote events.
 */
export class AudioDirector {
  readonly settings = new AudioSettings();
  readonly engine = new AudioEngine(this.settings);
  readonly bank = new SoundBank(import.meta.env.BASE_URL);
  readonly probe: AudioWorldProbe;
  readonly audio: GameAudio;
  readonly weapon: WeaponAudio;
  readonly footsteps: FootstepSystem;
  readonly ambience: AmbienceSystem;
  readonly debug: AudioDebug | null = null;
  /** Extra bullets to test for fly-bys (DEV fly-by generator; remote tracer sims later). */
  readonly flyBys: Projectile[] = [];

  private readonly nearMiss: NearMissDetector;
  private readonly forward = new Vector3();
  private readonly up = new Vector3();
  private readonly ownShots = { projectiles: [] as readonly Projectile[], own: true };
  private readonly projectileLists = [this.ownShots, { projectiles: this.flyBys, own: false }];

  constructor(
    scene: Scene,
    private readonly player: PlayerController,
    private readonly combat: CombatView,
  ) {
    this.probe = new AudioWorldProbe(scene, player.physicsBody);
    this.audio = new GameAudio(this.engine, this.bank, this.probe, this.settings);
    this.weapon = new WeaponAudio(this.audio);
    this.footsteps = new FootstepSystem(this.audio);
    this.ambience = new AmbienceSystem(this.audio);
    this.nearMiss = new NearMissDetector(this.audio);
    const targets = targetFootsteps(combat);
    if (targets) this.footsteps.sources.push(targets);
    if (import.meta.env.DEV) this.debug = new AudioDebug(this);
  }

  /** Once per render frame, after the player and combat updated. */
  update(dt: number): void {
    const camera = this.player.camera;
    camera.getDirectionToRef(Vector3.Forward(), this.forward);
    camera.getDirectionToRef(Vector3.Up(), this.up);
    const head = camera.position;
    this.probe.update(dt, head);
    this.engine.setEnvironment(this.probe.enclosure);
    this.audio.setListener(head, this.forward, this.up);
    this.engine.update();

    this.footsteps.update(dt, head, this.player.moveState);
    // Every combat projectile is the local player's until remote shots exist (M3); fly-bys are remote.
    this.ownShots.projectiles = this.combat.projectiles;
    this.nearMiss.update(this.projectileLists, head);
    this.ambience.update(dt, head);
    this.debug?.update(dt);
  }

  // --- Local combat events ------------------------------------------------------------------------------------------

  shot(weaponId: WeaponId): void {
    this.weapon.shot(weaponId, this.player.camera.position);
  }

  actionCycle(weaponId: WeaponId, plan: ClipPlan): void {
    if (plan.cues.length > 0) this.weapon.actionCycle(weaponId, plan);
  }

  impact(weaponId: WeaponId, point: Vector3, normal: Vector3, target: boolean): void {
    this.audio.playImpact({ position: point, normal, weaponId, surface: target ? "flesh" : undefined });
  }

  hitConfirm(zone: HitZone, killed: boolean): void {
    this.audio.playHitConfirm({ zone, killed });
  }

  casing(weaponId: WeaponId, position: Vector3): void {
    const design = WEAPON_SOUNDS[weaponId];
    this.audio.playCasing(position, design.casingRate, design.casingLowpass);
  }

  dispose(): void {
    this.debug?.dispose();
    this.ambience.stop();
    this.engine.dispose();
  }
}

/**
 * Footsteps for the practice soldiers. CombatView doesn't expose targets, but CombatSystem does (read-only use);
 * remote players will provide their own FootstepEmitterSource from network state.
 */
function targetFootsteps(combat: CombatView): FootstepEmitterSource | null {
  const range = (combat as Partial<{ readonly targets: TargetRange }>).targets;
  if (!range) return null;
  return {
    forEachEmitter(visit) {
      for (const dummy of range.dummies) {
        const { motion, root } = dummy.soldier;
        visit({ id: dummy.id, position: root.position, grounded: motion.grounded, crouched: motion.crouched, sprinting: motion.sprinting, alive: dummy.alive });
      }
    },
  };
}
