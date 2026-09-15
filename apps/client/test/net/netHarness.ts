import { ServerSnapshotBaselines } from "@twobullets/netcode/baselines";
import { ServerInputBuffer } from "@twobullets/netcode/inputBuffer";
import type { ManualClock } from "@twobullets/netcode/testing/clock";
import type { Session } from "@twobullets/netcode/transport/Session";
import { createBitReader, createBitWriter } from "@twobullets/protocol/bits";
import { decodeHello, decodeResyncRequest, encodeResyncResponse, encodeWelcome } from "@twobullets/protocol/messages/control";
import { MsgId } from "@twobullets/protocol/messages/ids";
import { createInputPacketBuffer, decodeInputPacketInto } from "@twobullets/protocol/messages/input";
import { decodePing, encodePing } from "@twobullets/protocol/messages/ping";
import { writeOwnerWeapon } from "@twobullets/netcode/replication";
import {
  createOwnerVitalsBlock,
  createOwnerWeaponBlock,
  encodeSnapshot,
  EntityPresence,
  type Snapshot,
} from "@twobullets/protocol/messages/snapshot";
import {
  quantizeOwnerVel,
  quantizePosXZ,
  quantizePosY,
  quantizeRemoteVel,
  quantizeTicks,
  RemoteFlags,
} from "@twobullets/protocol/quantize";
import { Btn, type PlayerInput, type PlayerState } from "@twobullets/shared/input";
import type { PlayerInputRing } from "@twobullets/shared/inputRing";
import type { LevelData } from "@twobullets/shared/level/types";
import { createMoveState } from "@twobullets/shared/movement/movement";
import type { MoveState, Vec3 } from "@twobullets/shared/movement/types";
import { TICK_SECONDS } from "@twobullets/shared/tickClock";
import type { CharacterBody } from "@twobullets/sim/CharacterBody";
import { stepPlayer, type SimWorld } from "@twobullets/sim/index";
import type { WeaponState } from "@twobullets/shared/weapons/types";
import type { LocalPlayerNet, PredictedBody } from "../../src/net/LocalPlayerNet";
import { createNetWeaponState, netInputButtons, netInputSelect, netMoveGates } from "../../src/net/netCombatRules";
import type { NetClient } from "../../src/net/NetClient";
import type { NetClock } from "../../src/net/NetClock";
import { NET_MOVEMENT, NET_MOVE_WEAPON, stanceCode } from "../../src/net/netMovement";

// In-process stand-ins for server-match (T3.4 spec: Hello/Welcome, input buffer, 60 Hz owner + entity snapshots,
// server-owned spawn and killY respawn; with `weapons`, the T4.6 spec: `stepPlayer(..., { weapons: true })` from the
// net loadout, owner weapon and vitals groups) and for PlayerController's tick loop, both on the real stepPlayer.

export interface FakeServerOptions {
  /** M4: step weapons and send the owner weapon + vitals groups. Default false (M3 movement only). */
  readonly weapons?: boolean;
  /** Ticks whose input is simulated with fire cleared (forces a shot misprediction). */
  readonly dropFireAt?: ReadonlySet<number>;
}

const BOT_SLOT = 5;

export class FakeMatchServer {
  tick = 1000;
  readonly inputs = new ServerInputBuffer();
  readonly baselines = new ServerSnapshotBaselines();
  readonly states = new Map<number, { feet: Vec3; move: MoveState }>();
  private readonly session: Session;
  private readonly clock: ManualClock;
  private readonly body: CharacterBody;
  private readonly level: LevelData;
  private readonly spawn: Vec3;
  private state: PlayerState;
  private attached = false;
  private readonly w = createBitWriter(1500);
  private readonly r = createBitReader(new Uint8Array(0));
  private readonly packet = createInputPacketBuffer();
  private lastEcho = -1;
  private lastEchoTick = -1;
  private lastInputRecvMs = 0;
  private readonly weapons: boolean;
  private readonly dropFireAt: ReadonlySet<number>;
  private readonly scratchInput: { -readonly [K in keyof PlayerInput]: PlayerInput[K] } = { tick: 0, forward: 0, right: 0, buttons: 0, select: 0, yawQ: 0, pitchQ: 0, viewOffset8: 0, action: null };
  private readonly weaponBlock = createOwnerWeaponBlock();
  private readonly vitalsBlock = createOwnerVitalsBlock();
  /** Shot ids the server fired, in order. */
  readonly firedShotIds: number[] = [];
  /** Server weapon state after each simulated tick. */
  readonly weaponStates = new Map<number, WeaponState>();

  constructor(session: Session, clock: ManualClock, world: SimWorld, level: LevelData, spawnIndex: number, options: FakeServerOptions = {}) {
    this.weapons = options.weapons ?? false;
    this.dropFireAt = options.dropFireAt ?? new Set();
    this.session = session;
    this.clock = clock;
    this.level = level;
    const [x, y, z] = level.spawnPoints[spawnIndex]!.position;
    this.spawn = { x, y, z };
    this.body = world.createBody(this.spawn) as CharacterBody;
    this.body.restore(this.spawn, { x: 0, y: 0, z: 0 }, "stand");
    this.state = { move: createMoveState(), weapon: this.weapons ? createNetWeaponState() : NET_MOVE_WEAPON };
    session.onDatagram((bytes, recvMs) => this.onMessage(bytes, recvMs));
    session.onStream((bytes) => this.onMessage(bytes, this.clock.now()));
  }

  private send(stream: boolean): void {
    if (stream) this.session.sendStream(this.w.bytes());
    else this.session.sendDatagram(this.w.bytes());
  }

  private onMessage(bytes: Uint8Array, recvMs: number): void {
    const r = this.r;
    r.reset(bytes);
    switch (bytes[0]) {
      case MsgId.Hello: {
        if (decodeHello(r) === null) throw new Error("bad Hello");
        this.w.reset();
        encodeWelcome(this.w, {
          playerSlot: 0,
          teamId: 0,
          teamSize: 2,
          maxPlayers: 10,
          serverTick: this.tick,
          tickRate: 60,
          snapshotRate: 60,
          matchSeed: 1,
          phase: 0,
          phaseEndTick: 0,
          maxRewindMs: 200,
          interpFloorMs: 50,
          resumeToken: new Uint8Array(16),
          contentHash: 0,
          flags: 0,
        });
        this.send(true);
        this.attached = true;
        break;
      }
      case MsgId.Ping: {
        const ping = decodePing(r);
        if (!ping || ping.reply) return;
        this.w.reset();
        encodePing(this.w, { seq: ping.seq, originTimeMs: ping.originTimeMs, holdMs: this.clock.now() - recvMs, reply: true });
        this.send(false);
        break;
      }
      case MsgId.Input: {
        if (!decodeInputPacketInto(r, this.tick, this.packet)) return;
        this.inputs.insertPacket(this.packet.inputs, this.packet.count, this.tick);
        this.baselines.ack(this.packet.ackSnapshotTick);
        if (this.packet.newestTick > this.lastEchoTick) {
          this.lastEchoTick = this.packet.newestTick;
          this.lastEcho = this.packet.clientTimeMs;
          this.lastInputRecvMs = recvMs;
        }
        break;
      }
      case MsgId.Resync: {
        const req = decodeResyncRequest(r);
        if (!req) return;
        this.baselines.reset();
        this.w.reset();
        encodeResyncResponse(this.w, { scope: req.scope, serverTick: this.tick });
        this.send(true);
        break;
      }
      default:
        break;
    }
  }

  step(): void {
    const tick = this.tick;
    if (this.attached) {
      let input: PlayerInput = this.inputs.take(tick);
      if (this.dropFireAt.has(tick) && (input.buttons & Btn.fire) !== 0) {
        Object.assign(this.scratchInput, input);
        this.scratchInput.buttons = input.buttons & ~Btn.fire;
        input = this.scratchInput;
      }
      const result = stepPlayer(this.body, this.state, input, TICK_SECONDS, { replay: false, weapons: this.weapons });
      this.state = result.state;
      for (const shot of result.shots) this.firedShotIds.push(shot.shotId);
      if (this.weapons) this.weaponStates.set(tick, this.state.weapon);
      if (this.body.feet.y < this.level.killY) {
        this.body.restore(this.spawn, { x: 0, y: 0, z: 0 }, "stand");
        this.state = { move: createMoveState(), weapon: this.weapons ? this.state.weapon : NET_MOVE_WEAPON };
      }
      this.states.set(tick, { feet: { ...this.body.feet }, move: this.state.move });
      this.sendSnapshot(tick);
    }
    this.tick++;
  }

  private sendSnapshot(tick: number): void {
    const m = this.state.move;
    const feet = this.body.feet;
    if (this.weapons) writeOwnerWeapon(this.state.weapon, this.weaponBlock);
    const t = tick / 60;
    const snap: Snapshot = {
      header: {
        serverTick: tick,
        baselineTick: null,
        lastProcessedInputTick: this.inputs.lastProcessedInputTick,
        clientTimeEcho: this.lastEcho < 0 ? 0 : this.lastEcho,
        serverHoldMs: this.lastEcho < 0 ? 0 : Math.min(255, this.clock.now() - this.lastInputRecvMs),
        inputBufferDepthQ: this.inputs.depthQ,
        sections: 0,
      },
      owner: {
        xMm: quantizePosXZ(feet.x),
        yMm: quantizePosY(feet.y),
        zMm: quantizePosXZ(feet.z),
        vxMmS: quantizeOwnerVel(m.velocity.x),
        vyMmS: quantizeOwnerVel(m.velocity.y),
        vzMmS: quantizeOwnerVel(m.velocity.z),
        stance: stanceCode(m.stance),
        grounded: m.grounded,
        sprinting: m.sprinting,
        jumpHeld: m.jumpHeld,
        moveMode: 0,
        coyoteTicks: quantizeTicks(m.coyoteTimer, 4),
        jumpBufferTicks: quantizeTicks(m.jumpBufferTimer, 4),
        groundIgnoreTicks: quantizeTicks(m.groundIgnoreTimer, 4),
      },
      weapon: this.weapons ? this.weaponBlock : null,
      vitals: this.weapons ? this.vitalsBlock : null,
      entities: [
        {
          slot: BOT_SLOT,
          presence: EntityPresence.full,
          xMm: quantizePosXZ(botX(t)),
          yMm: quantizePosY(0),
          zMm: quantizePosXZ(0),
          yawQ: 0,
          pitchQ: 512,
          vxQ: quantizeRemoteVel(botVx(t)),
          vyQ: 0,
          vzQ: 0,
          flags: RemoteFlags.grounded,
        },
      ],
    };
    const baseline = this.baselines.baselineFor(tick);
    this.w.reset();
    encodeSnapshot(this.w, snap, baseline);
    this.baselines.record(snap);
    this.send(false);
  }
}

export const botX = (t: number) => 10 * Math.sin(0.8 * t);
export const botVx = (t: number) => 8 * Math.cos(0.8 * t);

/**
 * Scripted player: segments of held movement keys, sprint, crouch, jumps and a turning aim; with `combat`, also fire
 * bursts, ADS, reloads and weapon switches (rifle ↔ pistol). A pure function of tick.
 */
export function scriptedInput(tick: number, out: { -readonly [K in keyof PlayerInput]: PlayerInput[K] }, combat = false): PlayerInput {
  const seg = Math.floor(tick / 40);
  const h = (salt: number) => (Math.imul((seg + salt) ^ 0x9e3779b9, 0x85ebca6b) >>> 0) / 4294967296;
  out.tick = tick;
  out.forward = h(1) < 0.7 ? 1 : h(1) < 0.85 ? -1 : 0;
  out.right = h(2) < 0.25 ? 1 : h(2) < 0.5 ? -1 : 0;
  let buttons = 0;
  if (h(3) < 0.5) buttons |= Btn.sprint;
  if (h(4) < 0.15) buttons |= Btn.crouch;
  if (h(5) < 0.3 && tick % 40 === 10) buttons |= Btn.jump;
  out.select = 0;
  if (combat) {
    // Bursts: fire held for part of a segment, so triggers press and release (semi-auto pistol, auto rifle).
    if (h(7) < 0.45 && tick % 40 < 10 + Math.floor(h(8) * 25)) buttons |= Btn.fire;
    if (h(9) < 0.35) buttons |= Btn.aim;
    if (h(10) < 0.15 && tick % 40 === 30) buttons |= Btn.reload;
    if (h(11) < 0.12 && tick % 40 === 0) out.select = h(12) < 0.5 ? 1 : 3;
  }
  out.buttons = buttons;
  out.yawQ = (((Math.floor(tick * (h(6) - 0.5) * 3000) % (1 << 20)) + (1 << 20)) % (1 << 20)) >>> 0;
  out.pitchQ = 131071;
  out.viewOffset8 = 0;
  out.action = null;
  return out;
}

/** PlayerController + CombatSystem's tick loop without Babylon cameras, FX or DOM input. */
export class HeadlessPlayer implements PredictedBody {
  readonly body: CharacterBody;
  private state: MoveState = createMoveState();
  /** M4 weapon prediction; null = M3 movement only with the fixed weapon. */
  private weapon: WeaponState | null;
  private readonly combat: boolean;
  /** Owner life for gates and input clearing (LocalPlayerNet in `frame`). */
  private local: LocalPlayerNet | null = null;
  /** Shot ids presented (recoil/FX) after the ShotEmitter, and ids it suppressed as already shown. */
  readonly emittedShotIds: number[] = [];
  suppressedShots = 0;
  /** Shots `stepPlayer` returned during replays (must stay 0). */
  replayShots = 0;
  private readonly scratch = { tick: 0, forward: 0, right: 0, buttons: 0, select: 0, yawQ: 0, pitchQ: 0, viewOffset8: 0, action: null } as {
    -readonly [K in keyof PlayerInput]: PlayerInput[K];
  };
  ticks = 0;

  constructor(world: SimWorld, feet: Vec3, options: { readonly weapons?: boolean } = {}) {
    this.body = world.createBody(feet) as CharacterBody;
    this.combat = options.weapons ?? false;
    this.weapon = this.combat ? createNetWeaponState() : null;
  }

  get weaponState(): WeaponState | null {
    return this.weapon;
  }

  restoreWeapon(state: WeaponState): void {
    if (this.combat) this.weapon = state;
  }

  private get gates() {
    return this.combat ? netMoveGates(this.local?.ownerLife ?? 0) : NET_MOVEMENT.gates;
  }

  get tickFeet(): Readonly<Vec3> {
    return this.body.feet;
  }

  get moveState(): MoveState {
    return this.state;
  }

  restoreMove(feet: Vec3, state: MoveState): void {
    this.body.restore(feet, state.velocity, state.stance);
    this.state = state;
  }

  replayTick(input: PlayerInput): MoveState {
    const result = stepPlayer(this.body, { move: this.state, weapon: this.weapon ?? NET_MOVEMENT.weapon }, input, TICK_SECONDS, {
      replay: true,
      gates: this.gates,
      weapons: this.combat,
    });
    this.replayShots += result.shots.length;
    this.state = result.state.move;
    if (this.combat) this.weapon = result.state.weapon;
    return this.state;
  }

  setRenderOffset(): void {}

  frame(dtSec: number, clock: NetClock, ring: PlayerInputRing, client: NetClient, local: LocalPlayerNet | null = null): void {
    this.local = local;
    for (let n = clock.advance(dtSec); n > 0; n--) {
      const tick = clock.nextTick();
      const scripted = scriptedInput(tick, this.scratch, this.combat);
      if (this.combat) {
        const life = local?.ownerLife ?? 0;
        this.scratch.buttons = netInputButtons(scripted.buttons, life);
        this.scratch.select = netInputSelect(scripted.select, life);
      }
      const input = ring.push(scripted);
      const result = stepPlayer(this.body, { move: this.state, weapon: this.weapon ?? NET_MOVEMENT.weapon }, input, TICK_SECONDS, {
        replay: false,
        gates: this.gates,
        weapons: this.combat,
      });
      this.state = result.state.move;
      if (this.combat) this.weapon = result.state.weapon;
      if (local) {
        for (const shot of result.shots) {
          if (local.shots.accept(shot)) this.emittedShotIds.push(shot.shotId);
          else this.suppressedShots++;
        }
      }
      this.ticks++;
      client.onPredictedTick(input);
    }
  }
}
