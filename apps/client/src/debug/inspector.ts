import type { Scene } from "@babylonjs/core";
import type { InspectorToken } from "@babylonjs/inspector";

/**
 * Lazily loads the Babylon Inspector (v9 `ShowInspector` API) on first open, keeping it out of the main bundle.
 * `onChange` also fires when the inspector is closed from its own UI.
 */
export class InspectorToggle {
  private token: InspectorToken | null = null;
  private loading = false;

  constructor(
    private readonly scene: Scene,
    private readonly onChange: (open: boolean) => void,
  ) {}

  async toggle(): Promise<void> {
    if (this.loading) return;
    if (this.token) {
      await this.token.dispose();
      return;
    }

    this.loading = true;
    // Report "open" before the (slow) chunk load so the play overlay doesn't flash up when the lock is released.
    this.onChange(true);
    if (document.pointerLockElement) document.exitPointerLock();
    try {
      const { ShowInspector } = await import("@babylonjs/inspector");
      const token = ShowInspector(this.scene);
      this.token = token;
      token.onDisposed.addOnce(() => {
        if (this.token === token) this.token = null;
        this.onChange(false);
      });
    } catch (error) {
      console.error("[debug] Failed to load Babylon Inspector", error);
      this.onChange(false);
    } finally {
      this.loading = false;
    }
  }
}
