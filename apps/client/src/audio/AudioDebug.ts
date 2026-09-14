import { ITEMS, MOVEMENT, getWeaponDef, type HitZone, type Projectile, type WeaponId } from "@twobullets/shared";
import { gainToDb, strideLength, type Vec3Like } from "./acoustics";
import { smokeHissLevel } from "./equipmentMix";
import type { AudioDirector } from "./AudioDirector";
import type { AudioVolumeKey } from "./AudioSettings";
import type {
  AcousticSurface,
  FootstepStance,
  MechanicalAudioEvent,
  PickupAudioKind,
  ThrowableAudioKind,
  ThrowActionAudioEvent,
  UseItemAudioId,
} from "./types";

const OVERLAY_INTERVAL = 0.25;
const FLY_BY_START = 80;

interface FlyBy extends Projectile {
  position: { x: number; y: number; z: number };
  age: number;
}

/**
 * DEV-only console API (`__audio` in the browser console) and an optional voice overlay (`__audio.overlay()` or
 * `?audioDebug` in the URL). Bearings are degrees clockwise from where the camera looks; distances in meters.
 */
export class AudioDebug {
  private overlayRoot: HTMLDivElement | null = null;
  private overlayTimer = 0;
  private nextFlyById = -1_000_000;
  private nextAreaId = -1;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(private readonly director: AudioDirector) {
    Object.assign(window, { __audio: this.api() });
    if (new URLSearchParams(location.search).has("audioDebug")) this.setOverlay(true);
    console.info("[audio] DEV console: __audio.help()");
  }

  update(dt: number): void {
    const flyBys = this.director.flyBys as FlyBy[];
    for (let i = flyBys.length - 1; i >= 0; i--) {
      const p = flyBys[i] as FlyBy;
      p.position.x += p.velocity.x * dt;
      p.position.y += p.velocity.y * dt;
      p.position.z += p.velocity.z * dt;
      p.age += dt;
      if (p.age > (2 * FLY_BY_START) / Math.hypot(p.velocity.x, p.velocity.y, p.velocity.z)) flyBys.splice(i, 1);
    }
    this.overlayTimer -= dt;
    if (this.overlayRoot && this.overlayTimer <= 0) {
      this.overlayTimer = OVERLAY_INTERVAL;
      this.renderOverlay(this.overlayRoot);
    }
  }

  dispose(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.setOverlay(false);
    Reflect.deleteProperty(window, "__audio");
  }

  private api() {
    const { director } = this;
    const audio = director.audio;
    return {
      help: () =>
        console.info(
          [
            "__audio.gunshot(weapon='rifle', distance=100, bearing=0, suppressed=false)",
            "__audio.burst(weapon='rifle', distance=150, bearing=45, count=6, interval=0.1)",
            "__audio.ownShot(weapon='rifle')",
            "__audio.ab(a='sniper', b='rifle', distance=0, gap=1.6)   // A/B two guns: first person at 0, spatial otherwise",
            "__audio.nearMiss(weapon='rifle', miss=1.5, fromBearing=0)",
            "__audio.footsteps(surface='concrete', stance='run', distance=8, bearing=90, steps=8)",
            "__audio.impact(surface='metal', distance=15, bearing=-30)   // surface='flesh' takes a 4th arg zone='head'",
            "__audio.explosion(distance=60, bearing=0, kind='frag')   // kind 'flash' for the flashbang bang",
            "__audio.flashRing(strength=1, seconds=6)   // tinnitus, ducks and dulls the mix",
            "__audio.smoke(distance=12, bearing=30, seconds=12)   // pop + hiss loop",
            "__audio.fire(distance=8, bearing=-40, seconds=10)   // molotov shatter + crackle loop",
            "__audio.bounce(surface='concrete', distance=6, bearing=0, speed=6, kind='frag')",
            "__audio.throw(action='pinPull', kind='frag')   // draw | pinPull | spoon | throw | pinReturn | holster",
            "__audio.useItem('medkit')  __audio.cancelUse()   // bandage | first_aid | medkit | energy_drink | painkiller",
            "__audio.pickup('ammo')  __audio.armor(destroyed=false)",
            "__audio.mech(kind='boltOpen', weapon='sniper')",
            "__audio.hit(zone='head', killed=false)",
            "__audio.landing(fallSpeed=10)",
            "__audio.ambience(on=true)   // off by default (AMBIENCE_ENABLED)  __audio.indoor(1 | 0 | null)",
            "__audio.volume('weapons', 0.5)  __audio.voices()  __audio.stats()  __audio.overlay(on=true)",
          ].join("\n"),
        ),
      gunshot: (weaponId: WeaponId = "rifle", distance = 100, bearing = 0, suppressed = false) =>
        audio.playGunshot({ weaponId, position: this.around(distance, bearing, -0.2), shooterIsLocal: false, suppressed }),
      burst: (weaponId: WeaponId = "rifle", distance = 150, bearing = 45, count = 6, interval = 0.1) => {
        for (let i = 0; i < count; i++) this.later(i * interval, () => audio.playGunshot({ weaponId, position: this.around(distance, bearing, -0.2), shooterIsLocal: false }));
      },
      ownShot: (weaponId: WeaponId = "rifle") => audio.playGunshot({ weaponId, position: audio.listenerPosition, shooterIsLocal: true }),
      ab: (a: WeaponId = "sniper", b: WeaponId = "rifle", distance = 0, gap = 1.6) => {
        const fire = (weaponId: WeaponId) =>
          distance <= 0
            ? audio.playGunshot({ weaponId, position: audio.listenerPosition, shooterIsLocal: true })
            : audio.playGunshot({ weaponId, position: this.around(distance, 0, -0.2), shooterIsLocal: false });
        fire(a);
        this.later(gap, () => fire(b));
        console.info(`[audio] A = ${a}, then B = ${b} after ${gap}s${distance > 0 ? ` at ${distance} m` : " (first person)"}`);
      },
      nearMiss: (weaponId: WeaponId = "rifle", miss = 1.5, fromBearing = 0) => this.spawnFlyBy(weaponId, miss, fromBearing),
      footsteps: (surface: AcousticSurface = "concrete", stance: FootstepStance = "run", distance = 8, bearing = 90, steps = 8) => {
        const speed = { crouch: MOVEMENT.crouchSpeed, walk: 4, run: MOVEMENT.walkSpeed, sprint: MOVEMENT.sprintSpeed }[stance];
        const stride = strideLength(speed);
        for (let i = 0; i < steps; i++) {
          // Walk across the listener's view at `distance`, perpendicular to the bearing.
          const offset = (i - steps / 2) * stride;
          this.later((i * stride) / speed, () => audio.playFootstep({ position: this.around(distance, bearing, -MOVEMENT.standEyeHeight, offset), surface, stance, isLocal: false }));
        }
      },
      impact: (surface: AcousticSurface | "flesh" = "concrete", distance = 15, bearing = 0, zone: HitZone = "body") =>
        audio.playImpact({ position: this.around(distance, bearing, -1), surface, weaponId: "rifle", zone }),
      explosion: (distance = 60, bearing = 0, kind: "frag" | "flash" = "frag") => audio.playExplosion({ position: this.around(distance, bearing, -1.5), kind }),
      flashRing: (strength = 1, seconds = 6 * strength) => audio.playFlashRing({ strength, seconds }),
      smoke: (distance = 12, bearing = 30, seconds = 12) => {
        const position = this.around(distance, bearing, -MOVEMENT.standEyeHeight);
        const id = this.nextAreaId--;
        audio.playSmokePop({ position });
        const start = performance.now();
        const step = () => {
          const age = (performance.now() - start) / 1000;
          if (age >= seconds) return audio.stopArea(id);
          audio.playSmokeHiss(id, position, smokeHissLevel(Math.min(age, 8)));
          this.later(0.25, step);
        };
        this.later(0.3, step);
      },
      fire: (distance = 8, bearing = -40, seconds = 10) => {
        const position = this.around(distance, bearing, -MOVEMENT.standEyeHeight);
        const id = this.nextAreaId--;
        audio.playMolotovShatter({ position });
        this.later(0.15, () => audio.playFire(id, position, 1));
        this.later(seconds, () => audio.stopArea(id));
      },
      bounce: (surface: AcousticSurface = "concrete", distance = 6, bearing = 0, speed = 6, kind: ThrowableAudioKind = "frag") =>
        audio.playThrowableBounce({ kind, position: this.around(distance, bearing, -MOVEMENT.standEyeHeight), impactSpeed: speed, surface }),
      throw: (action: ThrowActionAudioEvent["action"] = "pinPull", kind: ThrowableAudioKind = "frag") => audio.playThrowAction({ action, kind, style: "overhand", position: null }),
      useItem: (itemId: UseItemAudioId = "medkit") => audio.playItemUse({ itemId, seconds: ITEMS[itemId].useSeconds, position: null, tag: "debug.use" }),
      cancelUse: () => audio.stopItemUse("debug.use"),
      pickup: (kind: PickupAudioKind | "drop" = "ammo") => audio.playPickup(kind),
      armor: (destroyed = false) => audio.playArmorHit({ absorbed: 15, destroyed, position: null }),
      mech: (kind: MechanicalAudioEvent["kind"] = "boltOpen", weaponId: WeaponId = "sniper") => audio.playMechanical({ kind, weaponId, position: null, span: 0.3 }),
      hit: (zone: HitZone = "body", killed = false) => audio.playHitConfirm({ zone, killed }),
      landing: (fallSpeed = 10) => audio.playLanding({ position: this.around(0, 0, -MOVEMENT.standEyeHeight), fallSpeed, isLocal: true }),
      ambience: (on = true) => {
        director.settings.ambienceEnabled = on;
        console.info(`[audio] ambience ${on ? "on (loading wind/birds on first use)" : "off"}`);
      },
      indoor: (value: number | null) => {
        director.probe.enclosureOverride = value;
      },
      volume: (key: AudioVolumeKey, value: number) => director.settings.set(key, value),
      voices: () =>
        console.table(
          director.engine.activeVoices.map((v) => ({
            label: v.options.label,
            bus: v.options.bus,
            priority: v.options.priority,
            distance: v.options.distance?.toFixed(1) ?? "-",
            gainDb: gainToDb(v.options.gain ?? 1).toFixed(1),
            occluded: v.options.occluded ?? false,
          })),
        ),
      stats: () => ({
        format: director.bank.format,
        ...director.bank.stats,
        voices: director.engine.activeVoices.length,
        culled: director.engine.culled,
        stolen: director.engine.stolen,
        indoor: director.probe.enclosure.toFixed(2),
        ambience: director.settings.ambienceEnabled,
        raysSkipped: director.probe.raysSkipped,
        context: director.engine.live ? "running" : "not started (click the page)",
      }),
      overlay: (on = true) => this.setOverlay(on),
    };
  }

  /** Point `distance` m from the listener at `bearing`° (clockwise from view), `up` m vertically, `across` m sideways. */
  private around(distance: number, bearing: number, up: number, across = 0): Vec3Like {
    const head = this.director.audio.listenerPosition;
    const f = this.director.audio.listenerForward;
    const length = Math.hypot(f.x, f.z) || 1;
    const fx = f.x / length;
    const fz = f.z / length;
    const b = (bearing * Math.PI) / 180;
    // Babylon is left-handed: right of forward (fx, fz) is (fz, -fx).
    const dx = fx * Math.cos(b) + fz * Math.sin(b);
    const dz = fz * Math.cos(b) - fx * Math.sin(b);
    return { x: head.x + dx * distance + dz * across, y: head.y + up, z: head.z + dz * distance - dx * across };
  }

  private spawnFlyBy(weaponId: WeaponId, miss: number, fromBearing: number): void {
    const speed = getWeaponDef(weaponId).muzzleVelocity;
    const start = this.around(FLY_BY_START, fromBearing, 0, miss);
    const end = this.around(-FLY_BY_START, fromBearing, 0, miss);
    const k = speed / (2 * FLY_BY_START);
    const id = this.nextFlyById--;
    const flyBy: FlyBy = {
      id,
      shotId: id,
      weaponId,
      position: { ...start },
      velocity: { x: (end.x - start.x) * k, y: (end.y - start.y) * k, z: (end.z - start.z) * k },
      distance: 0,
      age: 0,
    };
    this.director.flyBys.push(flyBy);
    // The shooter's report follows from where the bullet came from.
    const shooter = this.around(FLY_BY_START * 3, fromBearing, 0, miss);
    this.director.audio.playGunshot({ weaponId, position: shooter, shooterIsLocal: false });
  }

  private later(seconds: number, action: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      action();
    }, seconds * 1000);
    this.timers.add(timer);
  }

  private setOverlay(on: boolean): void {
    if (on && !this.overlayRoot) {
      const root = document.createElement("div");
      root.style.cssText =
        "position:fixed;right:8px;bottom:8px;z-index:9999;max-height:45vh;overflow:hidden;padding:6px 8px;" +
        "background:rgba(0,0,0,.65);color:#cfe;font:11px/1.35 ui-monospace,monospace;white-space:pre;pointer-events:none;border-radius:4px";
      document.body.appendChild(root);
      this.overlayRoot = root;
    } else if (!on && this.overlayRoot) {
      this.overlayRoot.remove();
      this.overlayRoot = null;
    }
  }

  private renderOverlay(root: HTMLDivElement): void {
    const { engine, probe, bank } = this.director;
    const now = engine.now;
    const lines = [
      `audio ${engine.live ? "running" : "suspended"}  ${bank.format}  voices ${engine.activeVoices.length}  culled ${engine.culled}  stolen ${engine.stolen}`,
      `indoor ${probe.enclosure.toFixed(2)}  rays ${probe.raysThisFrame}/frame  skipped ${probe.raysSkipped}`,
    ];
    for (const v of engine.activeVoices.slice(-18)) {
      const o = v.options;
      const wait = v.sources.length > 0 ? Math.max(0, v.end - now) : 0;
      lines.push(
        `${o.bus.padEnd(9)} ${o.label.padEnd(20)} p${o.priority} ${o.distance !== undefined ? `${o.distance.toFixed(0).padStart(4)}m` : "   2D"} ${gainToDb(o.gain ?? 1).toFixed(0).padStart(4)}dB${o.occluded ? " occl" : ""} ${wait === Infinity ? "loop" : `${wait.toFixed(1)}s`}`,
      );
    }
    root.textContent = lines.join("\n");
  }
}
