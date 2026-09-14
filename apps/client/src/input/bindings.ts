/** Mouse buttons are tracked alongside keys under these pseudo-codes (MouseEvent.button 0 = left, 2 = right). */
export const MOUSE_LEFT = "Mouse0";
export const MOUSE_RIGHT = "Mouse2";

/** Game actions mapped to KeyboardEvent.code values (layout-independent physical keys) or mouse pseudo-codes. */
export const KEY_BINDINGS = {
  forward: ["KeyW"],
  back: ["KeyS"],
  left: ["KeyA"],
  right: ["KeyD"],
  jump: ["Space"],
  sprint: ["ShiftLeft"],
  // No ControlLeft: Ctrl+W (crouch-walk) closes the tab and can't be blocked outside fullscreen Keyboard Lock.
  crouch: ["KeyC"],
  fire: [MOUSE_LEFT],
  aim: [MOUSE_RIGHT],
  reload: ["KeyR"],
  slot1: ["Digit1"],
  slot2: ["Digit2"],
  slot3: ["Digit3"],
  slot4: ["Digit4"],
} as const satisfies Record<string, readonly string[]>;

export type Action = keyof typeof KEY_BINDINGS;

/** Keys whose browser default (scrolling, focus moves, find, bookmarks...) is suppressed while pointer-locked. */
export const GAME_KEYS: ReadonlySet<string> = new Set<string>([...Object.values(KEY_BINDINGS).flat(), "Tab"]);
