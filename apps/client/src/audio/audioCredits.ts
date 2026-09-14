import { AUDIO_ROOT } from "./audioManifest";

interface AudioCreditsFile {
  readonly sources: readonly { readonly title: string; readonly authors: readonly string[]; readonly license: string; readonly url: string }[];
}

/** "Title by Authors (CC0) — URL" for every audio source in the generated credits.json (tools/audio/pipeline.ts). */
export async function loadAudioCredits(baseUrl: string): Promise<string[]> {
  try {
    const response = await fetch(`${baseUrl}${AUDIO_ROOT}credits.json`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const credits = (await response.json()) as AudioCreditsFile;
    return credits.sources.map((s) => `${s.title} by ${s.authors.join(", ")} (${s.license}, audio) — ${s.url}`);
  } catch (error) {
    console.warn("[credits] audio credits unavailable", error);
    return [];
  }
}
