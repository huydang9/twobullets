import type { Scene } from "@babylonjs/core";
import type { AssetLibrary } from "../assets";
import type { InputManager } from "../input/InputManager";
import type { PlayerController } from "../player/PlayerController";
import { NetDebugHud } from "../ui/NetDebugHud";
import type { Environment } from "../world/environment";
import { devPlayerId, fetchDevToken, parseNetParam, type NetEndpoint } from "./handshake";
import { LocalPlayerNet } from "./LocalPlayerNet";
import { NetClient } from "./NetClient";
import { NetClock, WS_BUFFER_TICKS } from "./NetClock";
import { NET_MOVEMENT } from "./netMovement";
import { RemotePlayers } from "./RemotePlayers";
import { RemoteRoster } from "./RemoteRoster";
import { openTransport } from "./transportPolicy";

export { NET_MOVEMENT };

export interface NetGameConfig {
  readonly endpoint: NetEndpoint;
  /** Dev account id (`?netId=`, else one per tab). */
  readonly sub: string;
  /** `?team=0..4` (default 0; two players fit one team). */
  readonly team: number;
  readonly avatar: "soldier" | "capsule";
}

/** `?net=ws://localhost:7350/m/local[&team=1][&netId=alice][&netAvatar=capsule]`, or null for offline play. */
export function readNetConfig(params: URLSearchParams): NetGameConfig | null {
  const net = params.get("net");
  if (!net) return null;
  const team = Number(params.get("team") ?? 0);
  return {
    endpoint: parseNetParam(net),
    sub: devPlayerId(params.get("netId")),
    team: Number.isInteger(team) && team >= 0 && team <= 4 ? team : 0,
    avatar: params.get("netAvatar") === "capsule" ? "capsule" : "soldier",
  };
}

/**
 * Networked play wiring for Game (M3: server-authoritative movement only). Create before the PlayerController (its
 * clock), `attach` after, then `connect`. Per frame: `update` before `player.update`, `lateUpdate` after.
 */
export class NetGame {
  readonly config: NetGameConfig;
  readonly clock: NetClock;
  readonly roster = new RemoteRoster();
  private local: LocalPlayerNet | null = null;
  private remotes: RemotePlayers | null = null;
  private hud: NetDebugHud | null = null;
  private player: PlayerController | null = null;
  private clientValue: NetClient | null = null;
  private connecting = false;

  constructor(config: NetGameConfig) {
    this.config = config;
    this.clock = new NetClock({ bufferTicks: WS_BUFFER_TICKS });
  }

  get client(): NetClient | null {
    return this.clientValue;
  }

  get localNet(): LocalPlayerNet | null {
    return this.local;
  }

  attach(
    scene: Scene,
    player: PlayerController,
    input: InputManager,
    hudRoot: HTMLElement,
    soldiers: { readonly assets: AssetLibrary; readonly environment: Environment } | null,
  ): void {
    this.player = player;
    this.local = new LocalPlayerNet(player);
    this.remotes = new RemotePlayers(scene, this.roster, { soldiers: this.config.avatar === "soldier" ? soldiers : null });
    this.hud = new NetDebugHud(hudRoot, input);
    player.onTick.add((tick) => this.clientValue?.onPredictedTick(tick.playerInput));
    window.addEventListener("beforeunload", () => this.clientValue?.disconnect());
  }

  /** Fetches a fresh single-use dev token, opens the transport and starts the handshake. Safe to call again to rejoin. */
  async connect(): Promise<void> {
    const player = this.player;
    const local = this.local;
    if (!player || !local || this.connecting) return;
    this.connecting = true;
    this.clientValue?.disconnect();
    this.clientValue = null;
    this.clock.stop();
    this.roster.clear();
    this.hud?.showError("Connecting to match server…");
    try {
      const { endpoint, sub, team } = this.config;
      const token = await fetchDevToken(endpoint, sub, team);
      const transport = await openTransport(endpoint.wsUrl);
      const client = new NetClient(transport.session, {
        clock: performance,
        netClock: this.clock,
        local,
        inputs: player.inputHistory,
        roster: this.roster,
        joinToken: token.token,
        fallbackReason: transport.fallbackReason,
        onStateChange: (state, c) => console.info(`[net] ${state}${state === "disconnected" ? `: ${c.stats.disconnectReason}` : ""}`),
      });
      transport.onClose((code) => client.handleTransportClosed(code));
      this.clientValue = client;
      client.start();
      console.info(`[net] ${transport.kind} ${endpoint.wsUrl} as ${sub} (team ${team})`);
    } catch (error) {
      console.error("[net] connect failed", error);
      this.hud?.showError(`Cannot reach match server: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.connecting = false;
    }
  }

  disconnect(): void {
    this.clientValue?.disconnect();
  }

  update(dt: number): void {
    this.clientValue?.update(dt);
  }

  lateUpdate(dt: number): void {
    this.remotes?.update(dt);
    const client = this.clientValue;
    if (client) this.hud?.update(client.stats, performance.now());
  }

  dispose(): void {
    this.disconnect();
    this.remotes?.dispose();
    this.hud?.dispose();
  }
}
