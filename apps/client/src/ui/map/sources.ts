import { SIMULATION, type MatchView } from "@twobullets/shared";
import { clamp01 } from "../anim";
import { zoneLabel, type MatchHudFrame } from "../match/MatchHud";
import type { MapTeammate, MapViewer, MapViewSource, MapZoneInfo } from "./types";

const RAD_TO_DEG = 180 / Math.PI;

/** Structural camera (Babylon TargetCamera): world position and yaw (rotation.y, 0 = north, π/2 = east). */
export interface MapCamera {
  readonly globalPosition: { readonly x: number; readonly z: number };
  readonly rotation: { readonly y: number };
}

/** Plain map mode: the player only, from the camera. */
export function cameraMapSource(camera: MapCamera): MapViewSource {
  return {
    readViewer(out: MapViewer): void {
      out.x = camera.globalPosition.x;
      out.z = camera.globalPosition.z;
      out.headingDegrees = camera.rotation.y * RAD_TO_DEG;
      out.number = 1;
    },
  };
}

/**
 * Offline match: the viewer from the match HUD frame (camera position and heading, the human or the spectated actor),
 * teammates of the focus actor, the zone and its timer (same wording as the match HUD).
 */
export function matchMapSource(view: MatchView, frame: MatchHudFrame): MapViewSource {
  const numberInTeam = (slot: number): number => {
    const actor = view.state.actors[slot];
    const team = actor ? view.state.teams[actor.team] : undefined;
    const index = team ? team.slots.indexOf(slot) : -1;
    return index + 1;
  };
  return {
    readViewer(out: MapViewer): void {
      out.x = frame.viewerX;
      out.z = frame.viewerZ;
      out.headingDegrees = frame.headingDegrees;
      out.number = Math.max(1, numberInTeam(frame.focusSlot));
    },
    readTeammates(out: readonly MapTeammate[]): number {
      const actors = view.state.actors;
      const focus = actors[frame.focusSlot];
      if (!focus) return 0;
      let count = 0;
      for (let i = 0; i < actors.length && count < out.length; i++) {
        const actor = actors[i];
        if (!actor || actor.team !== focus.team || actor.slot === focus.slot) continue;
        const mate = out[count++]!;
        mate.x = actor.feet.x;
        mate.z = actor.feet.z;
        mate.headingDegrees = actor.yaw * RAD_TO_DEG;
        mate.number = numberInTeam(actor.slot);
        mate.state = actor.life === "dead" ? "dead" : actor.life === "downed" ? "downed" : "alive";
      }
      return count;
    },
    readZone(out: MapZoneInfo): void {
      const { state, config } = view;
      const zone = state.zone;
      const combat = state.phase === "combat";
      const announced = state.zonePhases.length > 0 && (combat || state.phase === "ended");
      out.current = announced ? zone.current : null;
      out.next = announced ? zone.next : null;
      out.seconds = -1;
      out.progress = -1;
      if (!combat) {
        out.label = "";
        return;
      }
      out.label = zoneLabel(zone.stage);
      if (zone.stage === "idle") {
        const ticks = state.combatStartTick + Math.round(config.zone.firstAnnounceSeconds * config.timeScale * SIMULATION.tickRate) - state.tick;
        out.seconds = Math.max(0, Math.ceil(ticks / SIMULATION.tickRate));
      } else if (zone.stage === "waiting") {
        out.seconds = Math.max(0, Math.ceil(zone.ticksToChange / SIMULATION.tickRate));
      } else if (zone.stage === "shrinking" && zone.phase) {
        out.progress = clamp01(1 - zone.ticksToChange / Math.max(1, zone.phase.shrinkEndTick - zone.phase.shrinkStartTick));
      }
    },
  };
}
