import { Color3, Vector3 } from "@babylonjs/core";
import { describe, expect, it } from "vitest";
import type { FxBatch } from "../../src/fx/FxBatch";
import { FxCell } from "../../src/fx/fxAtlas";
import { ImpactEffects, MIRROR_CRAZING } from "../../src/fx/ImpactEffects";
import type { ParticlePool } from "../../src/fx/ParticlePool";
import { MIRROR_HOLE } from "../../src/world/props/MirrorWalls";

// The crazing round a mirror's see-through hole. The hole is there to look through, so the one thing that must stay
// true is that nothing pale is ever drawn across it (the owner, 2026-09-18: "để lại vòng tròn trắng khiến khó nhìn").

interface Drawn {
  readonly halfSize: number;
  readonly cell: number;
  readonly alpha: number;
}

function effects(): { impacts: ImpactEffects; drawn: Drawn[] } {
  const drawn: Drawn[] = [];
  const batch = {
    decal: (_p: Vector3, _n: Vector3, halfSize: number, _r: number, cell: number, _c: Color3, alpha: number) => {
      drawn.push({ halfSize, cell, alpha });
    },
  } as unknown as FxBatch;
  const pool = null as unknown as ParticlePool;
  return { impacts: new ImpactEffects(pool, pool, batch), drawn };
}

const UP = new Vector3(0, 0, 1);

describe("mirror aperture crazing", () => {
  it("draws one faint ring, wholly outside the hole", () => {
    const { impacts, drawn } = effects();
    impacts.pierce(new Vector3(0, 1.3, 10), UP, MIRROR_HOLE.diameter);
    impacts.update(0.016);

    expect(drawn).toHaveLength(1);
    const ring = drawn[0]!;
    expect(ring.cell).toBe(FxCell.ring);
    // The ring sprite is transparent inside 0.62 of its half size (fxAtlas.drawRing), so that radius is where it
    // starts to show: it has to clear the hole's own radius, or the hole is being drawn over.
    expect(ring.halfSize * 0.62).toBeGreaterThan(MIRROR_HOLE.diameter / 2);
    // Faint, and on its way out rather than parked at full strength for the rest of the match.
    expect(ring.alpha).toBeLessThanOrEqual(MIRROR_CRAZING.alpha);
    impacts.update(MIRROR_CRAZING.life);
    expect(drawn).toHaveLength(1);
  });

  it("gives the two faces a round crosses one ring, not two stacked on the same hole", () => {
    const { impacts, drawn } = effects();
    // Entry and exit, 0.26 m apart: MIRROR_PANEL.faceOffset either side of the panel's centre plane.
    impacts.pierce(new Vector3(0, 1.3, 9.87), UP, MIRROR_HOLE.diameter);
    impacts.pierce(new Vector3(0, 1.3, 10.13), UP.negate(), MIRROR_HOLE.diameter);
    impacts.update(0.016);
    expect(drawn).toHaveLength(1);

    // A later round is its own hole, whatever it stands next to.
    impacts.pierce(new Vector3(0, 1.3, 9.87), UP, MIRROR_HOLE.diameter);
    drawn.length = 0;
    impacts.update(0.016);
    expect(drawn).toHaveLength(2);
  });

  it("still bores a dark hole in a pane that has no aperture", () => {
    const { impacts, drawn } = effects();
    impacts.pierce(new Vector3(0, 1.3, 10), UP);
    impacts.update(0.016);
    // wall_glass keeps its rim-plus-bore mark: that pane is still there where the round went through.
    expect(drawn).toHaveLength(2);
    expect(drawn.map((d) => d.cell)).toEqual([FxCell.hole, FxCell.spark]);
  });
});
