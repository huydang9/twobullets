import { SIMULATION, VITALS, type ActorState, type MatchEvent, type MatchView, type ZoneCircle } from "@twobullets/shared";
import { clamp01, prepareAnimation, replay, setText } from "../anim";
import { compassMarkerOffset } from "../Compass";
import { el, textNode } from "../dom";
import { MatchFeed } from "./MatchFeed";
import { MATCH_STRINGS } from "./strings";

const RAD_TO_DEG = 180 / Math.PI;
/** Teammates farther than this show distance and direction on their card, m. */
const TEAMMATE_DISTANCE_SHOWN = 30;

/** What the match HUD reads each frame (the host fills one object and reuses it). */
export interface MatchHudFrame {
  /** Slot whose team, teammates and zone status the HUD shows: the human, or the spectated actor. */
  focusSlot: number;
  /** The local human's slot, or null in a bots-only (spectate) match. */
  localSlot: number | null;
  /** Viewer ground position (zone distance, teammate distance). */
  viewerX: number;
  viewerZ: number;
  /** Camera bearing, degrees (0 = north/+Z, 90 = east/+X). */
  headingDegrees: number;
}

interface TeammateCard {
  readonly root: HTMLDivElement;
  readonly name: Text;
  readonly status: Text;
  readonly fill: HTMLDivElement;
  readonly bleed: HTMLDivElement;
  readonly revive: HTMLDivElement;
  readonly distance: Text;
  readonly arrow: HTMLDivElement;
  slot: number;
  shown: string;
  /** Last written bar scales and arrow angle (writes only on change). */
  values: [fill: number, bleed: number, revive: number, arrow: number];
}

/**
 * Offline match HUD (docs/bots/design.md §10), minimal PUBG style: alive/teams/kills top right with the match kill feed,
 * zone timer under the compass with a zone marker on the compass tape, blue screen edge and warning outside the zone,
 * teammate cards bottom left, countdown in the centre. Text writes only happen when a shown value changes.
 */
export class MatchHud {
  readonly root: HTMLDivElement;
  private readonly alive: Text;
  private readonly teams: Text;
  private readonly kills: Text;
  private readonly feed: MatchFeed;
  private readonly zone: HTMLDivElement;
  private readonly zoneLabel: Text;
  private readonly zoneTime: Text;
  private readonly zoneBar: HTMLDivElement;
  private readonly zoneBarFill: HTMLDivElement;
  private readonly zoneWarn: Animation;
  private readonly outside: HTMLDivElement;
  private readonly outsideText: Text;
  private readonly tint: HTMLDivElement;
  private readonly marker: HTMLDivElement;
  private readonly markerDistance: Text;
  private readonly countdown: HTMLDivElement;
  private readonly countdownText: Text;
  private readonly countdownAnim: Animation;
  private readonly cards: TeammateCard[] = [];
  private readonly spectating: HTMLDivElement;
  private readonly spectatingName: Text;
  private readonly unsubscribe: () => void;
  private readonly barValue = [-1];
  private markerOffset = Number.NaN;
  private shown = { alive: -1, teams: -1, kills: -1, zoneKey: "", zoneSeconds: -1, outside: -1, marker: -1, countdown: -1, tint: -1 };

  constructor(
    parent: HTMLElement,
    private readonly view: MatchView,
    private readonly frame: MatchHudFrame,
  ) {
    this.root = el("div", "tb-mhud", undefined, parent);

    const stats = el("div", "tb-mhud__stats", undefined, this.root);
    const stat = (label: string, hidden = false): Text => {
      const node = el("div", "tb-mhud__stat", undefined, stats);
      const value = textNode(el("span", "tb-mhud__stat-value", undefined, node));
      el("span", "tb-mhud__stat-label", label, node);
      node.hidden = hidden;
      return value;
    };
    this.alive = stat(MATCH_STRINGS.hud.alive);
    // Solo: every player is a team, so the teams count would repeat "alive".
    this.teams = stat(MATCH_STRINGS.hud.teams, view.config.teamSize <= 1);
    this.kills = stat(MATCH_STRINGS.hud.kills);
    this.feed = new MatchFeed(this.root);

    this.zone = el("div", "tb-mhud__zone", undefined, this.root);
    this.zoneLabel = textNode(el("span", "tb-mhud__zone-label", undefined, this.zone));
    this.zoneTime = textNode(el("span", "tb-mhud__zone-time", undefined, this.zone));
    this.zoneBar = el("div", "tb-mhud__zone-bar", undefined, this.zone);
    this.zoneBarFill = el("div", "tb-mhud__zone-bar-fill", undefined, this.zoneBar);
    this.zoneWarn = prepareAnimation(this.zone, [{ color: "var(--tb-amber)" }, { color: "var(--tb-amber)", offset: 0.7 }, { color: "" }], { duration: 2400 });
    this.outside = el("div", "tb-mhud__outside", undefined, this.root);
    this.outsideText = textNode(this.outside);
    this.outside.hidden = true;
    this.tint = el("div", "tb-mhud__tint", undefined, this.root);

    this.marker = el("div", "tb-mhud__marker", undefined, this.root);
    el("div", "tb-mhud__marker-icon", undefined, this.marker);
    this.markerDistance = textNode(el("div", "tb-mhud__marker-distance", undefined, this.marker));
    this.marker.hidden = true;

    this.countdown = el("div", "tb-mhud__countdown", undefined, this.root);
    this.countdownText = textNode(this.countdown);
    this.countdown.hidden = true;
    this.countdownAnim = prepareAnimation(this.countdown, [{ opacity: 0, transform: "translate3d(-50%,-50%,0) scale(1.25)" }, { opacity: 1, transform: "translate3d(-50%,-50%,0) scale(1)", offset: 0.25 }, { opacity: 0.85 }], { duration: 900 });

    const team = el("div", "tb-mhud__team", undefined, this.root);
    // Up to three teammates (squads of 4).
    for (let i = 0; i < 3; i++) this.cards.push(createCard(team));

    this.spectating = el("div", "tb-mhud__spectating", undefined, this.root);
    el("span", "tb-mhud__spectating-label", "Spectating", this.spectating);
    this.spectatingName = textNode(el("span", "tb-mhud__spectating-name", undefined, this.spectating));
    el("span", "tb-mhud__spectating-hint", "[ ] switch", this.spectating);
    this.spectating.hidden = true;

    this.unsubscribe = view.onEvent((event) => this.handleEvent(event));
  }

  set visible(visible: boolean) {
    this.root.hidden = !visible;
  }

  /** Spectated actor name, or null when not spectating. */
  setSpectating(name: string | null): void {
    this.spectating.hidden = name === null;
    if (name !== null) setText(this.spectatingName, name);
  }

  nameOf = (slot: number): string => {
    if (slot === this.frame.localSlot) return "You";
    return this.view.state.actors[slot]?.name ?? `Slot ${slot}`;
  };

  teamOf = (slot: number): number => this.view.state.actors[slot]?.team ?? -1;

  /** Per frame after scene.render. */
  update(): void {
    const { state, config } = this.view;
    const frame = this.frame;
    const shown = this.shown;
    const focus = state.actors[frame.focusSlot];

    if (state.actorsInPlay !== shown.alive) setText(this.alive, String((shown.alive = state.actorsInPlay)));
    if (state.teamsInPlay !== shown.teams) setText(this.teams, String((shown.teams = state.teamsInPlay)));
    const kills = frame.localSlot !== null ? (state.actors[frame.localSlot]?.kills ?? 0) : (focus?.kills ?? 0);
    if (kills !== shown.kills) setText(this.kills, String((shown.kills = kills)));

    this.updateCountdown();
    this.updateZone(focus ?? null, config.timeScale);
    this.updateTeammates(focus ?? null);
  }

  dispose(): void {
    this.unsubscribe();
    this.root.remove();
  }

  private handleEvent(event: MatchEvent): void {
    const now = performance.now();
    const focus = this.view.state.actors[this.frame.focusSlot];
    this.feed.push(event, this.nameOf, this.teamOf, focus?.team ?? null, now);
    if (event.type === "zoneWarning" || event.type === "zoneShrinkStarted" || event.type === "zoneAnnounced") replay(this.zoneWarn);
  }

  private updateCountdown(): void {
    const state = this.view.state;
    let seconds = -1;
    if (state.phase === "warmup" && state.phaseEndTick > state.tick) seconds = Math.ceil((state.phaseEndTick - state.tick) / SIMULATION.tickRate);
    if (seconds === this.shown.countdown) return;
    this.shown.countdown = seconds;
    this.countdown.hidden = seconds <= 0;
    if (seconds > 0) {
      setText(this.countdownText, String(seconds));
      replay(this.countdownAnim);
    }
  }

  private updateZone(focus: ActorState | null, timeScale: number): void {
    const { state, config } = this.view;
    const zone = state.zone;
    const shown = this.shown;
    const frame = this.frame;

    let key: string;
    let ticks = 0;
    let progress = -1;
    if (state.phase !== "combat") {
      key = state.phase === "ended" ? "ended" : "pre";
    } else if (zone.stage === "idle") {
      key = "idle";
      ticks = state.combatStartTick + Math.round(config.zone.firstAnnounceSeconds * timeScale * SIMULATION.tickRate) - state.tick;
    } else if (zone.stage === "waiting") {
      key = "waiting";
      ticks = zone.ticksToChange;
    } else if (zone.stage === "shrinking") {
      key = "shrinking";
      ticks = zone.ticksToChange;
      const phase = zone.phase;
      if (phase) progress = clamp01(1 - ticks / Math.max(1, phase.shrinkEndTick - phase.shrinkStartTick));
    } else {
      key = "closed";
    }
    if (key !== shown.zoneKey) {
      shown.zoneKey = key;
      this.zone.hidden = key === "pre" || key === "ended";
      setText(this.zoneLabel, ZONE_LABEL[key] ?? "");
      this.zoneBar.hidden = key !== "shrinking";
      shown.zoneSeconds = -1;
    }
    const seconds = key === "idle" || key === "waiting" ? Math.max(0, Math.ceil(ticks / SIMULATION.tickRate)) : -1;
    if (seconds !== shown.zoneSeconds) {
      shown.zoneSeconds = seconds;
      setText(this.zoneTime, seconds >= 0 ? formatClock(seconds) : "");
    }
    if (progress >= 0) setScale(this.zoneBarFill, this.barValue, 0, progress);

    // Outside the current circle: warning, blue edge. Marker toward the circle that matters (next, else current).
    const x = focus ? focus.feet.x : frame.viewerX;
    const z = focus ? focus.feet.z : frame.viewerZ;
    const live = state.phase === "combat" && focus !== null && focus.life !== "dead";
    const outsideMeters = live ? distanceOutside(zone.current, x, z) : 0;
    const outside = outsideMeters > 0 ? Math.ceil(outsideMeters) : 0;
    if (outside !== shown.outside) {
      shown.outside = outside;
      this.outside.hidden = outside === 0;
      if (outside > 0) setText(this.outsideText, `Outside safe zone · ${outside} m · ${zone.dps} HP/s`);
    }
    const tint = outside > 0 ? 1 : 0;
    if (tint !== shown.tint) {
      shown.tint = tint;
      this.tint.toggleAttribute("data-on", tint === 1);
    }

    const target = zone.next ?? zone.current;
    const toTarget = live && zone.stage !== "idle" ? distanceOutside(target, x, z) : 0;
    const markerMeters = toTarget > 0 ? Math.ceil(toTarget) : -1;
    if (markerMeters !== shown.marker) {
      shown.marker = markerMeters;
      this.marker.hidden = markerMeters < 0;
      if (markerMeters >= 0) setText(this.markerDistance, `${markerMeters} m`);
    }
    if (markerMeters >= 0) {
      const bearing = Math.atan2(target.cx - x, target.cz - z) * RAD_TO_DEG;
      const offset = Math.round(compassMarkerOffset(bearing, frame.headingDegrees));
      if (offset !== this.markerOffset) {
        this.markerOffset = offset;
        this.marker.style.transform = `translate3d(${offset}px,0,0)`;
      }
    }
  }

  private updateTeammates(focus: ActorState | null): void {
    const state = this.view.state;
    const frame = this.frame;
    let used = 0;
    if (focus) {
      for (const actor of state.actors) {
        if (!actor || actor.team !== focus.team || actor.slot === focus.slot || used >= this.cards.length) continue;
        this.fillCard(this.cards[used++]!, actor, frame);
      }
    }
    for (let i = used; i < this.cards.length; i++) {
      const card = this.cards[i]!;
      if (!card.root.hidden) card.root.hidden = true;
      card.slot = -1;
    }
  }

  private fillCard(card: TeammateCard, actor: ActorState, frame: MatchHudFrame): void {
    card.root.hidden = false;
    if (card.slot !== actor.slot) {
      card.slot = actor.slot;
      card.shown = "";
      setText(card.name, actor.name);
    }
    const downed = actor.life === "downed";
    const dead = actor.life === "dead";
    const reviving = downed && actor.reviverSlot >= 0;
    const status = dead ? "DEAD" : reviving ? "REVIVING" : downed ? "KNOCKED" : "";
    if (status !== card.shown) {
      card.shown = status;
      setText(card.status, status);
      card.root.toggleAttribute("data-downed", downed);
      card.root.toggleAttribute("data-dead", dead);
    }
    const values = card.values;
    setScale(card.fill, values, 0, dead ? 0 : clamp01(actor.health / VITALS.maxHealth));
    setScale(card.bleed, values, 1, downed ? clamp01(actor.downedHealth / VITALS.downedHealth) : 0);
    setScale(card.revive, values, 2, reviving ? clamp01(actor.reviveProgress / VITALS.reviveSeconds) : 0);

    const dx = actor.feet.x - frame.viewerX;
    const dz = actor.feet.z - frame.viewerZ;
    const distance = Math.sqrt(dx * dx + dz * dz);
    const far = !dead && distance > TEAMMATE_DISTANCE_SHOWN;
    card.arrow.hidden = !far;
    if (far) {
      setText(card.distance, `${Math.round(distance)} m`);
      const relative = Math.round(Math.atan2(dx, dz) * RAD_TO_DEG - frame.headingDegrees);
      if (relative !== card.values[3]) {
        card.values[3] = relative;
        card.arrow.style.transform = `rotate(${relative}deg)`;
      }
    } else {
      setText(card.distance, "");
    }
  }
}

const ZONE_LABEL: Readonly<Record<string, string>> = {
  idle: "Play area revealed in",
  waiting: "Restricting play area in",
  shrinking: "Restricting play area",
  closed: "Final zone",
};

function createCard(parent: HTMLElement): TeammateCard {
  const root = el("div", "tb-mate", undefined, parent);
  const head = el("div", "tb-mate__head", undefined, root);
  const name = textNode(el("span", "tb-mate__name", undefined, head));
  const status = textNode(el("span", "tb-mate__status", undefined, head));
  const arrow = el("div", "tb-mate__arrow", undefined, head);
  const distance = textNode(el("span", "tb-mate__distance", undefined, head));
  const bar = el("div", "tb-mate__bar", undefined, root);
  const fill = el("div", "tb-mate__fill", undefined, bar);
  const bleed = el("div", "tb-mate__bleed", undefined, bar);
  const revive = el("div", "tb-mate__revive", undefined, root);
  root.hidden = true;
  arrow.hidden = true;
  return { root, name, status, fill, bleed, revive, distance, arrow, slot: -1, shown: "", values: [-1, -1, -1, 9999] };
}

/** Writes `scaleX` when the value moved by at least 0.5 %. */
function setScale(node: HTMLElement, values: number[], index: number, value: number): void {
  const rounded = Math.round(value * 200) / 200;
  if (values[index] === rounded) return;
  values[index] = rounded;
  node.style.transform = `scaleX(${rounded})`;
}

function distanceOutside(circle: ZoneCircle, x: number, z: number): number {
  const dx = x - circle.cx;
  const dz = z - circle.cz;
  return Math.sqrt(dx * dx + dz * dz) - circle.r;
}

export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r < 10 ? "0" : ""}${r}`;
}
