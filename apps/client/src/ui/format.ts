import type { FireMode } from "@twobullets/shared";

export const FIRE_MODE_LABEL: Readonly<Record<FireMode, string>> = {
  auto: "AUTO",
  semi: "SINGLE",
  bolt: "BOLT",
};

/** "dummy-3" / "target_dummy#12" → "Dummy" / "Target Dummy". */
export function targetName(targetId: string): string {
  const words = targetId
    .replace(/[-_#:.]*\d+$/, "")
    .split(/[-_#:.\s]+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1).toLowerCase());
  return words.length > 0 ? words.join(" ") : "Target";
}
