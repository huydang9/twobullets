import type { FireMode } from "@twobullets/shared";
import { t, type MessageKey } from "../i18n";

const FIRE_MODE_KEY: Readonly<Record<FireMode, MessageKey>> = {
  auto: "fireMode.auto",
  semi: "fireMode.semi",
  bolt: "fireMode.bolt",
};

export function fireModeLabel(mode: FireMode): string {
  return t(FIRE_MODE_KEY[mode]);
}

/** Target kinds with a translated name; anything else keeps its id words. */
const TARGET_KEY: Readonly<Record<string, MessageKey>> = {
  dummy: "target.dummy",
  "target dummy": "target.targetDummy",
  soldier: "target.soldier",
  target: "target.fallback",
};

/** "dummy-3" / "target_dummy#12" → "Dummy" / "Target Dummy" (translated when the kind is known). */
export function targetName(targetId: string): string {
  const words = targetId
    .replace(/[-_#:.]*\d+$/, "")
    .split(/[-_#:.\s]+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1).toLowerCase());
  if (words.length === 0) return t("target.fallback");
  const name = words.join(" ");
  const key = TARGET_KEY[name.toLowerCase()];
  return key ? t(key) : name;
}
