/**
 * Creates an idle Web Animation for `target`. Replaying it with {@link replay} restarts it from the first frame
 * without allocating new Animation objects or forcing a style flush (unlike the remove-class/reflow/add-class trick).
 * Animate only `transform`/`opacity` so playback stays on the compositor.
 */
export function prepareAnimation(
  target: Element,
  keyframes: Keyframe[],
  options: KeyframeAnimationOptions,
): Animation {
  const animation = target.animate(keyframes, options);
  animation.cancel();
  return animation;
}

/** Restarts an animation from its beginning, whether idle, running or finished. */
export function replay(animation: Animation): void {
  animation.currentTime = 0;
  animation.play();
}

/** Writes an element's text only when it changed. */
export function setText(node: Text, value: string): void {
  if (node.data !== value) node.data = value;
}

/** Snaps a CSS px value to the device pixel grid so thin lines stay crisp. */
export function snapToDevicePixel(value: number): number {
  const dpr = window.devicePixelRatio || 1;
  return Math.round(value * dpr) / dpr;
}

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
