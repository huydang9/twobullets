// Upstream audio sources: where they come from, how big they are, and who to credit.
// Licenses were checked on each page (2026-09-14). Only CC0 is used, so nothing here requires attribution,
// but every shipped file is still credited in apps/client/public/assets/audio/credits.json.
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
/** Raw downloads and extracted archives (gitignored). */
export const SRC_DIR = path.join(REPO_ROOT, "assets-src/audio");
export const DOWNLOAD_DIR = path.join(SRC_DIR, "downloads");
export const EXTRACT_DIR = path.join(SRC_DIR, "sources");
/** Web-ready outputs served by Vite from /assets/audio/. */
export const OUT_DIR = path.join(REPO_ROOT, "apps/client/public/assets/audio");
/** Generated typed manifest consumed by apps/client/src/audio. */
export const MANIFEST_TS = path.join(REPO_ROOT, "apps/client/src/audio/audioManifest.ts");

export type SourceId =
  | "ffsl"
  | "kenneyImpact"
  | "fantozziSteps"
  | "snowGravelSteps"
  | "parkWind"
  | "parkBirds"
  | "isaiahBirds"
  | "lfaClicks3"
  | "lfaClicks2"
  | "handgunReload"
  | "shotgunReload"
  | "rifleReload"
  | "swishes"
  | "bangs"
  | "distantExplosion"
  | "fireCrackle"
  | "glassBreak"
  | "breakingFalling"
  | "sfx100";

export interface AudioSource {
  readonly id: SourceId;
  readonly title: string;
  readonly authors: readonly string[];
  readonly license: "CC0";
  readonly page: string;
  readonly url: string;
  readonly file: string;
  /** Content-Length the server must report; a mismatch means the upstream file changed. */
  readonly bytes: number;
  /** Only the first N bytes are fetched (long WAV field recordings; a truncated WAV still decodes). */
  readonly rangeBytes?: number;
  readonly archive?: "7z" | "zip";
}

export const SOURCES: readonly AudioSource[] = [
  {
    id: "ffsl",
    title: "The Free Firearm Sound Library (Prepared SFX Library)",
    authors: ["Ben Jaszczak", "Brian Nelson", "Kevin Heras", "Matthew Nanney"],
    license: "CC0",
    page: "https://opengameart.org/content/the-free-firearm-sound-library",
    url: "https://opengameart.org/sites/default/files/Prepared%20SFX%20Library.7z",
    file: "free-firearm-sound-library.7z",
    bytes: 193_954_738,
    archive: "7z",
  },
  {
    id: "kenneyImpact",
    title: "Impact Sounds",
    authors: ["Kenney (www.kenney.nl)"],
    license: "CC0",
    page: "https://kenney.nl/assets/impact-sounds",
    url: "https://kenney.nl/media/pages/assets/impact-sounds/87b4ddecda-1677589768/kenney_impact-sounds.zip",
    file: "kenney_impact-sounds.zip",
    bytes: 800_850,
    archive: "zip",
  },
  {
    id: "fantozziSteps",
    title: "Fantozzi's Footsteps (Grass/Sand & Stone)",
    authors: ["Fantozzi", "qubodup (extraction)"],
    license: "CC0",
    page: "https://opengameart.org/content/fantozzis-footsteps-grasssand-stone",
    url: "https://opengameart.org/sites/default/files/Fantozzi-footsteps.7z",
    file: "Fantozzi-footsteps.7z",
    bytes: 476_363,
    archive: "7z",
  },
  {
    id: "snowGravelSteps",
    title: "42 Snow and Gravel Footsteps",
    authors: ["Corsica_S", "Iwan Gabovitch (extraction)"],
    license: "CC0",
    page: "https://opengameart.org/content/42-snow-and-gravel-footsteps",
    url: "https://opengameart.org/sites/default/files/corsica_s-walking_in_snow.7z",
    file: "corsica_s-walking_in_snow.7z",
    bytes: 4_041_779,
    archive: "7z",
  },
  {
    id: "parkWind",
    title: "Park ambiences (park_ambience_wind)",
    authors: ["Thimras"],
    license: "CC0",
    page: "https://opengameart.org/content/park-ambiences",
    url: "https://opengameart.org/sites/default/files/park_ambience_wind.wav",
    file: "park_ambience_wind.wav",
    bytes: 73_960_096,
    // 48 kHz / 24-bit stereo: 24 MB ≈ 83 s, plenty for a 30 s loop.
    rangeBytes: 24_000_000,
  },
  {
    id: "parkBirds",
    title: "Park ambiences (park_ambience_birds)",
    authors: ["Thimras"],
    license: "CC0",
    page: "https://opengameart.org/content/park-ambiences",
    url: "https://opengameart.org/sites/default/files/park_ambience_birds.wav",
    file: "park_ambience_birds.wav",
    bytes: 86_190_432,
    // 48 kHz / 16-bit stereo: 24 MB ≈ 125 s.
    rangeBytes: 24_000_000,
  },
  {
    id: "isaiahBirds",
    title: "Ambient Bird Sounds",
    authors: ["isaiah658"],
    license: "CC0",
    page: "https://opengameart.org/content/ambient-bird-sounds",
    url: "https://opengameart.org/sites/default/files/birds-isaiah658.ogg",
    file: "birds-isaiah658.ogg",
    bytes: 544_669,
  },
  {
    id: "lfaClicks3",
    title: "equipment clicks III (bolt-action rifle, stapler, tape measure)",
    authors: ["LFA"],
    license: "CC0",
    page: "https://opengameart.org/content/equipment-clicks-iii",
    url: "https://opengameart.org/sites/default/files/equipment_clicks3.wav",
    file: "equipment_clicks3.wav",
    bytes: 2_021_420,
  },
  {
    id: "lfaClicks2",
    title: "Equipment Clicks II",
    authors: ["LFA"],
    license: "CC0",
    page: "https://opengameart.org/content/equipment-clicks-ii",
    url: "https://opengameart.org/sites/default/files/equipmentclicks.wav",
    file: "equipmentclicks.wav",
    bytes: 499_332,
  },
  {
    id: "handgunReload",
    title: "Handgun Reload Sound Effect",
    authors: ["zer0_sol"],
    license: "CC0",
    page: "https://opengameart.org/content/handgun-reload-sound-effect",
    url: "https://opengameart.org/sites/default/files/reload.wav",
    file: "handgun-reload.wav",
    bytes: 280_620,
  },
  {
    id: "shotgunReload",
    title: "Shotgun Reload Sound effects",
    authors: ["zer0_sol"],
    license: "CC0",
    page: "https://opengameart.org/content/shotgun-reload-sound-effects",
    url: "https://opengameart.org/sites/default/files/shotgunsounds.zip",
    file: "shotgunsounds.zip",
    bytes: 324_193,
    archive: "zip",
  },
  {
    id: "rifleReload",
    title: "Gun reload sounds (assaultriflereload1)",
    authors: ["SpringySpringo"],
    license: "CC0",
    page: "https://opengameart.org/content/gun-reload-sounds",
    url: "https://opengameart.org/sites/default/files/assaultriflereload1_0.wav",
    file: "assaultriflereload1.wav",
    bytes: 274_476,
  },
  {
    id: "swishes",
    title: "Swishes Sound Pack",
    authors: ["artisticdude"],
    license: "CC0",
    page: "https://opengameart.org/content/swishes-sound-pack",
    url: "https://opengameart.org/sites/default/files/swishes.zip",
    file: "swishes.zip",
    bytes: 385_150,
    archive: "zip",
  },
  // --- Equipment (grenades, molotov, consumables). Checked 2026-09-14.
  {
    id: "bangs",
    title: "25 CC0 bang / firework SFX",
    authors: ["rubberduck"],
    license: "CC0",
    page: "https://opengameart.org/content/25-cc0-bang-firework-sfx",
    url: "https://opengameart.org/sites/default/files/25-CC0-bang-sfx.zip",
    file: "25-CC0-bang-sfx.zip",
    bytes: 1_390_498,
    archive: "zip",
  },
  {
    id: "distantExplosion",
    title: "Muffled Distant Explosion",
    authors: ["NenadSimic"],
    license: "CC0",
    page: "https://opengameart.org/content/muffled-distant-explosion",
    url: "https://opengameart.org/sites/default/files/NenadSimic%20-%20Muffled%20Distant%20Explosion.wav",
    file: "muffled-distant-explosion.wav",
    bytes: 907_518,
  },
  {
    id: "fireCrackle",
    title: "Fire Crackling",
    authors: ["AntumDeluge"],
    license: "CC0",
    page: "https://opengameart.org/content/fire-crackling",
    url: "https://opengameart.org/sites/default/files/fire-1.wav",
    file: "fire-crackling.wav",
    bytes: 253_232,
  },
  {
    id: "glassBreak",
    title: "Glass Break",
    authors: ["Till Behrend"],
    license: "CC0",
    page: "https://opengameart.org/content/glass-break",
    url: "https://opengameart.org/sites/default/files/glass_breaking.wav",
    file: "glass-breaking.wav",
    bytes: 230_924,
  },
  {
    id: "breakingFalling",
    title: "75 CC0 breaking / falling / hit sfx",
    authors: ["rubberduck"],
    license: "CC0",
    page: "https://opengameart.org/content/75-cc0-breaking-falling-hit-sfx",
    url: "https://opengameart.org/sites/default/files/sfx_breaking_and_falling.zip",
    file: "sfx_breaking_and_falling.zip",
    bytes: 1_624_406,
    archive: "zip",
  },
  {
    id: "sfx100",
    title: "100 CC0 SFX",
    authors: ["rubberduck"],
    license: "CC0",
    page: "https://opengameart.org/content/100-cc0-sfx",
    url: "https://opengameart.org/sites/default/files/100-CC0-SFX_0.zip",
    file: "100-CC0-SFX.zip",
    bytes: 2_921_904,
    archive: "zip",
  },
];

/** Hard cap on what the fetch step will download in total, as a guard against a wrong URL. */
export const MAX_DOWNLOAD_BYTES = 300_000_000;

export function sourceById(id: SourceId): AudioSource {
  const source = SOURCES.find((s) => s.id === id);
  if (!source) throw new Error(`Unknown audio source ${id}`);
  return source;
}
