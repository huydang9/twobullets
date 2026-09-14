/**
 * Crossed-quad impostor planes about the prop's vertical axis, prop-local: normals at `offset + k × spacing` (mod π),
 * radians. Three quads at 0°/60°/120° have a spacing of π/3.
 */
export interface ImpostorPlanes {
  readonly spacing: number;
  readonly offset: number;
}

const ANGLE_TOLERANCE = (3 * Math.PI) / 180;

/**
 * Finds evenly spaced vertical planes in impostor geometry (any quad count), or null when the level isn't a crossed-quad
 * impostor, e.g. an octahedral or mesh impostor.
 */
export function detectImpostorPlanes(positions: ArrayLike<number>, indices: ArrayLike<number>): ImpostorPlanes | null {
  const angles: number[] = [];
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t]! * 3;
    const b = indices[t + 1]! * 3;
    const c = indices[t + 2]! * 3;
    const ux = positions[b]! - positions[a]!, uy = positions[b + 1]! - positions[a + 1]!, uz = positions[b + 2]! - positions[a + 2]!;
    const vx = positions[c]! - positions[a]!, vy = positions[c + 1]! - positions[a + 1]!, vz = positions[c + 2]! - positions[a + 2]!;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz);
    if (length === 0 || Math.abs(ny) > 0.2 * length) return null;
    angles.push(mod(Math.atan2(nz, nx), Math.PI));
  }
  angles.sort((x, y) => x - y);
  const planes: number[] = [];
  for (const angle of angles) {
    const last = planes[planes.length - 1];
    if (last === undefined || angle - last > ANGLE_TOLERANCE) planes.push(angle);
  }
  if (planes.length > 1 && Math.PI - planes[planes.length - 1]! + planes[0]! <= ANGLE_TOLERANCE) planes.pop();
  const k = planes.length;
  if (k < 2 || k > 8) return null;
  const spacing = Math.PI / k;
  const offset = mod(planes[0]!, spacing);
  if (planes.some((angle) => Math.abs(mod(angle - offset + spacing / 2, spacing) - spacing / 2) > ANGLE_TOLERANCE)) return null;
  return { spacing, offset };
}

/**
 * Turns a crossed-quad impostor about its pivot by at most half the plane spacing so that no plane is near edge-on to
 * the camera: an odd plane count faces one plane at it, an even count splits the view between two. For uniform-scale,
 * yaw-only matrices (Babylon row-major).
 */
export function faceImpostor(m: Float32Array, o: number, cameraX: number, cameraZ: number, planes: ImpostorPlanes): void {
  const view = Math.atan2(cameraZ - m[o + 14]!, cameraX - m[o + 12]!);
  // World angle of the local +X axis; a local direction at angle θ lands at θ + yaw.
  const yaw = Math.atan2(m[o + 2]!, m[o]!);
  const even = Math.round(Math.PI / planes.spacing) % 2 === 0;
  let delta = view - planes.offset - (even ? planes.spacing / 2 : 0) - yaw;
  delta -= planes.spacing * Math.round(delta / planes.spacing);
  const c = Math.cos(delta);
  const s = Math.sin(delta);
  for (let row = 0; row < 12; row += 4) {
    const x = m[o + row]!;
    const z = m[o + row + 2]!;
    m[o + row] = x * c - z * s;
    m[o + row + 2] = x * s + z * c;
  }
}

function mod(value: number, period: number): number {
  return ((value % period) + period) % period;
}
