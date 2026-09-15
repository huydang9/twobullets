import { Matrix, Vector3, Viewport, type Camera } from "@babylonjs/core";
import type { HitZone } from "@twobullets/shared";
import { prepareAnimation, replay, setText } from "./anim";
import { el, elT, textNode } from "./dom";

const POOL_SIZE = 24;
const LIFETIME_MS = 800;
/** Hits on the same target within this window add into one growing number. */
const MERGE_WINDOW_MS = 350;
/** Random horizontal scatter for new numbers so consecutive targets' numbers don't stack exactly, CSS px. */
const SCATTER_PX = 18;
/** Points closer than this in front of the eye (clip w, ≈ view depth) are treated as behind the camera. */
const MIN_DEPTH = 0.05;

const RISE_KEYFRAMES: Keyframe[] = [
  { transform: "translate3d(0,0,0) scale(1.6)", opacity: 1, easing: "cubic-bezier(.2,1.4,.4,1)" },
  { transform: "translate3d(0,-10px,0) scale(1)", opacity: 1, offset: 0.18, easing: "linear" },
  { transform: "translate3d(0,-26px,0) scale(1)", opacity: 1, offset: 0.6, easing: "ease-in" },
  { transform: "translate3d(0,-46px,0) scale(0.85)", opacity: 0 },
];

interface Popup {
  readonly root: HTMLDivElement;
  readonly text: Text;
  readonly rise: Animation;
  readonly world: Vector3;
  targetId: string;
  amount: number;
  zone: HitZone;
  killed: boolean;
  bornAt: number;
  lastHitAt: number;
  scatter: number;
  alive: boolean;
  x: number;
  y: number;
}

export interface DamageHit {
  readonly targetId: string;
  readonly zone: HitZone;
  readonly amount: number;
  readonly killed: boolean;
  readonly point: Vector3;
}

const ZONE_RANK: Readonly<Record<HitZone, number>> = { limb: 0, body: 1, head: 2 };

/** Floating damage numbers anchored at world hit points, projected to the screen every frame from a fixed pool. */
export class DamageNumbers {
  private readonly pool: Popup[] = [];
  private readonly projected = new Vector3();
  private readonly viewport = new Viewport(0, 0, 1, 1);
  private liveCount = 0;

  constructor(parent: HTMLElement) {
    const layer = el("div", "tb-dmg-layer", undefined, parent);
    for (let i = 0; i < POOL_SIZE; i++) {
      const root = el("div", "tb-dmg", undefined, layer);
      const body = el("div", "tb-dmg__body", undefined, root);
      const label = el("div", "tb-dmg__label", undefined, body);
      const text = textNode(label);
      elT("div", "tb-dmg__tag", "hud.kill", label);
      root.hidden = true;
      this.pool.push({
        root,
        text,
        rise: prepareAnimation(body, RISE_KEYFRAMES, { duration: LIFETIME_MS }),
        world: new Vector3(),
        targetId: "",
        amount: 0,
        zone: "body",
        killed: false,
        bornAt: 0,
        lastHitAt: 0,
        scatter: 0,
        alive: false,
        x: Number.NaN,
        y: Number.NaN,
      });
    }
  }

  /** @param now performance.now() timestamp, ms. */
  add(hit: DamageHit, now: number): void {
    let popup = this.findMergeTarget(hit.targetId, now);
    if (popup) {
      popup.amount += hit.amount;
      if (ZONE_RANK[hit.zone] > ZONE_RANK[popup.zone]) popup.zone = hit.zone;
    } else {
      popup = this.acquire();
      popup.targetId = hit.targetId;
      popup.amount = hit.amount;
      popup.zone = hit.zone;
      popup.killed = false;
      popup.scatter = (Math.random() * 2 - 1) * SCATTER_PX;
      popup.x = popup.y = Number.NaN;
      popup.root.removeAttribute("data-kill");
      if (!popup.alive) {
        popup.alive = true;
        this.liveCount++;
      }
    }

    if (popup.root.dataset.zone !== popup.zone) popup.root.dataset.zone = popup.zone;
    if (hit.killed) {
      popup.killed = true;
      popup.root.setAttribute("data-kill", "");
    }
    popup.world.copyFrom(hit.point);
    popup.bornAt = popup.lastHitAt = now;
    setText(popup.text, Math.round(popup.amount).toString());
    replay(popup.rise);
  }

  /**
   * Re-projects live numbers. Call after the scene has rendered so the camera matrices are current.
   * @param cssPerRenderPixel CSS px per render-target px (Babylon's hardware scaling level).
   */
  update(
    now: number,
    camera: Camera | null,
    renderWidth: number,
    renderHeight: number,
    cssPerRenderPixel: number,
  ): void {
    if (this.liveCount === 0) return;
    const transform = camera?.getTransformationMatrix();
    if (camera) camera.viewport.toGlobalToRef(renderWidth, renderHeight, this.viewport);

    for (let i = 0; i < this.pool.length; i++) {
      const popup = this.pool[i]!;
      if (!popup.alive) continue;
      if (now - popup.bornAt >= LIFETIME_MS) {
        this.release(popup);
        continue;
      }
      if (!transform) continue;

      const p = popup.world;
      const m = transform.m;
      const w = p.x * m[3]! + p.y * m[7]! + p.z * m[11]! + m[15]!;
      if (w < MIN_DEPTH) {
        if (!popup.root.hidden) popup.root.hidden = true;
        continue;
      }
      Vector3.ProjectToRef(p, Matrix.IdentityReadOnly, transform, this.viewport, this.projected);
      if (popup.root.hidden) popup.root.hidden = false;

      // Round to whole CSS px: avoids restyling for sub-pixel jitter while the camera is still.
      const x = Math.round(this.projected.x * cssPerRenderPixel + popup.scatter);
      const y = Math.round(this.projected.y * cssPerRenderPixel);
      if (x !== popup.x || y !== popup.y) {
        popup.x = x;
        popup.y = y;
        popup.root.style.transform = `translate3d(${x}px,${y}px,0)`;
      }
    }
  }

  private findMergeTarget(targetId: string, now: number): Popup | undefined {
    for (const popup of this.pool) {
      if (popup.alive && !popup.killed && popup.targetId === targetId && now - popup.lastHitAt < MERGE_WINDOW_MS) {
        return popup;
      }
    }
    return undefined;
  }

  /** A free popup, or the oldest live one when the pool is exhausted. */
  private acquire(): Popup {
    let oldest = this.pool[0]!;
    for (const popup of this.pool) {
      if (!popup.alive) return popup;
      if (popup.bornAt < oldest.bornAt) oldest = popup;
    }
    return oldest;
  }

  private release(popup: Popup): void {
    popup.alive = false;
    popup.root.hidden = true;
    popup.rise.cancel();
    this.liveCount--;
  }
}
