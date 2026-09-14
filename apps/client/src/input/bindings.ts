/** Game actions mapped to KeyboardEvent.code values (layout-independent physical keys). */
export const KEY_BINDINGS = {
  forward: ["KeyW"],
  back: ["KeyS"],
  left: ["KeyA"],
  right: ["KeyD"],
  jump: ["Space"],
  sprint: ["ShiftLeft"],
  // No ControlLeft: Ctrl+W (crouch-walk) closes the tab and can't be blocked outside fullscreen Keyboard Lock.
  crouch: ["KeyC"],
} as const satisfies Record<string, readonly string[]>;

export type Action = keyof typeof KEY_BINDINGS;

/** Keys whose browser default (scrolling, focus moves, find, bookmarks...) is suppressed while pointer-locked. */
export const GAME_KEYS: ReadonlySet<string> = new Set<string>([...Object.values(KEY_BINDINGS).flat(), "Tab"]);
