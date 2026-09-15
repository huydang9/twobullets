import { Matrix, Vector3, Viewport, type Camera, type Scene } from "@babylonjs/core";
import { remoteLifeCode } from "@twobullets/netcode/replication";
import { LifeCode } from "@twobullets/protocol/codes";
import { MAX_ENTITY_SLOTS } from "@twobullets/protocol/messages/snapshot";
import type { RemoteRoster } from "./RemoteRoster";

/** Label height above a standing teammate's feet, and above a knocked one, m. */
const STAND_HEIGHT = 2.05;
const DOWNED_HEIGHT = 0.9;
/** Labels beyond this distance are hidden, m. */
const MAX_DISTANCE = 600;
/** Up to three teammates (squads of four). */
const POOL = 3;

interface Label {
  readonly node: HTMLDivElement;
  readonly text: Text;
  slot: number;
  x: number;
  y: number;
  downed: boolean;
}

/**
 * PUBG-style names over teammates only (enemies get none): one pooled DOM label per teammate, projected from the
 * interpolated pose every frame. Writes the DOM only when a rounded pixel position, name or state changes.
 */
export class TeammateLabels {
  private readonly root: HTMLDivElement;
  private readonly labels: Label[] = [];
  private readonly world = new Vector3();
  private readonly screen = new Vector3();
  private readonly viewport = new Viewport(0, 0, 1, 1);

  constructor(
    parent: HTMLElement,
    private readonly scene: Scene,
    private readonly roster: RemoteRoster,
  ) {
    this.root = document.createElement("div");
    this.root.style.cssText = "position:absolute;inset:0;pointer-events:none;overflow:hidden";
    parent.appendChild(this.root);
    for (let i = 0; i < POOL; i++) {
      const node = document.createElement("div");
      node.className = "tb-mate-label";
      const text = node.appendChild(document.createTextNode(""));
      node.hidden = true;
      this.root.appendChild(node);
      this.labels.push({ node, text, slot: -1, x: -1, y: -1, downed: false });
    }
  }

  /** Per frame after the camera moved. `isTeammate(slot)` and `nameOf(slot)` come from the roster. */
  update(ownSlot: number, isTeammate: (slot: number) => boolean, nameOf: (slot: number) => string): void {
    const camera = this.scene.activeCamera;
    let used = 0;
    if (camera && ownSlot >= 0) {
      for (let slot = 0; slot < MAX_ENTITY_SLOTS && used < POOL; slot++) {
        if (slot === ownSlot || this.roster.visible[slot] !== 1 || !isTeammate(slot)) continue;
        const pose = this.roster.poses[slot]!;
        const life = remoteLifeCode(pose.flags);
        if (life === LifeCode.dead) continue;
        const label = this.labels[used]!;
        if (this.place(label, camera, pose.x, pose.y + (life === LifeCode.downed ? DOWNED_HEIGHT : STAND_HEIGHT), pose.z)) {
          if (label.slot !== slot) {
            label.slot = slot;
            label.text.data = nameOf(slot);
          }
          const downed = life === LifeCode.downed;
          if (downed !== label.downed) {
            label.downed = downed;
            label.node.toggleAttribute("data-downed", downed);
          }
          if (label.node.hidden) label.node.hidden = false;
          used++;
        }
      }
    }
    for (let i = used; i < POOL; i++) {
      const label = this.labels[i]!;
      if (!label.node.hidden) label.node.hidden = true;
      label.slot = -1;
    }
  }

  /** Refreshes names (roster or language change). */
  invalidate(): void {
    for (const label of this.labels) label.slot = -1;
  }

  dispose(): void {
    this.root.remove();
  }

  private place(label: Label, camera: Camera, x: number, y: number, z: number): boolean {
    const eye = camera.globalPosition;
    const dx = x - eye.x;
    const dy = y - eye.y;
    const dz = z - eye.z;
    if (dx * dx + dy * dy + dz * dz > MAX_DISTANCE * MAX_DISTANCE) return false;
    const engine = this.scene.getEngine();
    const width = engine.getRenderWidth();
    const height = engine.getRenderHeight();
    camera.viewport.toGlobalToRef(width, height, this.viewport);
    Vector3.ProjectToRef(this.world.set(x, y, z), Matrix.IdentityReadOnly, this.scene.getTransformMatrix(), this.viewport, this.screen);
    // Behind the camera or outside the depth range.
    if (this.screen.z < 0 || this.screen.z > 1) return false;
    const canvas = engine.getRenderingCanvas();
    const scaleX = canvas && width > 0 ? canvas.clientWidth / width : 1;
    const scaleY = canvas && height > 0 ? canvas.clientHeight / height : 1;
    const px = Math.round(this.screen.x * scaleX);
    const py = Math.round(this.screen.y * scaleY);
    if (px !== label.x || py !== label.y) {
      label.x = px;
      label.y = py;
      label.node.style.transform = `translate3d(${px}px,${py}px,0) translate(-50%,-100%)`;
    }
    return true;
  }
}
