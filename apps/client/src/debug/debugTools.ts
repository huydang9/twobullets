import type { Scene } from "@babylonjs/core";
import type { InputManager } from "../input/InputManager";
import type { Hud } from "../ui/Hud";
import { InspectorToggle } from "./inspector";
import { PhysicsDebugView } from "./physicsDebug";

export interface DebugToolsOptions {
  /** Enables the F3 stats toggle and hides the play overlay while the inspector is open. */
  readonly hud?: Hud;
}

const KEY_STATS = "F3";
const KEY_PHYSICS = "F8";
const KEY_INSPECTOR = "F9";
const DEBUG_KEYS: ReadonlySet<string> = new Set([KEY_STATS, KEY_PHYSICS, KEY_INSPECTOR]);

/** F3 stats panel, F8 physics shapes, F9 Babylon Inspector. Hotkeys are polled through the shared InputManager. */
export function installDebugTools(scene: Scene, input: InputManager, options: DebugToolsOptions = {}): void {
  const { hud } = options;
  const physics = new PhysicsDebugView(scene);
  const inspector = new InspectorToggle(scene, (open) => hud?.setInspectorOpen(open));

  // Suppress browser defaults (F3 = find, etc.). Input state itself is read via InputManager below.
  window.addEventListener(
    "keydown",
    (event) => {
      if (DEBUG_KEYS.has(event.code)) event.preventDefault();
    },
    { capture: true },
  );

  scene.onBeforeRenderObservable.add(() => {
    if (input.wasPressed(KEY_STATS)) hud?.toggleStats();
    if (input.wasPressed(KEY_PHYSICS)) physics.toggle();
    if (input.wasPressed(KEY_INSPECTOR)) void inspector.toggle();
  });
}
