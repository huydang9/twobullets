import { PhysicsViewer, type Scene, type TransformNode } from "@babylonjs/core";

const RESCAN_INTERVAL_MS = 1000;

/** Renders Havok collision shapes for every physics body; picks up bodies created after it was enabled. */
export class PhysicsDebugView {
  private viewer: PhysicsViewer | null = null;
  private lastScan = 0;

  constructor(private readonly scene: Scene) {
    scene.onBeforeRenderObservable.add(() => {
      if (!this.viewer) return;
      const now = performance.now();
      if (now - this.lastScan >= RESCAN_INTERVAL_MS) this.scan(this.viewer, now);
    });
  }

  toggle(): void {
    if (this.viewer) {
      this.viewer.dispose();
      this.viewer = null;
      return;
    }
    this.viewer = new PhysicsViewer(this.scene);
    this.scan(this.viewer, performance.now());
  }

  private scan(viewer: PhysicsViewer, now: number): void {
    this.lastScan = now;
    // showBody() is a no-op for bodies already shown; the viewer drops disposed bodies itself.
    for (const node of this.scene.meshes) showBodyOf(viewer, node);
    for (const node of this.scene.transformNodes) showBodyOf(viewer, node);
  }
}

function showBodyOf(viewer: PhysicsViewer, node: TransformNode): void {
  const body = node.physicsBody;
  if (body && !body.isDisposed) viewer.showBody(body);
}
