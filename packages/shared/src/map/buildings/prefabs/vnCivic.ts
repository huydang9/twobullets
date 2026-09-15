import { PrefabBuilder, type Range } from "../kit";
import type { BuildingPrefab } from "../types";
import { doorAprons, H, lootRoom, RAISED, T, WALL, type Rect } from "./vnCommon";

/** Vietnamese civic buildings: pagoda, parish church, school, market hall. Front is +Z. */

/**
 * Chùa: a walled courtyard behind a tam quan gate, and a hall on a raised plinth with three doors, a veranda of wooden
 * columns and a two-pitch tiled roof whose flatter skirt and horn ends suggest the curved eaves.
 */
export function pagoda(): BuildingPrefab {
  const b = new PrefabBuilder("pagoda", "Pagoda (chùa)");
  const [gw, back, gate] = [8, -9, 11];
  const plinth = 0.45;
  const hall = { x: [-5.5, 5.5] as Range, z: [-8.5, -1.5] as Range };
  const eaves = 4.45;

  b.foundation([-gw, gw], [back, gate], "concrete");
  // Courtyard walls and the gate.
  const wallY: Range = [0, 2.2];
  b.box([-gw, gw], wallY, [back, back + T], "plaster", "wall");
  b.box([-gw, -gw + T], wallY, [back + T, gate - T], "plaster", "wall");
  b.box([gw - T, gw], wallY, [back + T, gate - T], "plaster", "wall");
  b.box([-gw, -2.3], wallY, [gate - T, gate], "plaster", "wall");
  b.box([2.3, gw], wallY, [gate - T, gate], "plaster", "wall");
  for (const x of [[-2.3, -1.8], [1.8, 2.3]] as const) b.box(x, [0, 3.4], [gate - 0.4, gate + 0.2], "plaster", "structure");
  b.box([-1.8, 1.8], [2.9, 3.4], [gate - 0.3, gate + 0.1], "woodTrim", "structure");
  b.gableRoof({ x: [-2.3, 2.3], z: [gate - 0.4, gate + 0.2], baseY: 3.4, ridge: "x", pitchDeg: 30, eave: 0.35, gable: 0.35, roof: "roofMetal", body: "plaster", fascia: "woodTrim" });
  b.box([-0.5, 0.5], [0, 1.1], [4.5, 5.5], "darkSteel", "prop");
  for (const x of [[-5, -4], [4, 5]] as const) b.box(x, [0, 0.8], [3, 4], "roofMetal", "prop");
  b.room("courtyard", 0, [-1.3, 1.3], [6.6, 8.6], false);

  // Hall on its plinth.
  b.box([-6, 6], [0, plinth], [back + T, -0.8], "concrete", "foundation");
  b.box([-2.5, 2.5], [0, plinth / 2], [-0.8, -0.4], "concrete", "stairs");
  const doors = [-3, 0, 3].map((at) => [at - 0.7, at + 0.7] as Range);
  b.shell({ ...WALL, frame: "woodTrim", x: hall.x, z: hall.z, y: [plinth, eaves], openings: { "+z": doors.map((u) => ({ kind: "door" as const, u, head: 2.6 })), "+x": [{ kind: "window", at: -5 }], "-x": [{ kind: "window", at: -5 }] } });
  b.slab({ x: [hall.x[0] + T, hall.x[1] - T], z: [hall.z[0] + T, hall.z[1] - T], y: [eaves - 0.2, eaves], top: "concrete", bottom: "woodTrim", side: "plaster" });
  for (const x of [[-4.75, -4.45], [-1.65, -1.35], [1.35, 1.65], [4.45, 4.75]] as const) b.box(x, [plinth, eaves], [-1.25, -0.95], "woodTrim", "structure");
  const altar: Rect = { x: [-3, 3], z: [-8.3, -7.3] };
  b.box(altar.x, [plinth, 1.6], altar.z, "woodTrim", "prop");
  b.box([-0.6, 0.6], [1.6, 3.2], [-8.2, -7.6], "darkSteel", "prop");
  lootRoom(b, "hall", plinth, { x: [hall.x[0] + T, hall.x[1] - T], z: [hall.z[0] + T, hall.z[1] - T] }, [...doors.flatMap((u) => doorAprons("x", u, [hall.z[1] - T, hall.z[1]], "min")), altar], [[-4, -4], [4, -6]]);

  // Roof: flatter skirts over the eaves, an attic block, steeper upper pitches, ridge beam and horn ends.
  const attic = eaves + 0.68;
  const ridge = attic + 2.11;
  b.wedge([-6.2, 6.2], [eaves, attic], [-2.3, -0.2], "-z", "plaster", "roofMetal", "roof");
  b.wedge([-6.2, 6.2], [eaves, attic], [-9.8, -7.7], "+z", "plaster", "roofMetal", "roof");
  b.box(hall.x, [eaves, attic], [-7.7, -2.3], "plaster", "roof");
  b.wedge([-5.9, 5.9], [attic, ridge], [-5, -2.3], "-z", "plaster", "roofMetal", "roof");
  b.wedge([-5.9, 5.9], [attic, ridge], [-7.7, -5], "+z", "plaster", "roofMetal", "roof");
  b.box([-5.2, 5.2], [ridge, ridge + 0.26], [-5.1, -4.9], "roofMetal", "roof");
  for (const x of [[-5.6, -5.2], [5.2, 5.6]] as const) b.box(x, [ridge, ridge + 0.76], [-5.15, -4.85], "roofMetal", "roof");
  for (const z of [[-0.7, -0.2], [-9.8, -9.3]] as const) {
    b.wedge([6.2, 6.7], [eaves + 0.45, attic + 0.37], z, "+x", "plaster", "roofMetal", "roof");
    b.wedge([-6.7, -6.2], [eaves + 0.45, attic + 0.37], z, "-x", "plaster", "roofMetal", "roof");
  }
  return b.entrance(0, 0, gate + 0.75).build();
}

/** Nhà thờ: a small parish church, a nave with tall windows and pews, and a bell tower with an open belfry and spire. */
export function church(): BuildingPrefab {
  const b = new PrefabBuilder("church", "Parish church (nhà thờ)");
  const [hw, back, front, tower] = [5, -10, 6, 10];
  const wall = 6;
  const tallWindow = { sill: 1.0, head: 3.6 };

  b.foundation([-hw, hw], [back, front], "concrete");
  b.foundation([-2, 2], [front, tower], "concrete");
  const naveDoor: Range = [-0.7, 0.7];
  b.shell({
    ...WALL,
    x: [-hw, hw],
    z: [back, front],
    y: [0, wall],
    openings: {
      "+z": [{ kind: "door", u: naveDoor, head: 2.8 }],
      "-z": [{ kind: "window", at: 0, width: 0.8, sill: 3.5, head: 4.3 }],
      "+x": [-7, -3.5, 0, 3.5].map((at) => ({ kind: "window" as const, at, ...tallWindow })),
      "-x": [-7, -3.5, 0, 3.5].map((at) => ({ kind: "window" as const, at, ...tallWindow })),
    },
  });
  const ridge = wall + (hw + 0.5) * Math.tan((40 * Math.PI) / 180);
  b.wedge([-hw - 0.5, 0], [wall, ridge], [back - 0.4, front], "+x", "plaster", "roofMetal", "roof");
  b.wedge([0, hw + 0.5], [wall, ridge], [back - 0.4, front], "-x", "plaster", "roofMetal", "roof");

  // Pews and the altar stand on the raised floor.
  for (let k = 0; k <= 8; k++) {
    const z: Range = [-6 + 1.2 * k, -5.5 + 1.2 * k];
    b.box([-4.2, -1.1], [RAISED, 0.95], z, "woodTrim", "prop");
    b.box([1.1, 4.2], [RAISED, 0.95], z, "woodTrim", "prop");
  }
  b.box([-3, 3], [RAISED, 0.42], [back + T, -8], "woodFloor", "floor");
  b.box([-1, 1], [0.42, 1.3], [-9.5, -8.9], "woodTrim", "prop");
  lootRoom(b, "nave", 0, { x: [-hw + T, hw - T], z: [back + T, front - T] }, doorAprons("x", naveDoor, [front - T, front], "min"), [[0.3, 4.3], [0.3, -6.2]]);

  // Bell tower against the nave front: walls to 12 m, belfry openings, vestibule and belfry floors, spire and cross.
  const top = 12;
  const belfry = { sill: 9, head: 11 };
  const towerWall = { exterior: "plaster", interior: "plasterInterior", frame: "darkSteel" } as const;
  b.wall({ ...towerWall, axis: "x", along: [-2, 2], across: [tower - T, tower], y: [0, top], outside: "+z", openings: [{ kind: "door", at: 0, width: 1.4, head: 2.8 }, { kind: "hole", at: 0, width: 1.6, ...belfry }] });
  b.wall({ ...towerWall, axis: "z", along: [front, tower - T], across: [-2, -2 + T], y: [0, top], outside: "-x", openings: [{ kind: "hole", at: 8, width: 1.6, ...belfry }] });
  b.wall({ ...towerWall, axis: "z", along: [front, tower - T], across: [2 - T, 2], y: [0, top], outside: "+x", openings: [{ kind: "hole", at: 8, width: 1.6, ...belfry }] });
  b.wall({ ...towerWall, axis: "x", along: [-2 + T, 2 - T], across: [front, front + T], y: [wall, top], outside: "-z", openings: [{ kind: "hole", at: 0, width: 1.6, sill: belfry.sill - wall, head: belfry.head - wall }] });
  b.slab({ x: [-2 + T, 2 - T], z: [front, tower - T], y: [3.8, 4], top: "concrete", bottom: "plasterInterior", side: "plaster" });
  b.slab({ x: [-2 + T, 2 - T], z: [front + T, tower - T], y: [belfry.sill - 0.2, belfry.sill], top: "concrete", bottom: "plasterInterior", side: "plaster" });
  b.slab({ x: [-2 + T, 2 - T], z: [front + T, tower - T], y: [top - 0.2, top], top: "concrete", bottom: "plasterInterior", side: "plaster" });
  b.box([-2 + T, 2 - T], [11, 11.2], [7.9, 8.1], "woodTrim", "structure");
  b.box([-0.4, 0.4], [10, 11], [7.6, 8.4], "paintedSteel", "prop");
  const spire = top + 2.2 * Math.tan((70 * Math.PI) / 180);
  b.wedge([-2.2, 0], [top, spire], [front - 0.2, tower + 0.2], "+x", "plaster", "roofMetal", "roof");
  b.wedge([0, 2.2], [top, spire], [front - 0.2, tower + 0.2], "-x", "plaster", "roofMetal", "roof");
  b.box([-0.05, 0.05], [spire, spire + 1.4], [7.95, 8.05], "darkSteel", "prop");
  for (const x of [[-0.4, -0.05], [0.05, 0.4]] as const) b.box(x, [spire + 0.8, spire + 0.9], [7.95, 8.05], "darkSteel", "prop");
  return b.entrance(0, 0, tower + 0.75).build();
}

/**
 * Trường học: an L-plan, two-story school. Classrooms open onto galleries on the courtyard side; the stair runs up the
 * gallery at the east end. Flat roofs with parapets.
 */
export function school(): BuildingPrefab {
  const b = new PrefabBuilder("school", "School (trường học)");
  // Wing A along x with gallery A in front; wing B along z (west) with gallery B to its east.
  const A = { x: [-12, 12] as Range, z: [-8, -1] as Range };
  const galleryA: Rect = { x: [-12, 12], z: [-1, 1.2] };
  const B = { x: [-12, -5] as Range, z: [1.2, 12] as Range };
  const galleryB: Rect = { x: [-5, -2.8], z: [1.2, 12] };
  const flight: Range = [8.0, 10.7];
  const flightAcross: Range = [-0.98, 0.02];
  const columnsA = [-2.925, 0.6, 4.2, 7.8, 11.75];
  const columnsB = [4.6, 8.2, 11.875];
  const roomsA: Range[] = [[-11.8, -4.075], [-3.925, 3.925], [4.075, 11.8]];
  const doorsA = [-10.5, -2.7, 5.3].map((at) => [at - 0.55, at + 0.55] as Range);
  const roomsB: Range[] = [[1.4, 6.525], [6.675, 11.8]];
  const doorsB = [2.2, 7.5].map((at) => [at - 0.55, at + 0.55] as Range);

  b.foundation(A.x, [A.z[0], galleryA.z[1]], "concrete");
  b.foundation([B.x[0], galleryB.x[1]], B.z, "concrete");
  for (const story of [0, 1]) {
    const y0 = story * H;
    const roof = story === 1;
    const slabTop = roof ? "roofAsphalt" : "concrete";
    b.shell({
      ...WALL,
      x: A.x,
      z: A.z,
      y: [y0, y0 + H],
      openings: {
        "+z": [...doorsA.map((u) => ({ kind: "door" as const, u })), ...[-7, 1, 7].map((at) => ({ kind: "window" as const, at }))],
        "-z": [-9.5, -6, -1.5, 1.5, 6, 9.5].map((at) => ({ kind: "window" as const, at })),
        "+x": [{ kind: "window", at: -4.5 }],
        "-x": [{ kind: "window", at: -4.5 }],
      },
    });
    b.slab({ x: [A.x[0] + T, A.x[1] - T], z: [A.z[0] + T, A.z[1] - T], y: [y0 + H - 0.2, y0 + H], top: slabTop, bottom: "plasterInterior", side: "plaster", role: roof ? "roof" : "floor" });
    for (const x of [-4.075, 3.925]) b.wall({ interior: "plasterInterior", axis: "z", along: [A.z[0] + T, A.z[1] - T], across: [x, x + 0.15], y: [y0, y0 + H - 0.2] });
    b.shell({
      ...WALL,
      x: B.x,
      z: B.z,
      y: [y0, y0 + H],
      openings: {
        "+x": [...doorsB.map((u) => ({ kind: "door" as const, u })), { kind: "window", at: 4.5 }, { kind: "window", at: 10 }],
        "-x": [{ kind: "window", at: 4 }, { kind: "window", at: 9 }],
        "+z": [{ kind: "window", at: -8.5 }],
        "-z": [{ kind: "window", at: -8.5 }],
      },
    });
    b.slab({ x: [B.x[0] + T, B.x[1] - T], z: [B.z[0] + T, B.z[1] - T], y: [y0 + H - 0.2, y0 + H], top: slabTop, bottom: "plasterInterior", side: "plaster", role: roof ? "roof" : "floor" });
    b.wall({ interior: "plasterInterior", axis: "x", along: [B.x[0] + T, B.x[1] - T], across: [6.525, 6.675], y: [y0, y0 + H - 0.2] });

    b.slab({ ...galleryA, y: [y0 + H - 0.2, y0 + H], holes: story === 0 ? [{ x: flight, z: [galleryA.z[0], flightAcross[1]] }] : [], top: slabTop, bottom: "plaster", side: "plaster", role: roof ? "roof" : "floor" });
    b.slab({ ...galleryB, y: [y0 + H - 0.2, y0 + H], top: slabTop, bottom: "plaster", side: "plaster", role: roof ? "roof" : "floor" });
    for (const c of columnsA) b.box([c - 0.125, c + 0.125], [y0, y0 + H - 0.2], [0.95, 1.2], "plaster", "structure");
    for (const c of columnsB) b.box([-3.05, -2.8], [y0, y0 + H - 0.2], [c - 0.125, c + 0.125], "plaster", "structure");

    roomsA.forEach(([x0, x1], i) => {
      const mid = (x0 + x1) / 2;
      const desks: Rect[] = [{ x: [mid - 2.5, mid - 1.3], z: [-4.5, -4.0] }, { x: [mid + 0.5, mid + 1.7], z: [-4.5, -4.0] }];
      for (const d of desks) b.box(d.x, [y0 + RAISED, y0 + 0.87], d.z, "woodTrim", "prop");
      lootRoom(b, `classA${i}${story}`, y0, { x: [x0, x1], z: [A.z[0] + T, A.z[1] - T] }, doorAprons("x", doorsA[i]!, [A.z[1] - T, A.z[1]], "min"), [[mid, -6.5]]);
    });
    roomsB.forEach(([z0, z1], i) => {
      const mid = (z0 + z1) / 2;
      b.box([-9.8, -8.6], [y0 + RAISED, y0 + 0.87], [mid - 0.25, mid + 0.25], "woodTrim", "prop");
      lootRoom(b, `classB${i}${story}`, y0, { x: [B.x[0] + T, B.x[1] - T], z: [z0, z1] }, doorAprons("z", doorsB[i]!, [B.x[1] - T, B.x[1]], "min"), [[-10.8, mid + 1]]);
    });
  }
  b.flight({ dir: "+x", start: flight[0], across: flightAcross, fromY: 0, toY: H, solid: true, material: "concrete", balustrade: ["max"] });

  // Upper gallery guards: between columns, across the east and north ends, and round the stair hole.
  const y1 = H;
  const edgeA = 1.075;
  for (let i = 0; i + 1 < columnsA.length; i++) b.railing([[columnsA[i]! + 0.165, edgeA], [columnsA[i + 1]! - 0.165, edgeA]], y1, "darkSteel");
  b.railing([[11.95, -0.96], [11.95, 0.91]], y1, "darkSteel");
  const edgeB = -2.925;
  const stopsB = [1.075, ...columnsB];
  for (let i = 0; i + 1 < stopsB.length; i++) b.railing([[edgeB, stopsB[i]! + 0.165], [edgeB, stopsB[i + 1]! - 0.165]], y1, "darkSteel");
  b.railing([[-4.96, 11.95], [-3.09, 11.95]], y1, "darkSteel");
  b.railing([[flight[0] - 0.04, -0.965], [flight[0] - 0.04, flightAcross[1] + 0.04], [flight[1] - 0.035, flightAcross[1] + 0.04]], y1, "darkSteel");

  // Parapets round the whole L.
  const py: Range = [2 * H, 2 * H + 0.8];
  b.box(A.x, py, [A.z[0], A.z[0] + T], "plaster", "railing");
  b.box([A.x[1] - T, A.x[1]], py, [A.z[0] + T, galleryA.z[1] - T], "plaster", "railing");
  b.box([galleryB.x[1], A.x[1]], py, [galleryA.z[1] - T, galleryA.z[1]], "plaster", "railing");
  b.box([galleryB.x[1] - T, galleryB.x[1]], py, [galleryA.z[1] - T, B.z[1]], "plaster", "railing");
  b.box([B.x[0], galleryB.x[1] - T], py, [B.z[1] - T, B.z[1]], "plaster", "railing");
  b.box([A.x[0], A.x[0] + T], py, [A.z[0] + T, B.z[1] - T], "plaster", "railing");
  return b.entrance(5, 0, 1.95).entrance(-12.75, 0, 0.1).build();
}

/** Chợ: an open-sided market hall, columns under a low corrugated gable roof, rows of stall counters. */
export function marketHall(): BuildingPrefab {
  const b = new PrefabBuilder("market_hall", "Market hall (chợ)");
  const [hw, hd, eaves] = [10, 7, 4.2];
  b.foundation([-hw, hw], [-hd, hd], "concrete");
  lootRoom(b, "hall", 0, { x: [-hw + 0.2, hw - 0.2], z: [-hd + 0.2, hd - 0.2] }, [], [[-0.2, -3.2], [-7.7, 2.8], [5.8, -6.2]]);
  for (const cx of [-9.575, -4.8, 4.8, 9.575]) {
    for (const cz of [-6.625, 0, 6.625]) b.box([cx - 0.175, cx + 0.175], [RAISED, eaves], [cz - 0.175, cz + 0.175], "concrete", "structure");
  }
  for (const z of [[-5.2, -4.2], [-1.5, -0.5], [0.5, 1.5], [4.2, 5.2]] as const) {
    for (const x of [[-8.5, -5.5], [-4.2, -1.2], [1.2, 4.2], [5.5, 8.5]] as const) b.box(x, [RAISED, 0.95], z, "woodTrim", "prop");
  }
  b.box([8.6, 9.3], [RAISED, 0.9], [-2.6, -1.9], "woodPlanks", "prop");
  b.box([-9.3, -8.6], [RAISED, 0.9], [2.0, 2.7], "woodPlanks", "prop");
  b.gableRoof({ x: [-hw, hw], z: [-hd, hd], baseY: eaves, ridge: "x", pitchDeg: 16, eave: 0.6, gable: 0.4, roof: "corrugated", body: "corrugated", fascia: "darkSteel" });
  return b.entrance(0, 0, hd + 0.75).entrance(0, 0, -hd - 0.75).build();
}
