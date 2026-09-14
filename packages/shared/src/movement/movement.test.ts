import { describe, expect, it } from "vitest";
import { FALL_DAMAGE, MOVEMENT } from "../constants";
import { computeDesiredVelocity, createMoveState, eyeHeightFor, fallDamage, landingSpeed } from "./movement";
import type { MoveEnvironment, MoveInput, MoveState } from "./types";

const DT = 1 / 60;
const UP = { x: 0, y: 1, z: 0 };
const ground: MoveEnvironment = { supported: true, groundNormal: UP, canStand: true };
const idle: MoveInput = { forward: 0, right: 0, jump: false, sprint: false, crouch: false, speedScale: 1, yaw: 0, pitch: 0 };

function input(partial: Partial<MoveInput>): MoveInput {
  return { ...idle, ...partial };
}

/** Runs `ticks` steps with a fixed input and environment; velocity is fed back unchanged (no collisions). */
function run(input: MoveInput, ticks: number, env: MoveEnvironment = ground, start: MoveState = { ...createMoveState(), grounded: true }): MoveState {
  let state = start;
  for (let i = 0; i < ticks; i++) state = computeDesiredVelocity(state, input, env, DT);
  return state;
}

const horizontalSpeed = (state: MoveState) => Math.hypot(state.velocity.x, state.velocity.z);

describe("movement", () => {
  it("reaches walk, sprint and crouch speeds", () => {
    expect(horizontalSpeed(run(input({ forward: 1 }), 60))).toBeCloseTo(MOVEMENT.walkSpeed, 6);
    expect(horizontalSpeed(run(input({ forward: 1, sprint: true }), 60))).toBeCloseTo(MOVEMENT.sprintSpeed, 6);
    expect(horizontalSpeed(run(input({ forward: 1, crouch: true }), 60))).toBeCloseTo(MOVEMENT.crouchSpeed, 6);
  });

  it("lets speedScale exceed 1 for boost, up to maxSpeedScale", () => {
    expect(horizontalSpeed(run(input({ forward: 1, speedScale: 1.06 }), 60))).toBeCloseTo(MOVEMENT.walkSpeed * 1.06, 6);
    expect(horizontalSpeed(run(input({ forward: 1, speedScale: 3 }), 60))).toBeCloseTo(MOVEMENT.walkSpeed * MOVEMENT.maxSpeedScale, 6);
    expect(horizontalSpeed(run(input({ forward: 1, speedScale: -1 }), 60))).toBe(0);
  });

  it("jumps on a press and ignores it while allowJump is false", () => {
    expect(run(input({ jump: true }), 1).velocity.y).toBe(MOVEMENT.jumpVelocity);
    const gated = run(input({ jump: true, allowJump: false }), 1);
    expect(gated.velocity.y).toBeCloseTo(0, 9);
    expect(gated.jumpBufferTimer).toBe(0);
    // Held through the gate: no jump when it lifts, a fresh press is needed.
    expect(computeDesiredVelocity(gated, input({ jump: true }), ground, DT).velocity.y).toBeCloseTo(0, 9);
  });

  it("crawl forces prone at crawl speed with no sprint or jump", () => {
    const crawling = run(input({ forward: 1, sprint: true, jump: true, crouch: false, crawl: true }), 60);
    expect(crawling.stance).toBe("prone");
    expect(crawling.sprinting).toBe(false);
    expect(crawling.velocity.y).toBeCloseTo(0, 9);
    expect(horizontalSpeed(crawling)).toBeCloseTo(MOVEMENT.crawlSpeed, 6);
    expect(eyeHeightFor("prone")).toBe(MOVEMENT.proneEyeHeight);
  });

  it("gets up from prone only as far as the headroom allows", () => {
    const prone = run(input({ crawl: true }), 1);
    expect(computeDesiredVelocity(prone, idle, ground, DT).stance).toBe("stand");
    expect(computeDesiredVelocity(prone, idle, { ...ground, canStand: false }, DT).stance).toBe("crouch");
    expect(computeDesiredVelocity(prone, idle, { ...ground, canStand: false, canCrouch: false }, DT).stance).toBe("prone");
    expect(computeDesiredVelocity(prone, input({ crouch: true }), { ...ground, canCrouch: false }, DT).stance).toBe("prone");
    expect(computeDesiredVelocity(prone, input({ crouch: true }), ground, DT).stance).toBe("crouch");
    // Crouch under a low ceiling stays crouched, as before.
    const crouched = run(input({ crouch: true }), 1);
    expect(computeDesiredVelocity(crouched, idle, { ...ground, canStand: false }, DT).stance).toBe("crouch");
  });

  it("is deterministic", () => {
    const moves = [input({ forward: 1, right: 0.4, yaw: 0.7 }), input({ forward: -1, crouch: true, yaw: 2 }), input({ jump: true, speedScale: 1.06 }), input({ forward: 1, crawl: true })];
    const replay = () => moves.reduce((state, move) => run(move, 20, ground, state), { ...createMoveState(), grounded: true });
    expect(replay()).toEqual(replay());
  });
});

describe("fall damage", () => {
  const landed = { ...createMoveState(), grounded: true };

  it("tracks the pre-collision fall speed while airborne and reads it on the landing tick only", () => {
    const air = { ...createMoveState(), velocity: { x: 0, y: -13.9, z: 0 } };
    const unsupported: MoveEnvironment = { ...ground, supported: false };
    const falling = computeDesiredVelocity(air, idle, unsupported, DT);
    expect(falling.fallSpeed).toBeCloseTo(13.9 + MOVEMENT.gravity * DT, 9);
    // The solver stopped the capsule on contact; the landing still reads the speed it hit with.
    const blocked = { ...falling, velocity: { x: 0, y: 0, z: 0 } };
    const touchdown = computeDesiredVelocity(blocked, idle, ground, DT);
    expect(touchdown.fallSpeed).toBe(0);
    expect(landingSpeed(blocked, touchdown)).toBeCloseTo(14.3, 9);
    expect(landingSpeed(touchdown, touchdown)).toBe(0);
    expect(landingSpeed(falling, computeDesiredVelocity(falling, idle, unsupported, DT))).toBe(0);
    expect(landingSpeed(computeDesiredVelocity(landed, input({ jump: true }), ground, DT), landed)).toBe(0);
  });

  it("is harmless below the threshold, grows with impact energy and is lethal at lethalSpeed", () => {
    expect(fallDamage(MOVEMENT.jumpVelocity)).toBe(0);
    expect(fallDamage(FALL_DAMAGE.minSpeed)).toBe(0);
    expect(fallDamage(13)).toBeCloseTo(5.2, 6);
    expect(fallDamage(18.5)).toBeCloseTo(41.2, 6);
    expect(fallDamage(FALL_DAMAGE.lethalSpeed)).toBe(FALL_DAMAGE.lethalDamage);
    expect(fallDamage(MOVEMENT.maxFallSpeed)).toBeGreaterThan(FALL_DAMAGE.lethalDamage);
    expect(fallDamage(Number.NaN)).toBe(0);
  });

  it("a plain jump or a 3 m drop does no damage, a 13 m drop kills", () => {
    const dropSpeed = (height: number) => Math.sqrt(2 * MOVEMENT.gravity * height);
    expect(fallDamage(dropSpeed(1.2))).toBe(0);
    expect(fallDamage(dropSpeed(2.9))).toBe(0);
    expect(fallDamage(dropSpeed(13.1))).toBeGreaterThanOrEqual(FALL_DAMAGE.lethalDamage);
  });
});
