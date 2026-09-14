// Snapshot codec benchmark for docs/backend/netcode.md.
//
// Simulates a realistic 10-player match slice at 60 Hz (combat or glide scenario), then per recipient encodes
// server->client snapshots with the proposed bit-packed, quantized, delta-against-last-acked-baseline format.
// Reports bytes per snapshot, kbps at 60/30/20 Hz including transport overhead, encode/decode cost, and compares
// against JSON and a byte-aligned float32 struct (the size class of protobuf/FlatBuffers with float fields).
//
// Usage: node tools/bench/netcode/snapshot-codec.mjs [--scenario=combat|glide] [--seconds=60] [--loss=0.02]
// Node built-ins only. Self-terminates after 120 s.

import { deflateRawSync } from "node:zlib";
import { BitReader, BitWriter } from "./bitpack.mjs";

setTimeout(() => {
  console.error("bench timed out");
  process.exit(2);
}, 120_000).unref();

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  }),
);
const SCENARIO = args.scenario ?? "combat";
const SECONDS = Number(args.seconds ?? 60);
const LOSS = Number(args.loss ?? 0.02);
const TICK_RATE = 60;
const DT = 1 / TICK_RATE;
const PLAYERS = 10;
/** IPv4 20 + UDP 8 + QUIC short header ~11 (1 flags + 8 DCID + 2 PN) + AEAD tag 16 + DATAGRAM frame 1 + quarter stream id 1 (+ ~1 slack). */
const OVERHEAD_WT_IPV4 = 58;
/** WebSocket fallback: IPv4 20 + TCP 20 (+12 timestamps) + TLS record 5+16 + WS frame 2..4. ACK traffic ignored. */
const OVERHEAD_WS = 77;

// ---------------------------------------------------------------------------------------------------------------
// Deterministic RNG (same mulberry32 family as weaponStep.ts)
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const R = rng(1234);

// ---------------------------------------------------------------------------------------------------------------
// Quantization spec (see netcode.md §6.3)
const Q = {
  posOffsetXZ: 24, // world X/Z in [-24, 1024.576) m
  posOffsetY: 12, // world Y in [-12, 512.288) m
  posBitsXZ: 20, // 1 mm
  posBitsY: 19, // 1 mm
  yawBits: 12, // 0.088 deg
  pitchBits: 10, // over [-89, 89] deg: 0.174 deg
  velBits: 10, // 0.125 m/s, +-64 m/s
  velScale: 8,
  flagBits: 18, // stance 2, moveMode 2, grounded, sprint, ads, weaponSlot 2, weaponPhase 2, life 2, helmet 2, vest 2, cooking
  healthBits: 10, // 0.1 HP
  shotBits: 8, // shotCounter low byte (remote audio/muzzle-flash trigger)
  phaseStartBits: 16, // tick the current weapon/item phase began (animation sync)
  // Owner block (recipient's own player): finer velocity for reconciliation
  ownerVelBits: 17, // 1 mm/s, +-65 m/s
};
const MAX_PITCH = (89 * Math.PI) / 180;

const FIELDS = 13; // px py pz yaw pitch vx vy vz flags health shots phaseStart | reserved
const F = { px: 0, py: 1, pz: 2, yaw: 3, pitch: 4, vx: 5, vy: 6, vz: 7, flags: 8, health: 9, shots: 10, phaseStart: 11 };

function quantizeAngle(a, bits) {
  const tau = Math.PI * 2;
  const n = ((a % tau) + tau) % tau;
  return Math.round((n / tau) * (1 << bits)) & ((1 << bits) - 1);
}
function quantizePitch(p, bits) {
  const max = (1 << bits) - 1;
  return Math.max(0, Math.min(max, Math.round(((p + MAX_PITCH) / (2 * MAX_PITCH)) * max)));
}
function quantizeVel(v, bits, scale) {
  const lim = (1 << (bits - 1)) - 1;
  return Math.max(-lim, Math.min(lim, Math.round(v * scale)));
}

// ---------------------------------------------------------------------------------------------------------------
// Player behaviour simulation (enough realism to exercise the codec, not gameplay-accurate)
const WALK = 6.5;
const SPRINT = 9.5;
const CROUCH = 3.2;

function terrainHeight(x, z) {
  return 30 + 12 * Math.sin(x / 90) * Math.cos(z / 70) + 4 * Math.sin((x + z) / 23);
}

function createPlayer(i) {
  const x = 100 + R() * 800;
  const z = 100 + R() * 800;
  return {
    i,
    x,
    z,
    y: SCENARIO === "glide" ? 380 + R() * 40 : terrainHeight(x, z),
    vx: 0,
    vy: 0,
    vz: 0,
    yaw: R() * Math.PI * 2,
    pitch: 0,
    yawRate: 0,
    mode: SCENARIO === "glide" ? "freefall" : "idle",
    modeTimer: 0,
    stance: 0,
    grounded: SCENARIO !== "glide",
    sprint: false,
    ads: false,
    firing: false,
    fireCooldown: 0,
    shots: 0,
    health: 1000,
    life: i === 9 && SCENARIO === "combat" ? 2 : 0, // one dead player in combat
    weaponSlot: 0,
    weaponPhase: 0,
    phaseStart: 0,
    phaseTimer: 0,
    wishX: 0,
    wishZ: 0,
    helmet: 1 + (i % 3),
    vest: 1 + ((i + 1) % 3),
    cooking: false,
  };
}

const COMBAT_MODES = ["idle", "walk", "sprint", "fight", "fight", "crouch", "fight"];

function stepPlayer(p, tick, events) {
  if (p.life === 2) return;
  p.modeTimer -= DT;
  if (p.mode === "freefall" || p.mode === "parachute") return stepGlide(p);

  if (p.modeTimer <= 0) {
    p.mode = COMBAT_MODES[Math.floor(R() * COMBAT_MODES.length)];
    p.modeTimer = 0.5 + R() * 2.5;
    const dir = R() * Math.PI * 2;
    p.wishX = Math.sin(dir);
    p.wishZ = Math.cos(dir);
    if (p.mode !== "fight" && R() < 0.1 && p.weaponPhase === 0) {
      p.weaponPhase = 2; // reloading
      p.phaseStart = tick;
      p.phaseTimer = 2.2;
    }
  }
  if (p.weaponPhase !== 0) {
    p.phaseTimer -= DT;
    if (p.phaseTimer <= 0) p.weaponPhase = 0;
  }

  let target = 0;
  p.stance = 0;
  p.sprint = false;
  p.ads = false;
  p.firing = false;
  switch (p.mode) {
    case "walk":
      target = WALK;
      break;
    case "sprint":
      target = SPRINT;
      p.sprint = true;
      p.wishX = Math.sin(p.yaw);
      p.wishZ = Math.cos(p.yaw);
      break;
    case "crouch":
      target = CROUCH;
      p.stance = 1;
      break;
    case "fight": {
      // ADS strafe: flip strafe direction every ~0.4 s, shoot in bursts.
      p.ads = true;
      target = WALK * 0.57;
      if (Math.floor(tick / 24) % 2 === 0) {
        p.wishX = Math.cos(p.yaw);
        p.wishZ = -Math.sin(p.yaw);
      } else {
        p.wishX = -Math.cos(p.yaw);
        p.wishZ = Math.sin(p.yaw);
      }
      p.firing = p.weaponPhase === 0 && Math.floor(tick / 40 + p.i) % 3 !== 0;
      break;
    }
  }

  // Aim: slow drift plus tracking noise, occasional flick.
  if (R() < 0.01) p.yawRate = (R() - 0.5) * 12;
  p.yawRate *= 0.9;
  p.yaw += (p.yawRate + (R() - 0.5) * (p.mode === "fight" ? 0.8 : 0.3)) * DT;
  p.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, p.pitch + (R() - 0.5) * 0.4 * DT));

  if (p.grounded) {
    const tx = p.wishX * target;
    const tz = p.wishZ * target;
    const dx = tx - p.vx;
    const dz = tz - p.vz;
    const d = Math.hypot(dx, dz);
    const max = 70 * DT;
    if (d <= max) {
      p.vx = tx;
      p.vz = tz;
    } else {
      p.vx += (dx / d) * max;
      p.vz += (dz / d) * max;
    }
    if (p.mode !== "crouch" && R() < 0.004) {
      p.vy = 7.6;
      p.grounded = false;
    }
  }
  p.x = Math.max(0, Math.min(1000, p.x + p.vx * DT));
  p.z = Math.max(0, Math.min(1000, p.z + p.vz * DT));
  const ground = terrainHeight(p.x, p.z);
  if (p.grounded) {
    const ny = ground;
    p.vy = (ny - p.y) / DT;
    p.y = ny;
  } else {
    p.vy -= 24 * DT;
    p.y += p.vy * DT;
    if (p.y <= ground) {
      p.y = ground;
      p.grounded = true;
      p.vy = 0;
    }
  }

  // Rifle at 700 rpm.
  p.fireCooldown -= DT;
  if (p.firing && p.fireCooldown <= 0) {
    p.fireCooldown += 60 / 700;
    p.shots++;
    events.push({ kind: "shot", shooter: p.i, weapon: p.weaponSlot, shotCounter: p.shots, yaw: p.yaw, pitch: p.pitch, spread: 12 });
    // ~25% of rifle shots hit someone: reliable hit confirm to the shooter, damage taken to a victim.
    if (R() < 0.25) {
      const victim = (p.i + 1 + Math.floor(R() * 8)) % 9;
      events.push({ kind: "hitConfirm", to: p.i, victim, zone: R() < 0.15 ? 0 : 1, damage: 220 });
      events.push({ kind: "damageTaken", to: victim, attacker: p.i, amount: 220 });
    }
  } else if (p.fireCooldown < 0) p.fireCooldown = 0;

  // Throwables: ~1 grenade per player per 30 s; detonation 4 s later (reliable to everyone).
  if (R() < DT / 30) {
    events.push({ kind: "throw", thrower: p.i, tick });
    events.push({ kind: "detonate", at: tick + 240, x: p.x, y: p.y, z: p.z });
  }
}

function stepGlide(p) {
  if (p.modeTimer <= 0) {
    const dir = R() * Math.PI * 2;
    p.wishX = Math.sin(dir);
    p.wishZ = Math.cos(dir);
    p.modeTimer = 1 + R() * 3;
    p.yaw = dir;
  }
  const deploy = p.y < 150;
  if (deploy) p.mode = "parachute";
  const hSpeed = deploy ? 12 : 35 + 15 * Math.sin(p.i + p.y / 40);
  const vTarget = deploy ? -6 : -45 - 10 * Math.cos(p.i + p.y / 30);
  p.vx += (p.wishX * hSpeed - p.vx) * Math.min(1, 1.5 * DT);
  p.vz += (p.wishZ * hSpeed - p.vz) * Math.min(1, 1.5 * DT);
  p.vy += (vTarget - p.vy) * Math.min(1, 2 * DT);
  p.x = Math.max(0, Math.min(1000, p.x + p.vx * DT));
  p.z = Math.max(0, Math.min(1000, p.z + p.vz * DT));
  p.y += p.vy * DT;
  p.pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, p.pitch + (R() - 0.5) * 0.6 * DT));
  p.yaw += (R() - 0.5) * 0.4 * DT;
  p.grounded = false;
  const ground = terrainHeight(p.x, p.z);
  if (p.y <= ground) {
    p.y = ground;
    p.mode = "idle";
    p.grounded = true;
    p.vy = 0;
  }
}

function modeBits(p) {
  return p.mode === "freefall" ? 1 : p.mode === "parachute" ? 2 : 0;
}

function quantizePlayer(p, out, o) {
  out[o + F.px] = Math.round((p.x + Q.posOffsetXZ) * 1000);
  out[o + F.py] = Math.round((p.y + Q.posOffsetY) * 1000);
  out[o + F.pz] = Math.round((p.z + Q.posOffsetXZ) * 1000);
  out[o + F.yaw] = quantizeAngle(p.yaw, Q.yawBits);
  out[o + F.pitch] = quantizePitch(p.pitch, Q.pitchBits);
  out[o + F.vx] = quantizeVel(p.vx, Q.velBits, Q.velScale);
  out[o + F.vy] = quantizeVel(p.vy, Q.velBits, Q.velScale);
  out[o + F.vz] = quantizeVel(p.vz, Q.velBits, Q.velScale);
  out[o + F.flags] =
    p.stance |
    (modeBits(p) << 2) |
    ((p.grounded ? 1 : 0) << 4) |
    ((p.sprint ? 1 : 0) << 5) |
    ((p.ads ? 1 : 0) << 6) |
    (p.weaponSlot << 7) |
    (p.weaponPhase << 9) |
    (p.life << 11) |
    (p.helmet << 13) |
    (p.vest << 15) |
    ((p.cooking ? 1 : 0) << 17);
  out[o + F.health] = p.health;
  out[o + F.shots] = p.shots & 0xff;
  out[o + F.phaseStart] = p.phaseStart & 0xffff;
}

/** Owner block state: finer velocity (1 mm/s) and the MoveState/WeaponState fields prediction needs. */
const OWNER_FIELDS = 10;
function quantizeOwner(p, tick, out, o) {
  out[o] = Math.round((p.x + Q.posOffsetXZ) * 1000);
  out[o + 1] = Math.round((p.y + Q.posOffsetY) * 1000);
  out[o + 2] = Math.round((p.z + Q.posOffsetXZ) * 1000);
  out[o + 3] = quantizeVel(p.vx, Q.ownerVelBits, 1000);
  out[o + 4] = quantizeVel(p.vy, Q.ownerVelBits, 1000);
  out[o + 5] = quantizeVel(p.vz, Q.ownerVelBits, 1000);
  // move flags 8 bits + 3 timers (ticks, 4 bits each) = 20 bits
  out[o + 6] = p.stance | ((p.grounded ? 1 : 0) << 2) | ((p.sprint ? 1 : 0) << 3) | ((tick & 1) << 4);
  // weapon block (phase, activeIndex, phaseTimer ticks, cooldown 1/64 tick, bloom, adsBlend, trigger, shotCounter)
  out[o + 7] = p.weaponPhase | (p.weaponSlot << 2) | (Math.max(0, Math.round(p.phaseTimer * 60)) << 4);
  out[o + 8] = (Math.round(Math.max(0, p.fireCooldown) * 60 * 64) | ((p.ads ? 255 : 0) << 13)) >>> 0;
  out[o + 9] = p.shots & 0xffff;
}

// ---------------------------------------------------------------------------------------------------------------
// Codec

const POS_BUCKETS = [8, 12, 16]; // zigzag widths; bucket 3 = absolute

function writePosition(w, cur, base, o, bo, ageTicks, predictive, baseVel) {
  let dx = cur[o + F.px];
  let dy = cur[o + F.py];
  let dz = cur[o + F.pz];
  if (base) {
    let px = base[bo + F.px];
    let py = base[bo + F.py];
    let pz = base[bo + F.pz];
    if (predictive) {
      // Dead-reckon the baseline forward with its own quantized velocity; both ends can compute this exactly.
      const k = (1000 * ageTicks) / (Q.velScale * TICK_RATE);
      px += Math.round(baseVel[bo + F.vx] * k);
      py += Math.round(baseVel[bo + F.vy] * k);
      pz += Math.round(baseVel[bo + F.vz] * k);
    }
    dx -= px;
    dy -= py;
    dz -= pz;
    if (dx === 0 && dy === 0 && dz === 0) {
      w.bool(false);
      return;
    }
    w.bool(true);
    const m = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
    for (let b = 0; b < POS_BUCKETS.length; b++) {
      if (m < 1 << (POS_BUCKETS[b] - 1)) {
        w.write(b, 2);
        w.signed(dx, POS_BUCKETS[b]);
        w.signed(dy, POS_BUCKETS[b]);
        w.signed(dz, POS_BUCKETS[b]);
        return;
      }
    }
    w.write(3, 2);
  }
  w.write(cur[o + F.px], Q.posBitsXZ);
  w.write(cur[o + F.py], Q.posBitsY);
  w.write(cur[o + F.pz], Q.posBitsXZ);
}

function readPosition(r, out, o, base, bo, ageTicks, predictive) {
  if (base) {
    if (!r.bool()) {
      out[o + F.px] = base[bo + F.px];
      out[o + F.py] = base[bo + F.py];
      out[o + F.pz] = base[bo + F.pz];
      if (predictive) applyPrediction(out, o, base, bo, ageTicks, 0, 0, 0);
      return;
    }
    const bucket = r.read(2);
    if (bucket < 3) {
      const bits = POS_BUCKETS[bucket];
      const dx = r.signed(bits);
      const dy = r.signed(bits);
      const dz = r.signed(bits);
      out[o + F.px] = base[bo + F.px];
      out[o + F.py] = base[bo + F.py];
      out[o + F.pz] = base[bo + F.pz];
      if (predictive) applyPrediction(out, o, base, bo, ageTicks, dx, dy, dz);
      else {
        out[o + F.px] += dx;
        out[o + F.py] += dy;
        out[o + F.pz] += dz;
      }
      return;
    }
  }
  out[o + F.px] = r.read(Q.posBitsXZ);
  out[o + F.py] = r.read(Q.posBitsY);
  out[o + F.pz] = r.read(Q.posBitsXZ);
}

function applyPrediction(out, o, base, bo, ageTicks, dx, dy, dz) {
  const k = (1000 * ageTicks) / (Q.velScale * TICK_RATE);
  out[o + F.px] += Math.round(base[bo + F.vx] * k) + dx;
  out[o + F.py] += Math.round(base[bo + F.vy] * k) + dy;
  out[o + F.pz] += Math.round(base[bo + F.vz] * k) + dz;
}

const FIELD_SPECS = [
  // [field, bits, signed]
  [[F.yaw], Q.yawBits, false],
  [[F.pitch], Q.pitchBits, false],
  [[F.vx, F.vy, F.vz], Q.velBits, true],
  [[F.flags], Q.flagBits, false],
  [[F.health], Q.healthBits, false],
  [[F.shots], Q.shotBits, false],
  [[F.phaseStart], Q.phaseStartBits, false],
];

function writeEntity(w, cur, o, base, bo, ageTicks, predictive) {
  writePosition(w, cur, base, o, bo, ageTicks, predictive, base);
  for (const [fields, bits, signed] of FIELD_SPECS) {
    if (base) {
      let same = true;
      for (const f of fields) if (cur[o + f] !== base[bo + f]) same = false;
      w.bool(!same);
      if (same) continue;
    }
    for (const f of fields) signed ? w.signed(cur[o + f], bits) : w.write(cur[o + f], bits);
  }
}

function readEntity(r, out, o, base, bo, ageTicks, predictive) {
  // Velocity is needed by the position predictor, and it's read after position: position prediction uses the
  // BASELINE velocity, which the decoder already has.
  readPosition(r, out, o, base, bo, ageTicks, predictive);
  for (const [fields, bits, signed] of FIELD_SPECS) {
    if (base && !r.bool()) {
      for (const f of fields) out[o + f] = base[bo + f];
      continue;
    }
    for (const f of fields) out[o + f] = signed ? r.signed(bits) : r.read(bits);
  }
}

const OWNER_SPECS = [
  [[3, 4, 5], Q.ownerVelBits, true],
  [[6], 20, false],
  [[7], 20, false],
  [[8], 21, false],
  [[9], 16, false],
];

function writeOwner(w, cur, o, base, bo) {
  // Position: plain delta (velocity scale differs from remote entities), same bucket scheme.
  let dx = cur[o],
    dy = cur[o + 1],
    dz = cur[o + 2];
  if (base) {
    dx -= base[bo];
    dy -= base[bo + 1];
    dz -= base[bo + 2];
    const m = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
    if (m === 0) w.bool(false);
    else {
      w.bool(true);
      let done = false;
      for (let b = 0; b < POS_BUCKETS.length && !done; b++) {
        if (m < 1 << (POS_BUCKETS[b] - 1)) {
          w.write(b, 2);
          w.signed(dx, POS_BUCKETS[b]);
          w.signed(dy, POS_BUCKETS[b]);
          w.signed(dz, POS_BUCKETS[b]);
          done = true;
        }
      }
      if (!done) {
        w.write(3, 2);
        w.write(cur[o], Q.posBitsXZ);
        w.write(cur[o + 1], Q.posBitsY);
        w.write(cur[o + 2], Q.posBitsXZ);
      }
    }
  } else {
    w.write(cur[o], Q.posBitsXZ);
    w.write(cur[o + 1], Q.posBitsY);
    w.write(cur[o + 2], Q.posBitsXZ);
  }
  for (const [fields, bits, signed] of OWNER_SPECS) {
    if (base) {
      let same = true;
      for (const f of fields) if (cur[o + f] !== base[bo + f]) same = false;
      w.bool(!same);
      if (same) continue;
    }
    for (const f of fields) signed ? w.signed(cur[o + f], bits) : w.write(cur[o + f], bits);
  }
}

function readOwner(r, out, o, base, bo) {
  if (base) {
    if (!r.bool()) {
      out[o] = base[bo];
      out[o + 1] = base[bo + 1];
      out[o + 2] = base[bo + 2];
    } else {
      const bucket = r.read(2);
      if (bucket < 3) {
        const bits = POS_BUCKETS[bucket];
        out[o] = base[bo] + r.signed(bits);
        out[o + 1] = base[bo + 1] + r.signed(bits);
        out[o + 2] = base[bo + 2] + r.signed(bits);
      } else {
        out[o] = r.read(Q.posBitsXZ);
        out[o + 1] = r.read(Q.posBitsY);
        out[o + 2] = r.read(Q.posBitsXZ);
      }
    }
  } else {
    out[o] = r.read(Q.posBitsXZ);
    out[o + 1] = r.read(Q.posBitsY);
    out[o + 2] = r.read(Q.posBitsXZ);
  }
  for (const [fields, bits, signed] of OWNER_SPECS) {
    if (base && !r.bool()) {
      for (const f of fields) out[o + f] = base[bo + f];
      continue;
    }
    for (const f of fields) out[o + f] = signed ? r.signed(bits) : r.read(bits);
  }
}

// Event encodings (bit sizes from netcode.md §6.5)
const EVENT_BITS = {
  shot: 4 + 2 + 16 + 2 + 16 + 16 + 8, // shooter, weapon, shotCounter, tick offset, yaw16, pitch16, spread
  hitConfirm: 12 + 5 + 4 + 2 + 11 + 2, // eventSeq, type, victim, zone, damage, flags(killed, armor)
  damageTaken: 12 + 5 + 4 + 8 + 11 + 2, // eventSeq, type, attacker, direction yaw8, amount, flags
  throw: 5 + 12 + 4 + 16 + 59 + 3 * 12 + 8, // type, seq, thrower, throwId, origin mm, velocity (0.05 m/s i12), fuse ticks
  detonate: 12 + 5 + 16 + 59 + 3, // seq, type, throwId, position mm, kind
};

/**
 * Encodes one snapshot for `recipient` against `baseTick` (or full if null). Returns bytes written.
 * Layout: header | owner block | 9 remote entities | unreliable events (send-once) | reliable events (until acked).
 */
function encodeSnapshot(w, tick, recipient, hist, ownerHist, baseTick, predictive, unreliable, reliable) {
  w.reset();
  w.write(0x10, 8); // message type
  w.write(tick & 0xffff, 16);
  w.write(baseTick === null ? 0xffff : baseTick & 0xffff, 16);
  w.write((tick - 2) & 0xffff, 16); // ack of last processed input tick
  w.write(12345, 16); // client time echo, ms
  w.write(3, 8); // server hold time, ms
  w.write(1 + 8, 4); // input buffer depth, signed offset
  w.write(0, 4); // flags: zone changed, loot version changed, ...

  const cur = hist.get(tick);
  const base = baseTick === null ? null : hist.get(baseTick);
  const age = baseTick === null ? 0 : tick - baseTick;
  const oc = ownerHist.get(tick);
  const ob = baseTick === null ? null : ownerHist.get(baseTick);
  const b0 = w.bitLength;
  writeOwner(w, oc, recipient * OWNER_FIELDS, ob, recipient * OWNER_FIELDS);
  const b1 = w.bitLength;

  for (let e = 0; e < PLAYERS; e++) {
    if (e === recipient) continue;
    w.bool(true); // relevant (all relevant in this bench)
    writeEntity(w, cur, e * FIELDS, base, e * FIELDS, age, predictive);
  }

  const b2 = w.bitLength;
  // Unreliable, send-once: shots from other players.
  const shots = unreliable.filter((ev) => ev.shooter !== recipient);
  w.write(Math.min(shots.length, 31), 5);
  for (const ev of shots.slice(0, 31)) {
    w.write(ev.shooter, 4);
    w.write(ev.weapon, 2);
    w.write(ev.shotCounter & 0xffff, 16);
    w.write(0, 2);
    w.write(quantizeAngle(ev.yaw, 16), 16);
    w.write(quantizePitch(ev.pitch, 16), 16);
    w.write(ev.spread, 8);
  }
  // Reliable-over-unreliable (sizes only; payload bits are opaque here).
  w.write(Math.min(reliable.length, 15), 4);
  for (const ev of reliable.slice(0, 15)) {
    let bits = EVENT_BITS[ev.kind];
    while (bits > 0) {
      const n = Math.min(16, bits);
      w.write(0x5a5a & ((1 << n) - 1), n);
      bits -= n;
    }
  }
  const b3 = w.bitLength;
  BREAKDOWN.header += b0;
  BREAKDOWN.owner += b1 - b0;
  BREAKDOWN.entities += b2 - b1;
  BREAKDOWN.events += b3 - b2;
  BREAKDOWN.n++;
  return w.finish();
}
const BREAKDOWN = { header: 0, owner: 0, entities: 0, events: 0, n: 0 };

function decodeSnapshot(buf, len, recipient, clientHist, clientOwnerHist, predictive) {
  const r = new BitReader(buf, len);
  r.read(8);
  const tick = r.read(16);
  const baseTick16 = r.read(16);
  r.read(16);
  r.read(16);
  r.read(8);
  r.read(4);
  r.read(4);
  const base = baseTick16 === 0xffff ? null : clientHist.get(baseTick16);
  const age = base ? (tick - baseTick16) & 0xffff : 0;
  const out = new Int32Array(PLAYERS * FIELDS);
  const own = new Int32Array(PLAYERS * OWNER_FIELDS);
  readOwner(r, own, recipient * OWNER_FIELDS, base ? clientOwnerHist.get(baseTick16) : null, recipient * OWNER_FIELDS);
  for (let e = 0; e < PLAYERS; e++) {
    if (e === recipient) continue;
    r.bool();
    readEntity(r, out, e * FIELDS, base, e * FIELDS, age, predictive);
  }
  const nShots = r.read(5);
  for (let i = 0; i < nShots; i++) {
    r.read(4);
    r.read(2);
    r.read(16);
    r.read(2);
    r.read(16);
    r.read(16);
    r.read(8);
  }
  return { tick, out, own };
}

// ---------------------------------------------------------------------------------------------------------------
// Reference formats

function encodeJson(tick, players) {
  return JSON.stringify({
    t: tick,
    p: players.map((p) => ({
      id: p.i,
      pos: [+p.x.toFixed(3), +p.y.toFixed(3), +p.z.toFixed(3)],
      yaw: +p.yaw.toFixed(3),
      pitch: +p.pitch.toFixed(3),
      vel: [+p.vx.toFixed(2), +p.vy.toFixed(2), +p.vz.toFixed(2)],
      stance: p.stance,
      grounded: p.grounded,
      sprint: p.sprint,
      ads: p.ads,
      weapon: p.weaponSlot,
      phase: p.weaponPhase,
      hp: p.health / 10,
      shots: p.shots,
    })),
  });
}

const structBuf = new DataView(new ArrayBuffer(1024));
function encodeStruct(tick, players) {
  let o = 0;
  structBuf.setUint32(o, tick, true);
  o += 4;
  for (const p of players) {
    structBuf.setUint8(o, p.i);
    o += 1;
    for (const v of [p.x, p.y, p.z, p.yaw, p.pitch, p.vx, p.vy, p.vz]) {
      structBuf.setFloat32(o, v, true);
      o += 4;
    }
    structBuf.setUint32(o, p.stance | (p.weaponPhase << 8), true);
    o += 4;
    structBuf.setUint16(o, p.health, true);
    o += 2;
    structBuf.setUint16(o, p.shots, true);
    o += 2;
  }
  return o;
}

// ---------------------------------------------------------------------------------------------------------------
// Run

const players = Array.from({ length: PLAYERS }, (_, i) => createPlayer(i));
const TOTAL_TICKS = SECONDS * TICK_RATE;
const HIST_LEN = 128;

const serverHist = new Map();
const ownerHist = new Map();
const unreliableByTick = new Map();
const reliableByTick = new Map();

const RTT_MS = [30, 45, 60, 75, 90, 110, 130, 160, 200, 60];

function percentile(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

// Pre-simulate so encode timing excludes simulation.
for (let tick = 0; tick < TOTAL_TICKS; tick++) {
  const events = [];
  for (const p of players) stepPlayer(p, tick, events);
  const q = new Int32Array(PLAYERS * FIELDS);
  const oq = new Int32Array(PLAYERS * OWNER_FIELDS);
  players.forEach((p, i) => {
    quantizePlayer(p, q, i * FIELDS);
    quantizeOwner(p, tick, oq, i * OWNER_FIELDS);
  });
  serverHist.set(tick, q);
  ownerHist.set(tick, oq);
  unreliableByTick.set(tick, events.filter((e) => e.kind === "shot"));
  reliableByTick.set(tick, events.filter((e) => e.kind !== "shot"));
  if (tick === TOTAL_TICKS - 1) {
    globalThis.lastPlayers = players.map((p) => ({ ...p }));
  }
}

function runRate(rateHz, predictive, measureTiming) {
  const interval = TICK_RATE / rateHz;
  const w = new BitWriter(4096);
  const sizes = [];
  const fullSizes = [];
  const R2 = rng(99);
  let encodeNs = 0n;
  let encodes = 0;
  let decodeNs = 0n;
  let decodes = 0;
  let mismatches = 0;
  let compressedBytes = 0;
  let rawBytes = 0;

  // Per recipient ack state: sent ticks with arrival time; server learns the ack RTT later.
  const clients = RTT_MS.map((rtt) => ({
    rttTicks: Math.round(rtt / (1000 / TICK_RATE)),
    received: [], // {tick, ackKnownAt}
    ackedTick: null,
    hist: new Map(),
    ownerHist: new Map(),
    pendingReliable: [], // {ev, firstSent}
  }));

  for (let tick = 0; tick < TOTAL_TICKS; tick++) {
    // Collect events since the last snapshot.
    for (const c of clients) {
      for (const ev of reliableByTick.get(tick)) c.pendingReliable.push({ ev, firstSent: null });
    }
    if (tick % interval !== 0) continue;
    const unreliable = [];
    for (let t = Math.max(0, tick - interval + 1); t <= tick; t++) unreliable.push(...unreliableByTick.get(t));

    for (let ci = 0; ci < clients.length; ci++) {
      const c = clients[ci];
      // Learn acks that have arrived by now.
      for (const rcv of c.received) if (rcv.ackKnownAt <= tick && (c.ackedTick === null || rcv.tick > c.ackedTick)) c.ackedTick = rcv.tick;
      c.received = c.received.filter((rcv) => rcv.ackKnownAt > tick);
      const baseTick = c.ackedTick !== null && tick - c.ackedTick < HIST_LEN ? c.ackedTick : null;

      // Reliable events addressed to or visible by this client, resent until an ack covers their first send.
      const reliable = [];
      c.pendingReliable = c.pendingReliable.filter((pr) => {
        const ev = pr.ev;
        const relevant = ev.kind === "detonate" || ev.kind === "throw" || ev.to === ci;
        if (!relevant) return false;
        if (pr.firstSent !== null && c.ackedTick !== null && c.ackedTick >= pr.firstSent) return false;
        if (pr.firstSent === null) pr.firstSent = tick;
        reliable.push(ev);
        return true;
      });

      const t0 = measureTiming ? process.hrtime.bigint() : 0n;
      const len = encodeSnapshot(w, tick, ci, serverHist, ownerHist, baseTick, predictive, unreliable, reliable);
      if (measureTiming) {
        encodeNs += process.hrtime.bigint() - t0;
        encodes++;
      }
      (baseTick === null ? fullSizes : sizes).push(len);
      if (ci === 3 && tick % 30 === 0) {
        rawBytes += len;
        compressedBytes += deflateRawSync(w.buf.subarray(0, len)).length;
      }

      const lost = R2() < LOSS;
      if (!lost) {
        const t1 = measureTiming ? process.hrtime.bigint() : 0n;
        const decoded = decodeSnapshot(w.buf, len, ci, c.hist, c.ownerHist, predictive);
        if (measureTiming) {
          decodeNs += process.hrtime.bigint() - t1;
          decodes++;
        }
        // Verify against the server's quantized truth.
        const truth = serverHist.get(tick);
        for (let e = 0; e < PLAYERS; e++) {
          if (e === ci) continue;
          for (let f = 0; f < 12; f++) if (decoded.out[e * FIELDS + f] !== truth[e * FIELDS + f]) mismatches++;
        }
        const ot = ownerHist.get(tick);
        for (let f = 0; f < OWNER_FIELDS; f++) if (decoded.own[ci * OWNER_FIELDS + f] !== ot[ci * OWNER_FIELDS + f]) mismatches++;
        // Client stores the full decoded state as a future baseline (owner fields of others are irrelevant).
        const store = decoded.out;
        store.set(truth.subarray(ci * FIELDS, ci * FIELDS + FIELDS), ci * FIELDS); // own entity isn't sent; unused as baseline
        c.hist.set(tick, store);
        c.ownerHist.set(tick, decoded.own);
        if (c.hist.size > HIST_LEN) c.hist.delete(tick - HIST_LEN);
        if (c.ownerHist.size > HIST_LEN) c.ownerHist.delete(tick - HIST_LEN);
        // Input packets carry the ack every tick; the server learns it after ~RTT (upstream loss ignored).
        c.received.push({ tick, ackKnownAt: tick + c.rttTicks });
      }
    }
  }
  return { sizes, fullSizes, encodeNs, encodes, decodeNs, decodes, mismatches, ratio: compressedBytes / Math.max(1, rawBytes) };
}

console.log(`scenario=${SCENARIO} seconds=${SECONDS} players=${PLAYERS} downstream loss=${LOSS * 100}% RTTs=${RTT_MS.join("/")} ms`);
console.log("");

// Reference formats: full snapshot of 10 players, no deltas.
{
  const ps = globalThis.lastPlayers;
  const json = encodeJson(TOTAL_TICKS, ps);
  const jsonBytes = Buffer.byteLength(json);
  const jsonDeflate = deflateRawSync(Buffer.from(json)).length;
  const structBytes = encodeStruct(TOTAL_TICKS, ps);
  let t0 = process.hrtime.bigint();
  const N = 20000;
  for (let i = 0; i < N; i++) encodeJson(i, ps);
  const jsonUs = Number(process.hrtime.bigint() - t0) / N / 1000;
  t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) encodeStruct(i, ps);
  const structUs = Number(process.hrtime.bigint() - t0) / N / 1000;
  console.log("Reference encodings of one full 10-player snapshot (player entities only, no owner block or events):");
  console.log(`  JSON                      ${String(jsonBytes).padStart(5)} B   deflate-raw ${jsonDeflate} B   encode ${jsonUs.toFixed(1)} us`);
  console.log(`  float32 byte-aligned      ${String(structBytes).padStart(5)} B   encode ${structUs.toFixed(2)} us`);
  const w = new BitWriter();
  const len = encodeSnapshot(w, TOTAL_TICKS - 1, 0, serverHist, ownerHist, null, true, [], []);
  console.log(`  bit-packed quantized full ${String(len).padStart(5)} B   (includes 12-byte header and owner block)`);
  console.log("");
}

for (const predictive of [false, true]) {
  console.log(`Delta codec, position delta ${predictive ? "vs dead-reckoned baseline" : "vs raw baseline"}:`);
  console.log("  rate  delta mean  p95   max  | full(no ack) mean | kbps/client WT (payload+58B) | kbps WS fallback | enc us/client | dec us | deflate ratio");
  for (const rate of [60, 30, 20]) {
    for (const k of Object.keys(BREAKDOWN)) BREAKDOWN[k] = 0;
    const res = runRate(rate, predictive, true);
    const all = [...res.sizes, ...res.fullSizes];
    const mean = all.reduce((a, b) => a + b, 0) / all.length;
    const dMean = res.sizes.reduce((a, b) => a + b, 0) / res.sizes.length;
    const fMean = res.fullSizes.length ? res.fullSizes.reduce((a, b) => a + b, 0) / res.fullSizes.length : 0;
    const kbps = ((mean + OVERHEAD_WT_IPV4) * 8 * rate) / 1000;
    const kbpsWs = ((mean + OVERHEAD_WS) * 8 * rate) / 1000;
    const encUs = Number(res.encodeNs) / res.encodes / 1000;
    const decUs = Number(res.decodeNs) / res.decodes / 1000;
    console.log(
      `  ${String(rate).padStart(3)}Hz ${dMean.toFixed(1).padStart(8)} ${String(percentile(res.sizes, 0.95)).padStart(5)} ${String(Math.max(...all)).padStart(5)} | ${fMean.toFixed(1).padStart(8)} (n=${res.fullSizes.length}) | ${kbps.toFixed(1).padStart(8)} | ${kbpsWs.toFixed(1).padStart(8)} | ${encUs.toFixed(3).padStart(8)} | ${decUs.toFixed(3)} | ${res.ratio.toFixed(2)}${res.mismatches ? `  MISMATCHES=${res.mismatches}` : ""}`,
    );
    const nb = (k) => (BREAKDOWN[k] / BREAKDOWN.n / 8).toFixed(1);
    console.log(`        avg bytes by section (all snapshots): header ${nb("header")}, owner ${nb("owner")}, 9 remote players ${nb("entities")}, events ${nb("events")}`);
  }
  console.log("");
}

// Input packets: 60 Hz, newest input + unacked redundancy (capped at 8), aim changes almost every tick.
{
  const perInputBits = 4 + 6 + 3 + 1 + 20 + 18 + 1; // axes, buttons, select, aimChanged, yaw20, pitch18, hasViewOffset (+8 when firing)
  const headerBits = 8 + 16 + 16 + 16 + 4;
  console.log("Input datagram (client->server, 60 Hz):");
  for (const redundancy of [1, 3, 5, 8]) {
    const firingShare = 0.3;
    const bits = headerBits + redundancy * (perInputBits + 8 * firingShare);
    const bytes = Math.ceil(bits / 8);
    console.log(`  ${redundancy} input(s): ${bytes} B payload -> ${(((bytes + OVERHEAD_WT_IPV4) * 8 * 60) / 1000).toFixed(1)} kbps upstream`);
  }
}
