import { Vector3, type Observer, type Scene } from "@babylonjs/core";
import { MOVEMENT, type HitZone, type Projectile, type ThrowableKind, type WeaponId } from "@twobullets/shared";
import type { CombatView, DamageEvent } from "../combat/types";
import type { EquipmentView } from "../equipment/types";
import type { PlayerController } from "../player/PlayerController";
import type { TargetRange } from "../targets/TargetRange";
import type { ClipPlan } from "../viewmodel/clipPlans";
import type { Vec3Like } from "./acoustics";
import { AmbienceSystem } from "./AmbienceSystem";
import { AudioDebug } from "./AudioDebug";
import { AudioEngine } from "./AudioEngine";
import { AudioSettings } from "./AudioSettings";
import { AudioWorldProbe } from "./AudioWorldProbe";
import { EquipmentAudio } from "./equipment/EquipmentAudio";
import { FootstepSystem, type FootstepEmitterSource } from "./FootstepSystem";
import { GameAudio } from "./GameAudio";
import { matchEndMusicSink, setMatchEndMusicSink } from "./matchEndCue";
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
  /** Bullets of actors the client doesn't simulate (offline match bots), for near-miss cracks. Owned by WeaponPresentation. */
  readonly remoteShots: Projectile[] = [];

  private readonly nearMiss: NearMissDetector;
  private equipment: EquipmentAudio | null = null;
  private readonly damageObserver: Observer<DamageEvent>;
  private readonly forward = new Vector3();
  private readonly up = new Vector3();
  private readonly calloutHead = { x: 0, y: 0, z: 0 };
  private readonly ownShots = { projectiles: [] as readonly Projectile[], own: true };
  private readonly projectileLists = [this.ownShots, { projectiles: this.flyBys, own: false }, { projectiles: this.remoteShots, own: false }];

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
    // Armor on the target: a plate clank where the bullet struck (and a crack when the piece breaks).
    this.damageObserver = combat.onDamage.add((event) => {
      if (event.armorAbsorbed > 0) this.audio.playArmorHit({ absorbed: event.armorAbsorbed, destroyed: event.armorDestroyed, position: event.point });
    });
    // Results screens reach the audio through this sink (matchEndCue.ts). The 17 s clip downloads in the background
    // once the eager set is in, so it never competes with match start.
    setMatchEndMusicSink(this.audio);
    void this.bank.ready.then(() => this.bank.load("music.matchEnd"));
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
    if (this.equipment) this.equipment.update(dt);
    else this.audio.updateAreas(dt);
    this.debug?.update(dt);
  }

  /**
   * Throwables, smoke/fire loops, flashbang ringing, healing, pickups, armor and knocked/eliminated sounds for the
   * local player's equipment. Call once after EquipmentSystem exists (Game.ts); a second call replaces the first.
   */
  attachEquipment(view: EquipmentView): void {
    this.equipment?.dispose();
    this.equipment = new EquipmentAudio(this.audio, view);
  }

  // --- Local combat events ------------------------------------------------------------------------------------------

  shot(weaponId: WeaponId): void {
    this.weapon.shot(weaponId, this.player.camera.position);
  }

  actionCycle(weaponId: WeaponId, plan: ClipPlan): void {
    if (plan.cues.length > 0) this.weapon.actionCycle(weaponId, plan);
  }

  impact(weaponId: WeaponId, point: Vector3, normal: Vector3): void {
    this.audio.playImpact({ position: point, normal, weaponId });
  }

  /** Bullet into a character; play once per merged hit (shotgun pellets on one target share it). */
  fleshImpact(weaponId: WeaponId, point: Vector3, zone: HitZone): void {
    this.audio.playImpact({ position: point, weaponId, surface: "flesh", zone });
  }

  hitConfirm(zone: HitZone, killed: boolean): void {
    this.audio.playHitConfirm({ zone, killed });
  }

  // --- Remote actors (offline match bots, remote players) -----------------------------------------------------------

  /** Spatial gunshot with distance, occlusion and speed-of-sound delay (the remote-player mix). */
  remoteShot(weaponId: WeaponId, muzzle: Vec3Like): void {
    this.audio.playGunshot({ weaponId, position: muzzle, shooterIsLocal: false });
  }

  /** Remote bullet into the world or a character (flesh when `zone` is set). */
  remoteImpact(weaponId: WeaponId, point: Vec3Like, normal: Vec3Like, zone: HitZone | null): void {
    if (zone) this.audio.playImpact({ position: point, weaponId, surface: "flesh", zone });
    else this.audio.playImpact({ position: point, normal, weaponId });
  }

  /**
   * Networked play: the local tracer crossed a remote player's hitbox rig before the server confirmed anything. A dull,
   * soft body thud only (netcode.md §5.7); the confirm sound comes with `HitConfirm`.
   */
  predictedBodyHit(point: Vec3Like): void {
    this.audio.playImpact({ position: point, weaponId: "shotgun", surface: "flesh", zone: "limb" });
  }

  /**
   * A throwable left a remote actor's hand (offline bots: MatchFxEvent `throwRelease`). Frags only: the frag-out shout
   * from the thrower's head, at most one per thrower.
   */
  remoteThrow(kind: ThrowableKind, thrower: number, feet: Vec3Like): void {
    if (kind !== "frag") return;
    const head = this.calloutHead;
    head.x = feet.x;
    head.y = feet.y + MOVEMENT.standEyeHeight;
    head.z = feet.z;
    this.audio.playFragCallout({ thrower, position: head });
  }

  casing(weaponId: WeaponId, position: Vector3): void {
    const design = WEAPON_SOUNDS[weaponId];
    this.audio.playCasing(position, design.casingRate, design.casingLowpass);
  }

  dispose(): void {
    this.audio.stopMatchEndMusic();
    if (matchEndMusicSink() === this.audio) setMatchEndMusicSink(null);
    this.damageObserver.remove();
    this.equipment?.dispose();
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
