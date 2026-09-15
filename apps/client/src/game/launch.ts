import { MAX_MATCH_PLAYERS } from "@twobullets/shared/match/teams";
import type { OfflineMatchOptions } from "../match/options";
import { devPlayerId, parseNetParam, type DevToken, type NetEndpoint } from "../net/handshake";

// How a game starts (menu/README-wiring.md): an explicit launch from the front door (networked match or practice),
// or DEV URL flags. Pure: no Babylon, no DOM, so the rules are unit-tested (test/game/launch.test.ts).

/** What the in-game match hands back to the front door when the player is done with it. */
export interface NetMatchExit {
  readonly matchId: string;
  /** "ended": the match finished (MatchEnd seen); "left": the player left early. */
  readonly reason: "ended" | "left";
}

/** Networked match from the menu (production too). */
export interface NetLaunch {
  readonly kind: "net";
  readonly wsUrl: string;
  /** Account id (join token `sub`). */
  readonly accountId: string;
  readonly teamId: number;
  /** The match's map (`v1`, `arena`, a real-world id). */
  readonly mapId: string;
  readonly matchId: string;
  /** Join tokens from server-api: the first connect reuses the connecting screen's token, rejoins fetch fresh ones. */
  readonly tokens: () => Promise<DevToken>;
  /** Called once when the player leaves the in-game result or death screen for the front door. */
  readonly onExit?: (exit: NetMatchExit) => void;
}

/** Offline practice with bots from the menu (production too). */
export interface PracticeLaunch {
  readonly kind: "practice";
  readonly options: OfflineMatchOptions;
  readonly mapId: string;
}

/** DEV: everything from the URL (`?net=`, `?bots=1`, `?map=`, `?bench=`, …). */
export interface DevLaunch {
  readonly kind: "dev";
}

export type GameLaunch = NetLaunch | PracticeLaunch | DevLaunch;

/** Networked play settings (NetGame). */
export interface NetGameConfig {
  readonly endpoint: NetEndpoint;
  /** Account id (`?netId=`, else one per tab). */
  readonly sub: string;
  /** `?team=0..19` (default 0); the server puts you on the first team with room when it is full or out of range. */
  readonly team: number;
  readonly avatar: "soldier" | "capsule";
  /** DEV `?debug=hitboxes`: shared rig vs bone-driven hitboxes on remote players. */
  readonly debugHitboxes: boolean;
  /** Join token source; null = the server's `/dev/token` (DEV `?net=`). */
  readonly tokens?: (() => Promise<DevToken>) | null;
  /** Match id for the front door hand-off ("" in DEV). */
  readonly matchId?: string;
  /** DEV `&zoneScale=`: expected zone time scale before the first zone phase is announced (the server's `--time-scale`). */
  readonly zoneTimeScale?: number;
  readonly onExit?: ((exit: NetMatchExit) => void) | null;
}

/** `?net=ws://localhost:7350/m/local[&team=1][&netId=alice][&netAvatar=capsule][&debug=hitboxes][&zoneScale=0.25]`, or null. */
export function readNetConfig(params: URLSearchParams): NetGameConfig | null {
  const net = params.get("net");
  if (!net) return null;
  const team = Number(params.get("team") ?? 0);
  const zoneScale = Number(params.get("zoneScale"));
  return {
    endpoint: parseNetParam(net),
    sub: devPlayerId(params.get("netId")),
    team: Number.isInteger(team) && team >= 0 && team < MAX_MATCH_PLAYERS ? team : 0,
    avatar: params.get("netAvatar") === "capsule" ? "capsule" : "soldier",
    debugHitboxes: (params.get("debug") ?? "").split(",").includes("hitboxes"),
    tokens: null,
    matchId: "",
    zoneTimeScale: zoneScale > 0 && zoneScale <= 10 ? zoneScale : 1,
    onExit: null,
  };
}

/** What Game.create builds, resolved from a launch and the URL. */
export interface ResolvedLaunch {
  /** Networked play, or null offline. */
  readonly net: NetGameConfig | null;
  /** Offline bot match options (`enabled` false: no match). */
  readonly practice: OfflineMatchOptions | null;
  /** Map to load; null = the blockout arena. */
  readonly mapId: string | null;
  /** DEV `?bench=`. */
  readonly benchmark: string | null;
}

/**
 * The single place that decides the game mode:
 * - `net`: networked on the match's map, whatever the URL says.
 * - `practice`: offline bot match on its map.
 * - `dev` (DEV builds only): `?bench=v1` (implies `?map=v1`), `?net=` (optionally `&map=`, default arena, the server's
 *   `--map`), `?bots=1` (implies `?map=v1`), `?map=`; nothing = the arena. Production ignores URL flags.
 */
export function resolveLaunch(launch: GameLaunch, search: string, dev: boolean, readPractice: (search: string, dev: boolean) => OfflineMatchOptions): ResolvedLaunch {
  const params = new URLSearchParams(search);
  if (launch.kind === "net") {
    const config: NetGameConfig = {
      endpoint: parseNetParam(launch.wsUrl),
      sub: launch.accountId,
      team: launch.teamId,
      avatar: "soldier",
      debugHitboxes: false,
      tokens: launch.tokens,
      matchId: launch.matchId,
      zoneTimeScale: 1,
      onExit: launch.onExit ?? null,
    };
    return { net: config, practice: null, mapId: launch.mapId || null, benchmark: null };
  }
  if (launch.kind === "practice") {
    return { net: null, practice: { ...launch.options, enabled: true }, mapId: launch.mapId || "v1", benchmark: null };
  }
  if (!dev) return { net: null, practice: null, mapId: null, benchmark: null };
  const benchmark = params.get("bench");
  const net = benchmark ? null : readNetConfig(params);
  const practice = readPractice(search, dev);
  const bots = !benchmark && !net && practice.enabled;
  const mapId = benchmark === "v1" ? "v1" : (params.get("map") ?? (bots ? "v1" : null));
  return { net, practice: bots ? practice : null, mapId, benchmark };
}
