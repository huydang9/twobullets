import { onLanguageChange, t } from "./core";
import { templateParts, type MessageParams } from "./format";
import type { MessageKey } from "./vi";

// Static labels remember their key in data attributes and are rewritten by one document query after a language switch,
// so nodes removed from the DOM need no unsubscribe. Dynamic text (values that change while playing) is cached by its
// component, which listens to `onLanguageChange` and clears the cache instead.

const TEXT_ATTR = "data-i18n";
const PARAMS_ATTR = "data-i18n-params";
const TITLE_ATTR = "data-i18n-title";
const TITLE_PARAMS_ATTR = "data-i18n-title-params";

/** Sets `node`'s text to `t(key, params)` and keeps it translated. */
export function bindText<T extends HTMLElement>(node: T, key: MessageKey, params?: MessageParams): T {
  node.setAttribute(TEXT_ATTR, key);
  if (params) node.setAttribute(PARAMS_ATTR, JSON.stringify(params));
  else node.removeAttribute(PARAMS_ATTR);
  node.textContent = t(key, params);
  return node;
}

/** Plain text that should no longer follow a key (e.g. a caller-provided label replacing a default). */
export function unbindText(node: HTMLElement, text: string): void {
  node.removeAttribute(TEXT_ATTR);
  node.removeAttribute(PARAMS_ATTR);
  node.textContent = text;
}

/** Sets `node.title` to `t(key, params)` and keeps it translated. */
export function bindTitle(node: HTMLElement, key: MessageKey, params?: MessageParams): void {
  node.setAttribute(TITLE_ATTR, key);
  if (params) node.setAttribute(TITLE_PARAMS_ATTR, JSON.stringify(params));
  node.title = t(key, params);
}

/** Rewrites every bound label under `root`. Runs on each language switch. */
export function translateDom(root: ParentNode = document): void {
  for (const node of root.querySelectorAll<HTMLElement>(`[${TEXT_ATTR}]`)) {
    node.textContent = t(node.getAttribute(TEXT_ATTR) as MessageKey, readParams(node, PARAMS_ATTR));
  }
  for (const node of root.querySelectorAll<HTMLElement>(`[${TITLE_ATTR}]`)) {
    node.title = t(node.getAttribute(TITLE_ATTR) as MessageKey, readParams(node, TITLE_PARAMS_ATTR));
  }
}

/**
 * Fills `parent` with a template whose placeholders are DOM nodes: "{you} killed {victim} with {weapon}" with a
 * highlighted span per name. Slot nodes are reused, so a re-render after a language switch keeps their references.
 */
export function renderTemplate(parent: HTMLElement, template: string, slots: Readonly<Record<string, Node>>): void {
  parent.replaceChildren();
  for (const part of templateParts(template)) {
    if ("text" in part) parent.append(part.text);
    else parent.append(slots[part.param] ?? `{${part.param}}`);
  }
}

function readParams(node: HTMLElement, attr: string): MessageParams | undefined {
  const raw = node.getAttribute(attr);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as MessageParams;
  } catch {
    return undefined;
  }
}

if (typeof document !== "undefined") onLanguageChange(() => translateDom());
