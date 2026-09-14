/** Tiny DOM helper: creates an element with a class and optional text. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
  parent?: HTMLElement,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  parent?.appendChild(node);
  return node;
}

/** Appends an empty text node to `parent` and returns it, for cheap `data` updates. */
export function textNode(parent: HTMLElement, initial = ""): Text {
  return parent.appendChild(document.createTextNode(initial));
}
