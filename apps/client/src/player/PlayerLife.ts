import { Vector3, type Observer } from "@babylonjs/core";
import { fallDamage, type DamageKind } from "@twobullets/shared";
import type { EquipmentPlayerControl, EquipmentView, VitalsViewEvent } from "../equipment/types";
import type { PlayerController, PlayerTick } from "./PlayerController";

/** Offline: seconds from elimination to respawn. */
export const RESPAWN_SECONDS = 5;
/** Entity id the DEV teammate revives with (never a real entity offline). */
const DEV_TEAMMATE_ID = 1000;

export interface PlayerLifeOptions {
  /** DEV `?teammate=1`: a simulated standing teammate, so 0 HP knocks instead of eliminating. */
  readonly teammate?: boolean;
  /** False: elimination is final (offline bot match: death screen and spectate instead). Default true. */
  readonly respawn?: boolean;
}

/**
 * The local player's life offline, with vitals in EquipmentSystem as the source of truth: fall damage from landings,
 * elimination → respawn at a level spawn with a fresh kit after RESPAWN_SECONDS, and the DEV knock/revive flow.
 */
export class PlayerLife {
  private respawnTimer = 0;
  private reviving = false;
  /** Offline respawn after elimination; the offline match turns it off (`respawn: false` does the same). */
  respawnEnabled: boolean;
  private readonly tickObserver: Observer<PlayerTick>;
  private readonly vitalsObserver: Observer<VitalsViewEvent>;
  private readonly feet = new Vector3();

  constructor(
    private readonly player: PlayerController,
    private readonly equipment: EquipmentView,
    private readonly control: EquipmentPlayerControl,
    private readonly options: PlayerLifeOptions = {},
  ) {
    this.respawnEnabled = options.respawn !== false;
    control.canBeKnocked = options.teammate === true;
    this.tickObserver = player.onTick.add((tick) => this.tick(tick));
    this.vitalsObserver = equipment.onVitals.add((event) => this.onVitals(event));
  }

  /** DEV: the simulated teammate starts a 5 s revive (needs `?teammate=1` and a knocked player). */
  revive(): string {
    if (!this.options.teammate) return "revive needs ?teammate=1 (solo players are eliminated, not knocked)";
    if (this.equipment.vitals.life !== "downed") return `not knocked (life: ${this.equipment.vitals.life})`;
    this.control.setReviver(DEV_TEAMMATE_ID);
    this.reviving = true;
    return "reviving…";
  }

  /** DEV: damages the local player through vitals (armor applies to "explosion" and "bullet"). */
  damage(amount: number, kind: DamageKind = "fall"): void {
    this.control.damagePlayer({ amount, kind, zone: kind === "bullet" || kind === "explosion" ? "body" : null, sourceId: -1, position: this.feetPosition() });
  }

  dispose(): void {
    this.tickObserver.remove();
    this.vitalsObserver.remove();
  }

  private tick({ dt, landingSpeed }: PlayerTick): void {
    const amount = fallDamage(landingSpeed);
    if (amount > 0) {
      this.control.damagePlayer({ amount, kind: "fall", zone: null, sourceId: -1, position: this.feetPosition() });
    }
    if (this.respawnTimer <= 0) return;
    this.respawnTimer -= dt;
    if (this.respawnTimer <= 0) this.respawn();
  }

  private onVitals(event: VitalsViewEvent): void {
    switch (event.type) {
      case "eliminated": {
        this.stopRevive();
        if (!this.respawnEnabled) {
          console.info(`[life] eliminated by ${event.killerId < 0 ? "the world" : `#${event.killerId}`} (${event.cause})`);
          break;
        }
        this.respawnTimer = RESPAWN_SECONDS;
        // The HUD's death recap listens to the same event; this is the console trail.
        console.info(`[life] eliminated by ${event.killerId < 0 ? "the world" : `#${event.killerId}`} (${event.cause}); respawning in ${RESPAWN_SECONDS} s`);
        break;
      }
      case "knocked":
        console.info(`[life] knocked by ${event.byId < 0 ? "the world" : `#${event.byId}`}; __twobullets.life.revive() to get up`);
        break;
      case "revived":
      case "reviveCancelled":
        this.stopRevive();
        break;
    }
  }

  private respawn(): void {
    this.control.resetLoadout();
    this.player.respawn();
  }

  private stopRevive(): void {
    if (!this.reviving) return;
    this.reviving = false;
    this.control.setReviver(null);
  }

  private feetPosition() {
    const { x, y, z } = this.player.getFeetToRef(this.feet);
    return { x, y, z };
  }
}
