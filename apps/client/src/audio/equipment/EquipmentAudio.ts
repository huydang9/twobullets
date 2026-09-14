import type { IObserver } from "@babylonjs/core";
import { FIRE_CELL_STRIDE, ITEMS, isCellBurning, type FirePatch, type ItemId, type ThrowEvent, type Vec3 } from "@twobullets/shared";
import type {
  ArmorEvent,
  DetonationEvent,
  EquipmentView,
  FireEvent,
  FlashEvent,
  ItemEvent,
  SmokeEvent,
  ThrowableBounceEvent,
  UseEvent,
  VitalsViewEvent,
} from "../../equipment/types";
import { arrivalDelay, distance, type Vec3Like } from "../acoustics";
import { Priority } from "../AudioEngine";
import { fireLevel, smokeHissLevel } from "../equipmentMix";
import type { GameAudio } from "../GameAudio";
import type { PickupAudioKind } from "../types";

const USE_TAG = "equipment.use";
/** Heartbeat below this health (or while knocked). */
const HEARTBEAT_HEALTH = 25;
const REVIVE_RUSTLE_SECONDS = 0.7;

/**
 * Local equipment → sound: throw handling, bounces, detonations, smoke and fire loops, flashbang ringing, healing
 * foley, pickups, armor hits, knocked/revive/eliminated. Everything goes through the network-ready {@link GameAudio}
 * API (remote players will call the same methods from snapshot events) except the listener-only heartbeat and stings.
 */
export class EquipmentAudio {
  private readonly observers: IObserver[];
  private readonly fireCenters = new Map<number, Vec3Like>();
  private lastFlash: Vec3 | null = null;
  private heartbeatIn = 0;
  private reviveRustleIn = 0;

  constructor(
    private readonly audio: GameAudio,
    private readonly view: EquipmentView,
  ) {
    this.observers = [
      view.onThrow.add(this.handleThrow),
      view.onThrowableBounce.add(this.handleBounce),
      view.onDetonate.add(this.handleDetonate),
      view.onSmoke.add(this.handleSmoke),
      view.onFire.add(this.handleFire),
      view.onFlash.add(this.handleFlash),
      view.onUse.add(this.handleUse),
      view.onItem.add(this.handleItem),
      view.onArmor.add(this.handleArmor),
      view.onVitals.add(this.handleVitals),
    ];
  }

  /** Per render frame, after the listener moved. */
  update(dt: number): void {
    for (const cloud of this.view.smokes) this.audio.playSmokeHiss(cloud.id, cloud.base, smokeHissLevel(cloud.age));
    for (const patch of this.view.fires) {
      const center = this.fireCenters.get(patch.id);
      if (center) this.audio.playFire(patch.id, center, fireLevel(burningShare(patch)));
    }
    this.audio.updateAreas(dt);
    this.updateHeartbeat(dt);
  }

  dispose(): void {
    for (const observer of this.observers) observer.remove();
    this.observers.length = 0;
    this.audio.stopItemUse(USE_TAG);
    for (const cloud of this.view.smokes) this.audio.stopArea(cloud.id);
    for (const patch of this.view.fires) this.audio.stopArea(patch.id);
  }

  private updateHeartbeat(dt: number): void {
    const vitals = this.view.vitals;
    const downed = vitals.life === "downed";
    const low = vitals.life === "alive" && vitals.health < HEARTBEAT_HEALTH;
    if (!downed && !low) {
      this.heartbeatIn = 0;
      return;
    }
    this.heartbeatIn -= dt;
    if (this.heartbeatIn > 0) return;
    // Faster and heavier as the pool or health drains.
    const urgency = downed ? 1 - vitals.downedHealth / 100 : 1 - vitals.health / HEARTBEAT_HEALTH;
    this.heartbeatIn = 1.05 - 0.4 * urgency;
    this.heartbeat(0.5 + 0.5 * urgency);
  }

  private heartbeat(strength: number): void {
    const engine = this.audio.engine;
    const ctx = engine.live;
    const voice = ctx ? engine.voice({ bus: "ui", priority: Priority.normal, label: "heartbeat", gain: 0.22 * strength }) : null;
    if (!ctx || !voice) return;
    const now = ctx.currentTime;
    voice.addTone({ when: now, gain: 0.9, frequency: 62, frequencyEnd: 44, sweep: 0.08, attack: 0.01, decay: 0.06 });
    voice.addTone({ when: now + 0.26, gain: 0.6, frequency: 55, frequencyEnd: 40, sweep: 0.08, attack: 0.01, decay: 0.07 });
  }

  /** Cloth and kit handling while being revived. */
  private rustle(): void {
    const engine = this.audio.engine;
    const ctx = engine.live;
    const cloth = this.audio.bank.pick("foley.cloth");
    const voice = ctx && cloth ? engine.voice({ bus: "foley", priority: Priority.local, label: "revive.rustle", gain: 0.4 }) : null;
    if (!ctx || !cloth || !voice) return;
    voice.addBuffer(cloth, { when: ctx.currentTime, rate: 0.85 + Math.random() * 0.3 });
    const paper = this.audio.bank.pick("use.paper");
    if (paper && Math.random() < 0.4) voice.addBuffer(paper, { when: ctx.currentTime + 0.08, rate: 0.9 + Math.random() * 0.2, gain: 0.5 });
  }

  /** Short dull sting for knocks and eliminations; listener only. */
  private sting(frequency: number, seconds: number, gain: number): void {
    const engine = this.audio.engine;
    const ctx = engine.live;
    const voice = ctx ? engine.voice({ bus: "ui", priority: Priority.local, label: "sting", gain }) : null;
    if (!ctx || !voice) return;
    const now = ctx.currentTime;
    voice.addTone({ when: now, gain: 0.5, frequency, frequencyEnd: frequency / 2, sweep: seconds, attack: 0.03, decay: seconds / 3 });
    voice.addTone({ when: now + 0.02, gain: 0.15, type: "triangle", frequency: frequency * 1.5, frequencyEnd: frequency * 0.75, sweep: seconds, attack: 0.05, decay: seconds / 4 });
    voice.addNoise({ when: now, gain: 0.2, filter: "lowpass", frequency: 400, decay: 0.12 });
  }

  private readonly handleThrow = (event: ThrowEvent): void => {
    const audio = this.audio;
    switch (event.type) {
      case "throwEquipStarted":
        audio.playThrowAction({ action: "draw", kind: event.kind, position: null });
        break;
      case "pinPulled":
        audio.playThrowAction({ action: "pinPull", kind: event.kind, position: null });
        break;
      case "cookStarted":
        audio.playThrowAction({ action: "spoon", kind: event.kind, position: null });
        break;
      case "throwReleased":
        if (event.style === "overhand" || event.style === "underhand") audio.playThrowAction({ action: "throw", kind: event.kind, style: event.style, position: null });
        break;
      case "pinReturned":
        audio.playThrowAction({ action: "pinReturn", kind: event.kind, position: null });
        break;
      case "throwableHolstered":
        audio.playThrowAction({ action: "holster", kind: event.kind, position: null });
        break;
      case "throwablesDepleted":
        break;
    }
  };

  private readonly handleBounce = (event: ThrowableBounceEvent): void => {
    this.audio.playThrowableBounce({ kind: event.kind, position: event.position, normal: event.normal, impactSpeed: event.impactSpeed });
  };

  private readonly handleDetonate = (event: DetonationEvent): void => {
    const audio = this.audio;
    switch (event.kind) {
      case "frag":
        audio.playExplosion({ position: event.position, kind: "frag" });
        break;
      case "flash":
        this.lastFlash = event.position;
        audio.playExplosion({ position: event.position, kind: "flash" });
        break;
      case "smoke":
        audio.playSmokePop({ position: event.position });
        break;
      case "molotov":
        audio.playMolotovShatter({ position: event.position });
        break;
    }
  };

  private readonly handleSmoke = (event: SmokeEvent): void => {
    if (event.type === "expired") this.audio.stopArea(event.id);
    else this.audio.playSmokeHiss(event.cloud.id, event.cloud.base, smokeHissLevel(event.cloud.age));
  };

  private readonly handleFire = (event: FireEvent): void => {
    if (event.type === "expired") {
      this.fireCenters.delete(event.id);
      this.audio.stopArea(event.id);
      return;
    }
    const center = fireCenter(event.patch);
    this.fireCenters.set(event.patch.id, center);
    this.audio.playFire(event.patch.id, center, fireLevel(burningShare(event.patch)));
  };

  private readonly handleFlash = (event: FlashEvent): void => {
    const { deaf, deafSeconds } = event.exposure;
    if (deaf <= 0) return;
    // Ring when the bang reaches the ears (the detonation fired earlier in the same tick).
    const delay = this.lastFlash ? arrivalDelay(distance(this.lastFlash, this.audio.listenerPosition)) : 0;
    this.audio.playFlashRing({ strength: deaf, seconds: deafSeconds, delay });
  };

  private readonly handleUse = (event: UseEvent): void => {
    switch (event.type) {
      case "started":
        this.audio.playItemUse({ itemId: event.itemId, seconds: event.seconds, position: null, tag: USE_TAG });
        break;
      case "cancelled":
        this.audio.stopItemUse(USE_TAG);
        break;
      case "progress":
      case "completed":
      case "rejected":
        break;
    }
  };

  private readonly handleItem = (event: ItemEvent): void => {
    if (event.type === "picked") this.audio.playPickup(pickupKind(event.item.itemId));
    else if (event.type === "dropped") this.audio.playPickup("drop");
  };

  private readonly handleArmor = (event: ArmorEvent): void => {
    this.audio.playArmorHit(event.type === "damaged" ? { absorbed: event.absorbed, destroyed: false, position: null } : { absorbed: 20, destroyed: true, position: null });
  };

  private readonly handleVitals = (event: VitalsViewEvent): void => {
    const audio = this.audio;
    switch (event.type) {
      case "knocked":
        this.sting(90, 0.9, 0.35);
        audio.playPickup("drop");
        audio.engine.muffle(1500, 0.05, 0.6, 2.5);
        break;
      case "reviveProgress":
        this.reviveRustleIn -= 1 / 60;
        if (this.reviveRustleIn <= 0) {
          this.reviveRustleIn = REVIVE_RUSTLE_SECONDS * (0.8 + Math.random() * 0.4);
          this.rustle();
        }
        break;
      case "reviveStarted":
        this.reviveRustleIn = 0;
        break;
      case "revived":
        this.rustle();
        break;
      case "reviveCancelled":
        break;
      case "eliminated":
        audio.stopItemUse(USE_TAG);
        this.sting(70, 2.2, 0.3);
        audio.engine.muffle(700, 0.15, 1.2, 3);
        break;
      case "damaged":
      case "healed":
      case "respawned":
        break;
    }
  };
}

function pickupKind(itemId: ItemId): PickupAudioKind {
  const category = ITEMS[itemId].category;
  switch (category) {
    case "ammo":
    case "weapon":
    case "backpack":
    case "throwable":
      return category;
    case "helmet":
    case "vest":
      return "armor";
    default:
      return "consumable";
  }
}

/** Centroid of a patch's cells (the loop is placed where the fire is, not where the bottle hit). */
function fireCenter(patch: FirePatch): Vec3Like {
  let x = 0;
  let y = 0;
  let z = 0;
  let n = 0;
  for (let i = 0; i < patch.cellCount; i++) {
    const o = i * FIRE_CELL_STRIDE;
    x += patch.cells[o]!;
    y += patch.cells[o + 1]!;
    z += patch.cells[o + 2]!;
    n++;
  }
  return n > 0 ? { x: x / n, y: y / n, z: z / n } : { x: 0, y: 0, z: 0 };
}

/** Share of a patch's cells burning now. */
function burningShare(patch: FirePatch): number {
  if (patch.cellCount === 0) return 0;
  let burning = 0;
  for (let i = 0; i < patch.cellCount; i++) if (isCellBurning(patch, i)) burning++;
  return burning / patch.cellCount;
}

