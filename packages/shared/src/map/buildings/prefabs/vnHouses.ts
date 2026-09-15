import { KIT, PrefabBuilder, type Range } from "../kit";
import type { BuildingPrefab } from "../types";
import { CEILING, doorAprons, H, lootRoom, parapetRing, RAISED, SKIN, T, WALL, type Rect } from "./vnCommon";

/** Vietnamese city houses: mezzanine shophouse, French colonial shophouse, café, villa, boarding house. Front is +Z. */

const SMALL_WINDOW = { width: 0.8, sill: 1.5, head: 2.2 } as const;
const BALCONY = 1.0;

/**
 * Tube house with a gác lửng: a 4.5 m shop story with a mezzanine over its back half, one upper story and a parapet roof.
 * Flight 1 climbs the west core to a landing beside the mezzanine, flight 2 carries on to the upper floor.
 */
export function mezzanineTubeHouse(): BuildingPrefab {
  const b = new PrefabBuilder("tube_house_mezzanine", "Tube house (mezzanine shop)");
  const [hw, hd] = [2.5, 7.5];
  const ix: Range = [-hw + T, hw - T];
  const iz: Range = [-hd + T, hd - T];
  const core: Range = [ix[0], ix[0] + KIT.stairs.width];
  const G = 4.5;
  const M = 2.25;
  const top = G + H;
  const mezzFront = -0.4;
  const landing: Range = [-1.4, mezzFront];
  const flight2End = -3.5;
  /** The upper slab opens 0.5 m over the landing, so a standing player fits on the first treads of flight 2. */
  const holeFront = landing[0] + 0.5;
  const partition: Range = [-4.95, -4.8];
  const shopDoor = 3;

  b.foundation([-hw, hw], [-hd, hd], "concrete");
  b.shell({
    ...WALL,
    x: [-hw, hw],
    z: [-hd, hd],
    y: [0, G],
    openings: { "+z": [{ kind: "door", at: 0, width: shopDoor, head: 3.2 }], "-z": [{ kind: "window", at: 0.4, width: 0.8, sill: 1.2, head: 1.9 }, { kind: "window", at: 0.4, width: 0.8, sill: 3.3, head: 4.0 }] },
  });
  b.flight({ dir: "-z", start: 1.7, across: core, fromY: 0, toY: M, solid: true, material: "concrete", balustrade: ["max"] });
  b.slab({ x: [core[1], ix[1]], z: [iz[0], mezzFront], y: [M - KIT.slabThickness, M], top: "woodFloor", bottom: "plasterInterior", side: "woodTrim" });
  b.slab({ x: core, z: landing, y: [M - KIT.slabThickness, M], top: "woodFloor", bottom: "plasterInterior", side: "woodTrim" });
  b.flight({ dir: "-z", start: landing[0], across: core, fromY: M, toY: G, solid: false, material: "concrete" });
  b.railing([[core[1] + 0.035, mezzFront - 0.035], [ix[1] - 0.035, mezzFront - 0.035]], M, "darkSteel");
  b.slab({ x: ix, z: iz, y: [G - KIT.slabThickness, G], holes: [{ x: core, z: [flight2End, holeFront] }], top: "concrete", bottom: "plasterInterior", side: "plaster" });
  b.box([-shopDoor / 2 - 0.1, shopDoor / 2 + 0.1], [3.35, 3.67], [iz[1] - 0.4, iz[1] - 0.05], "darkSteel", "prop");
  b.box([-hw, hw], [3.45, 4.25], [hd, hd + 0.2], "paintedSteel", "prop");

  const shopShelf: Rect = { x: [ix[1] - 0.55, ix[1]], z: [1.0, iz[1] - 1.2] };
  b.box(shopShelf.x, [0, 1.9], shopShelf.z, "woodTrim", "prop");
  lootRoom(b, "shop", 0, { x: [core[1], ix[1]], z: [mezzFront, iz[1]] }, [...doorAprons("x", [-shopDoor / 2, shopDoor / 2], [iz[1], hd], "min"), shopShelf], [[0.5, 2.5]]);
  lootRoom(b, "store", 0, { x: [core[1], ix[1]], z: [iz[0], mezzFront] }, [], [[1.5, -5]]);
  lootRoom(b, "mezzanine", M, { x: [core[1], ix[1]], z: [iz[0], mezzFront - 0.1] }, [], [[1, -4]]);

  // Upper story.
  const y0 = G;
  const balconyDoor: Range = [hw - 1.1 - KIT.door.width / 2, hw - 1.1 + KIT.door.width / 2];
  const innerDoorAt = ix[1] - 0.8;
  const innerDoor: Range = [innerDoorAt - 0.5, innerDoorAt + 0.5];
  b.shell({ ...WALL, x: [-hw, hw], z: [-hd, hd], y: [y0, top], openings: { "+z": [{ kind: "window", at: -hw + 1.05 }, { kind: "door", u: balconyDoor }], "-z": [{ kind: "window", at: 0.4, ...SMALL_WINDOW }] } });
  b.slab({ x: ix, z: iz, y: [y0 + CEILING, top], top: "roofAsphalt", bottom: "plasterInterior", side: "plaster", role: "roof" });
  b.wall({ interior: "plasterInterior", axis: "z", along: [flight2End, holeFront], across: [core[1], core[1] + 0.1], y: [y0, y0 + CEILING] });
  b.railing([[core[0] + 0.035, holeFront + 0.04], [core[1] - 0.035, holeFront + 0.04]], y0, "darkSteel");
  b.wall({ interior: "plasterInterior", frame: "woodTrim", axis: "x", along: ix, across: partition, y: [y0, y0 + CEILING], openings: [{ kind: "door", u: innerDoor }] });
  const partitionAprons = doorAprons("x", innerDoor, partition);
  lootRoom(b, "front1", y0, { x: [core[1] + 0.1, ix[1]], z: [partition[1], iz[1]] }, [...doorAprons("x", balconyDoor, [iz[1], hd], "min"), ...partitionAprons], [[innerDoorAt, partition[1]]]);
  lootRoom(b, "back1", y0, { x: ix, z: [iz[0], partition[0]] }, partitionAprons, [[innerDoorAt, partition[0]]]);
  b.slab({ x: [-hw, hw], z: [hd, hd + BALCONY], y: [y0 - KIT.slabThickness, y0], top: "concrete", bottom: "plaster", side: "plaster" });
  b.railing([[-hw + 0.035, hd + 0.035], [-hw + 0.035, hd + BALCONY - 0.035], [hw - 0.035, hd + BALCONY - 0.035], [hw - 0.035, hd + 0.035]], y0, "darkSteel");
  b.room("balcony1", y0, [-hw + 0.1, -hw + 4.7], [hd + 0.05, hd + BALCONY - 0.1], false);
  parapetRing(b, [-hw, hw], [-hd, hd], top, 0.9);
  return b.entrance(0, 0, hd + 0.75).build();
}

/**
 * Nhà phố Pháp: two-story colonial shophouse, 10 m frontage, a covered arcade under the upper floor, tall windows with
 * wooden shutters, cornice and balustraded parapet.
 */
export function frenchShophouse(): BuildingPrefab {
  const b = new PrefabBuilder("shophouse_french", "French colonial shophouse");
  const [hw, back, front, arcade] = [5, -6, 4, 6.5];
  const ix: Range = [-hw + T, hw - T];
  const core: Range = [ix[0], ix[0] + KIT.stairs.width];
  const coreWall: Range = [core[1], core[1] + 0.1];
  const stair: Range = [-1.35, 1.35];
  const partition: Range = [-2.65, -2.5];
  const shutter = (y0: number, at: number, face: number) => {
    const [u0, u1] = [at - 0.6, at + 0.6];
    for (const u of [[u0 - 0.64, u0 - 0.09], [u1 + 0.09, u1 + 0.64]] as const) b.box(u, [y0 + 0.95, y0 + 2.35], [face, face + 0.05], "woodTrim", "prop");
  };

  b.foundation([-hw, hw], [back, arcade], "concrete");
  // Ground floor: shop and back room behind the arcade.
  b.shell({
    ...WALL,
    x: [-hw, hw],
    z: [back, front],
    y: [0, H],
    openings: { "+z": [{ kind: "window", at: -3.3 }, { kind: "door", at: 0, width: 2.4, head: 2.6 }, { kind: "window", at: 3.3 }], "-z": [{ kind: "window", at: 2, ...SMALL_WINDOW }] },
  });
  for (const at of [-3.3, 3.3]) shutter(0, at, front);
  b.slab({ x: ix, z: [back + T, front - T], y: [CEILING, H], holes: [{ x: core, z: stair }], top: "woodFloor", bottom: "plasterInterior", side: "plaster" });
  b.slab({ x: [-hw, hw], z: [front, arcade], y: [CEILING, H], top: "woodFloor", bottom: "plaster", side: "plaster" });
  for (const x of [[-hw, -hw + 0.4], [-1.8, -1.4], [1.4, 1.8], [hw - 0.4, hw]] as const) b.box(x, [0, CEILING], [arcade - 0.4, arcade], "plaster", "structure");
  b.box([-hw - 0.1, hw + 0.1], [2.55, 2.8], [arcade, arcade + 0.12], "plaster", "prop");
  b.flight({ dir: "-z", start: stair[1], across: core, fromY: 0, toY: H, solid: true, material: "concrete", balustrade: ["max"] });
  b.wall({ interior: "plasterInterior", frame: "woodTrim", axis: "x", along: [coreWall[1], ix[1]], across: partition, y: [0, CEILING], openings: [{ kind: "door", u: [2.95, 4.05] }] });
  const doorAt: Range = [2.95, 4.05];
  const counter: Rect = { x: [1.8, 4.4], z: [-0.4, 0.2] };
  b.box(counter.x, [0, 1.0], counter.z, "woodTrim", "prop");
  lootRoom(b, "shop", 0, { x: [coreWall[1], ix[1]], z: [partition[1], front - T] }, [...doorAprons("x", [-1.2, 1.2], [front - T, front], "min"), ...doorAprons("x", doorAt, partition, "max"), counter], [[-2, -1.5]]);
  lootRoom(b, "storeroom", 0, { x: [coreWall[1], ix[1]], z: [back + T, partition[0]] }, doorAprons("x", doorAt, partition, "min"), [[3.5, -4.5]]);
  b.room("arcade", 0, [-1.3, 1.3], [front + 0.1, arcade - 0.4], false);

  // Upper floor over the arcade.
  const y0 = H;
  b.shell({
    ...WALL,
    x: [-hw, hw],
    z: [back, arcade],
    y: [y0, 2 * H],
    openings: { "+z": [{ kind: "window", at: -3.3 }, { kind: "window", at: 0 }, { kind: "window", at: 3.3 }], "-z": [{ kind: "window", at: 2, ...SMALL_WINDOW }] },
  });
  for (const at of [-3.3, 0, 3.3]) shutter(y0, at, arcade);
  b.slab({ x: ix, z: [back + T, arcade - T], y: [y0 + CEILING, 2 * H], top: "roofAsphalt", bottom: "plasterInterior", side: "plaster", role: "roof" });
  b.wall({ interior: "plasterInterior", axis: "z", along: stair, across: coreWall, y: [y0, y0 + CEILING] });
  b.railing([[core[0] + 0.035, stair[1] + 0.04], [core[1] - 0.035, stair[1] + 0.04]], y0, "darkSteel");
  b.wall({ interior: "plasterInterior", frame: "woodTrim", axis: "x", along: [coreWall[1], ix[1]], across: partition, y: [y0, y0 + CEILING], openings: [{ kind: "door", u: doorAt }] });
  lootRoom(b, "salon", y0, { x: [coreWall[1], ix[1]], z: [partition[1], arcade - T] }, doorAprons("x", doorAt, partition, "max"), [[1, 2]]);
  lootRoom(b, "bedroom", y0, { x: [coreWall[1], ix[1]], z: [back + T, partition[0]] }, doorAprons("x", doorAt, partition, "min"), [[0, -4.5]]);
  b.box([-hw - 0.15, hw + 0.15], [2 * H - 0.3, 2 * H], [arcade, arcade + 0.2], "plaster", "prop");
  parapetRing(b, [-hw, hw], [back, arcade], 2 * H, 0.9, 0.25);
  return b.entrance(0, 0, arcade + 0.75).build();
}

/** Quán cà phê: two-story café with a tiled front terrace under an awning, tables, planters and a small balcony. */
export function cafe(): BuildingPrefab {
  const b = new PrefabBuilder("cafe_terrace", "Café with terrace");
  const [hw, back, front, terrace] = [3.5, -6, 4, 7.5];
  const ix: Range = [-hw + T, hw - T];
  const core: Range = [ix[0], ix[0] + KIT.stairs.width];
  const coreWall: Range = [core[1], core[1] + 0.1];
  const stair: Range = [-2.2, 0.5];
  const openFront: Range = [-2.2, 1.0];

  b.foundation([-hw, hw], [back, terrace], "concrete");
  b.shell({ ...WALL, x: [-hw, hw], z: [back, front], y: [0, H], openings: { "+z": [{ kind: "door", u: openFront, head: 2.6 }, { kind: "window", at: 2.3 }], "-z": [{ kind: "window", at: 1, ...SMALL_WINDOW }] } });
  b.slab({ x: ix, z: [back + T, front - T], y: [CEILING, H], holes: [{ x: core, z: stair }], top: "concrete", bottom: "plasterInterior", side: "plaster" });
  b.flight({ dir: "-z", start: stair[1], across: core, fromY: 0, toY: H, solid: true, material: "concrete", balustrade: ["max"] });
  const counter: Rect = { x: [0.8, ix[1]], z: [-3.6, -3.0] };
  b.box(counter.x, [0, 1.05], counter.z, "woodTrim", "prop");
  lootRoom(b, "cafe", 0, { x: [coreWall[0], ix[1]], z: [back + T, front - T] }, [...doorAprons("x", openFront, [front - T, front], "min"), counter], [[2.2, -4.8]]);

  // Terrace: tiles, tables and planters stand on it; the awning hangs off the balcony slab.
  const terraceRoom: Rect = { x: [-hw + 0.1, hw - 0.1], z: [front + 0.05, terrace - 0.35] };
  lootRoom(b, "terrace", 0, terraceRoom, doorAprons("x", openFront, [front - T, front], "max"), [[2.6, 4.9]], false);
  for (const x of [[-2.8, -2.1], [-0.6, 0.1]] as const) b.box(x, [RAISED, 0.85], [5.9, 6.6], "woodTrim", "prop");
  for (const x of [[-hw, -1.0], [1.0, hw]] as const) b.box(x, [0, 0.7], [terrace - 0.3, terrace], "roofMetal", "prop");
  b.slab({ x: [-hw, hw], z: [front, front + 1.2], y: [CEILING, H], top: "concrete", bottom: "plaster", side: "plaster" });
  b.wedge([-hw, hw], [2.45, 2.75], [front + 1.2, terrace + 0.1], "-z", "containerRed", "containerRed", "roof");
  // Awning posts stand on the planters, so no pocket opens between them.
  for (const x of [-hw + 0.1, hw - 0.1]) b.box([x - 0.05, x + 0.05], [0.7, 2.45], [terrace - 0.2, terrace - 0.1], "darkSteel", "structure");

  const y0 = H;
  const balconyDoor: Range = [0.95, 2.05];
  b.shell({ ...WALL, x: [-hw, hw], z: [back, front], y: [y0, 2 * H], openings: { "+z": [{ kind: "window", at: -1.6 }, { kind: "door", u: balconyDoor }], "-z": [{ kind: "window", at: 1, ...SMALL_WINDOW }] } });
  b.slab({ x: ix, z: [back + T, front - T], y: [y0 + CEILING, 2 * H], top: "roofAsphalt", bottom: "plasterInterior", side: "plaster", role: "roof" });
  b.wall({ interior: "plasterInterior", axis: "z", along: stair, across: coreWall, y: [y0, y0 + CEILING] });
  b.railing([[core[0] + 0.035, stair[1] + 0.04], [core[1] - 0.035, stair[1] + 0.04]], y0, "darkSteel");
  lootRoom(b, "upstairs", y0, { x: [coreWall[1], ix[1]], z: [back + T, front - T] }, doorAprons("x", balconyDoor, [front - T, front], "min"), [[2, -4]]);
  b.railing([[-hw + 0.035, front + 0.035], [-hw + 0.035, front + 1.165], [hw - 0.035, front + 1.165], [hw - 0.035, front + 0.035]], y0, "darkSteel");
  b.box([-hw, hw], [2 * H, 2 * H + 0.8], [front - 0.2, front], "plaster", "railing");
  b.box([-hw, hw], [2 * H, 2 * H + 0.8], [back, back + 0.2], "plaster", "railing");
  b.box([hw - 0.2, hw], [2 * H, 2 * H + 0.8], [back + 0.2, front - 0.2], "plaster", "railing");
  b.box([-hw, -hw + 0.2], [2 * H, 2 * H + 0.8], [back + 0.2, front - 0.2], "plaster", "railing");
  return b.entrance(0, 0, terrace + 0.75).build();
}

/** Biệt thự: two-story villa with a tiled gable roof, porch balcony and back door, in a walled garden with a gate. */
export function villa(): BuildingPrefab {
  const b = new PrefabBuilder("villa", "Villa with walled garden");
  const [gw, gd] = [9, 10];
  const [hx, back, front] = [5, -7, 2];
  const ix: Range = [-hx + T, hx - T];
  const iz: Range = [back + T, front - T];
  const core: Range = [ix[0], ix[0] + KIT.stairs.width];
  const coreWall: Range = [core[1], core[1] + 0.1];
  const stair: Range = [-2.2, 0.5];
  const partition: Range = [-3.65, -3.5];
  const wallY: Range = [-0.3, 2.0];

  // Garden wall and gate.
  b.box([-gw, -1.9], wallY, [gd - T, gd], "plaster", "wall");
  b.box([1.9, gw], wallY, [gd - T, gd], "plaster", "wall");
  b.box([-gw, gw], wallY, [-gd, -gd + T], "plaster", "wall");
  b.box([-gw, -gw + T], wallY, [-gd + T, gd - T], "plaster", "wall");
  b.box([gw - T, gw], wallY, [-gd + T, gd - T], "plaster", "wall");
  for (const x of [[-1.9, -1.5], [1.5, 1.9]] as const) b.box(x, [-0.3, 2.6], [gd - 0.3, gd + 0.1], "plaster", "structure");
  b.box([4.2, 6.1], [0, 1.4], [4.0, 8.2], "paintedSteel", "prop");
  b.box([-7.6, -6.4], [0, 0.6], [5.5, 6.7], "roofMetal", "prop");

  b.foundation([-hx, hx], [back, front], "woodFloor");
  b.shell({ ...WALL, x: [-hx, hx], z: [back, front], y: [0, H], openings: { "+z": [{ kind: "door", at: -1.5, width: 1.2 }, { kind: "window", at: 1.5 }, { kind: "window", at: 3.5 }], "-z": [{ kind: "window", at: 0 }, { kind: "door", at: 3 }], "+x": [{ kind: "window", at: -5.2 }, { kind: "window", at: -1 }], "-x": [{ kind: "window", at: -5.5 }] } });
  b.slab({ x: ix, z: iz, y: [CEILING, H], holes: [{ x: core, z: stair }], top: "woodFloor", bottom: "plasterInterior", side: "plaster" });
  b.flight({ dir: "-z", start: stair[1], across: core, fromY: 0, toY: H, solid: true, material: "woodTrim", balustrade: ["max"] });
  const innerDoor: Range = [-0.5, 0.5];
  b.wall({ interior: "plasterInterior", frame: "woodTrim", axis: "x", along: [core[1], ix[1]], across: partition, y: [0, CEILING], openings: [{ kind: "door", u: innerDoor }] });
  const sofa: Rect = { x: [2.2, 4.4], z: [-2.4, -1.6] };
  b.box(sofa.x, [0, 0.8], sofa.z, "woodTrim", "prop");
  lootRoom(b, "living", 0, { x: [core[1], ix[1]], z: [partition[1], iz[1]] }, [...doorAprons("x", [-2.1, -0.9], [iz[1], front], "min"), ...doorAprons("x", innerDoor, partition, "max"), sofa], [[-1.5, -2.5]], true, "woodFloor");
  lootRoom(b, "kitchen", 0, { x: [core[1], ix[1]], z: [iz[0], partition[0]] }, [...doorAprons("x", innerDoor, partition, "min"), ...doorAprons("x", [2.45, 3.55], [back, iz[0]], "max")], [[-2, -5.5]], true, "woodFloor");

  // Porch with a balcony on top.
  for (const x of [[-3, -2.7], [2.7, 3]] as const) b.box(x, [0, CEILING], [3.5, 3.8], "plaster", "structure");
  b.slab({ x: [-3, 3], z: [front, 3.8], y: [CEILING, H], top: "woodFloor", bottom: "plaster", side: "plaster" });

  const y0 = H;
  const balconyDoor: Range = [-0.55, 0.55];
  const upperDoor: Range = [-3.4, -2.4];
  b.shell({ ...WALL, x: [-hx, hx], z: [back, front], y: [y0, 2 * H], openings: { "+z": [{ kind: "window", at: -3.7 }, { kind: "door", u: balconyDoor }, { kind: "window", at: 3.7 }], "-z": [{ kind: "window", at: -2 }, { kind: "window", at: 2.5 }], "+x": [{ kind: "window", at: -2.5 }], "-x": [{ kind: "window", at: -5.5 }] } });
  b.slab({ x: ix, z: iz, y: [y0 + CEILING, 2 * H], top: "concrete", bottom: "plasterInterior", side: "plaster" });
  b.wall({ interior: "plasterInterior", axis: "z", along: stair, across: coreWall, y: [y0, y0 + CEILING] });
  b.railing([[core[0] + 0.035, stair[1] + 0.04], [core[1] - 0.035, stair[1] + 0.04]], y0, "woodTrim");
  b.wall({ interior: "plasterInterior", frame: "woodTrim", axis: "x", along: [coreWall[1], ix[1]], across: partition, y: [y0, y0 + CEILING], openings: [{ kind: "door", u: upperDoor }] });
  lootRoom(b, "bedroom1", y0, { x: [coreWall[1], ix[1]], z: [partition[1], iz[1]] }, [...doorAprons("x", balconyDoor, [iz[1], front], "min"), ...doorAprons("x", upperDoor, partition, "max")], [[3, -1]], true, "woodFloor");
  lootRoom(b, "bedroom2", y0, { x: [coreWall[1], ix[1]], z: [iz[0], partition[0]] }, doorAprons("x", upperDoor, partition, "min"), [[2, -5.5]], true, "woodFloor");
  b.railing([[-3 + 0.035, front + 0.035], [-3 + 0.035, 3.8 - 0.035], [3 - 0.035, 3.8 - 0.035], [3 - 0.035, front + 0.035]], y0, "woodTrim");
  b.room("balcony", y0, [-1.3, 1.3], [front + 0.05, 3.7], false);
  b.gableRoof({ x: [-hx, hx], z: [back, front], baseY: 2 * H, ridge: "x", pitchDeg: 30, eave: 0.6, gable: 0.4, roof: "roofMetal", body: "plaster", fascia: "woodTrim" });
  return b.entrance(0, 0, gd + 0.75).entrance(-1.5, 0, 4.4).build();
}

/** Nhà trọ: two-story row of rented rooms off an open front corridor, stair in the corridor, tin roof. */
export function boardingHouse(): BuildingPrefab {
  const b = new PrefabBuilder("boarding_house", "Boarding house (nhà trọ)");
  const [hw, back, front, edge] = [9, -3, 1.5, 3.9];
  const ix: Range = [-hw + T, hw - T];
  const units = [[-8.8, -4.475], [-4.325, -0.075], [0.075, 4.325], [4.475, 8.8]] as const;
  const doors = units.map(([x0]) => [x0 + 0.35, x0 + 1.45] as Range);
  const posts = [-8.95, -4.4, 0, 4.4, 8.95];
  const flight: Range = [1.7, 4.4];
  const flightAcross: Range = [front, 2.53];

  b.foundation([-hw, hw], [back, edge], "concrete");
  for (const story of [0, 1]) {
    const y0 = story * H;
    const windows = units.flatMap(([x0, x1], i) => (story === 0 && i === 2 ? [] : [{ kind: "window" as const, at: (x0 + x1) / 2 + 1.2, ...SMALL_WINDOW }]));
    b.shell({ ...WALL, x: [-hw, hw], z: [back, front], y: [y0, y0 + H], openings: { "+z": [...doors.map((u) => ({ kind: "door" as const, u })), ...windows], "-z": units.map(([x0, x1]) => ({ kind: "window" as const, at: (x0 + x1) / 2, ...SMALL_WINDOW })) } });
    b.slab({ x: ix, z: [back + T, front - T], y: [y0 + CEILING, y0 + H], top: story === 0 ? "concrete" : "plasterInterior", bottom: "plasterInterior", side: "plaster" });
    for (const x of [-4.475, 4.325]) b.wall({ interior: "plasterInterior", axis: "z", along: [back + T, front - T], across: [x, x + 0.15], y: [y0, y0 + CEILING] });
    b.wall({ interior: "plasterInterior", axis: "z", along: [back + T, front - T], across: [-0.075, 0.075], y: [y0, y0 + CEILING] });
    units.forEach(([x0, x1], i) => {
      const room: Rect = { x: [x0, x1], z: [back + T, front - T] };
      lootRoom(b, `room${story}${i}`, y0, room, doorAprons("x", doors[i]!, [front - T, front], "min"), [[(x0 + x1) / 2 + 1, -2]]);
    });
    for (const x of posts) b.box([x - 0.05, x + 0.05], [y0, y0 + CEILING], [edge - 0.15, edge - 0.05], "darkSteel", "structure");
    b.slab({ x: [-hw, hw], z: [front, edge], y: [y0 + CEILING, y0 + H], holes: story === 0 ? [{ x: flight, z: flightAcross }] : [], top: "concrete", bottom: "plaster", side: "plaster" });
  }
  b.flight({ dir: "+x", start: flight[0], across: flightAcross, fromY: 0, toY: H, solid: true, material: "concrete", balustrade: ["max"] });
  b.railing([[flight[0] - 0.04, front + 0.035], [flight[0] - 0.04, flightAcross[1] + 0.04], [flight[1] - 0.035, flightAcross[1] + 0.04]], H, "darkSteel");
  for (let i = 0; i + 1 < posts.length; i++) b.railing([[posts[i]! + 0.1, edge - 0.1], [posts[i + 1]! - 0.1, edge - 0.1]], H, "darkSteel");
  b.wedge([-hw - 0.4, hw + 0.4], [2 * H, 2 * H + 0.7], [back - 0.4, edge + 0.4], "-z", "corrugated", "corrugated", "roof");
  return b.entrance(-2.5, 0, edge + 0.75).build();
}

/**
 * Chung cư cũ: a five-story 1970s–80s apartment block. Three floors of flats open onto a front gallery with a solid
 * parapet; the stair climbs a well at the west end. The top two floors are a closed body (nav keeps 4 walkable levels
 * per column) whose gallery reads as thin parapet bands between the column fins.
 */
export function apartmentBlock(): BuildingPrefab {
  const b = new PrefabBuilder("apartment_block", "Old apartment block (chung cư cũ)");
  const [hw, back, front, edge] = [12, -5, 1.5, 3.3];
  const ix: Range = [-hw + T, hw - T];
  const iz: Range = [back + T, front - T];
  const core: Range = [ix[0], ix[0] + KIT.stairs.width];
  const coreWall: Range = [core[1], core[1] + 0.1];
  const stair: Range = [-2.5, 0.2];
  const wellWall: Range = [-9.2, -9.05];
  const wellDoor: Range = [-10.6, -9.3];
  const units: readonly Range[] = [[-9.05, -2.4], [-2.25, 4.65], [4.8, ix[1]]];
  const doors = units.map(([x0]) => [x0 + 0.6, x0 + 1.7] as Range);
  const columns = [-11.85, -6, 0, 6, 11.85];
  const closed = 3 * H;
  const top = 5 * H;
  const recess = 2.9;
  const columnRects: Rect[] = columns.map((c) => ({ x: [c - 0.15, c + 0.15], z: [3.0, edge] }));

  b.foundation([-hw, hw], [back, edge], "concrete");
  for (const c of columnRects) b.box(c.x, [0, top], c.z, "plaster", "structure");
  for (let s = 0; s < 3; s++) {
    const y0 = s * H;
    const flightAbove = s < 2;
    b.shell({
      ...WALL,
      x: [-hw, hw],
      z: [back, front],
      y: [y0, y0 + H],
      openings: {
        "+z": [{ kind: "door", u: wellDoor }, ...doors.map((u) => ({ kind: "door" as const, u })), ...units.map(([x0, x1]) => ({ kind: "window" as const, at: (x0 + x1) / 2 + 2 }))],
        "-z": units.map(([x0, x1]) => ({ kind: "window" as const, at: (x0 + x1) / 2 })),
        "+x": [{ kind: "window", at: -2 }],
      },
    });
    b.slab({ x: ix, z: iz, y: [y0 + CEILING, y0 + H], holes: flightAbove ? [{ x: core, z: stair }] : [], top: "concrete", bottom: "plasterInterior", side: "plaster" });
    if (flightAbove) b.flight({ dir: "-z", start: stair[1], across: core, fromY: y0, toY: y0 + H, solid: s === 0, material: "concrete", balustrade: s === 0 ? ["max"] : [] });
    if (s > 0) {
      b.wall({ interior: "plasterInterior", axis: "z", along: stair, across: coreWall, y: [y0, y0 + CEILING] });
      if (!flightAbove) b.railing([[core[0] + 0.035, stair[1] + 0.04], [core[1] - 0.035, stair[1] + 0.04]], y0, "darkSteel");
    }
    b.wall({ interior: "plasterInterior", axis: "z", along: iz, across: wellWall, y: [y0, y0 + CEILING] });
    for (const x of [-2.4, 4.65]) b.wall({ interior: "plasterInterior", axis: "z", along: iz, across: [x, x + 0.15], y: [y0, y0 + CEILING] });
    units.forEach(([x0, x1], i) => lootRoom(b, `flat${s}${i}`, y0, { x: [x0, x1], z: iz }, doorAprons("x", doors[i]!, [iz[1], front], "min"), [[(x0 + x1) / 2 - 1.5, -3.5]]));

    // Gallery: floor slab above (below the closed body on the top floor), parapets between the columns.
    if (s < 2) b.slab({ x: [-hw, hw], z: [front, edge], y: [y0 + CEILING, y0 + H], holes: columnRects, top: "concrete", bottom: "plaster", side: "plaster" });
    if (s > 0) {
      for (let i = 0; i + 1 < columns.length; i++) b.box([columns[i]! + 0.15, columns[i + 1]! - 0.15], [y0, y0 + 1.0], [edge - SKIN, edge], "plaster", "railing");
      for (const x of [[-hw, -hw + SKIN], [hw - SKIN, hw]] as const) b.box(x, [y0, y0 + 1.0], [front, 3.0], "plaster", "railing");
    }
  }

  // Closed top floors: body over the flats and most of the gallery, parapet bands and dark doors in the recess.
  b.box([-hw, hw], [closed, top], [back, front], "concrete", "structure", { "+y": "roofAsphalt", "-y": "plasterInterior" });
  b.box([-hw, hw], [closed - 0.2, top], [front, recess], "plaster", "structure", { "+y": "roofAsphalt", "-y": "plaster" });
  for (const y of [closed - 0.2, closed + H - 0.2]) {
    for (let i = 0; i + 1 < columns.length; i++) b.box([columns[i]! + 0.15, columns[i + 1]! - 0.15], [y, y + 1.2], [edge - SKIN, edge], "plaster", "railing");
    units.forEach(([x0, x1]) => {
      b.box([x0 + 0.6, x0 + 1.7], [y + 0.2, y + 2.4], [recess, recess + 0.05], "darkSteel", "prop");
      b.box([(x0 + x1) / 2 + 1.4, (x0 + x1) / 2 + 2.6], [y + 1.2, y + 2.5], [back - 0.05, back], "darkSteel", "prop");
    });
  }
  parapetRing(b, [-hw, hw], [back, recess], top, 0.9);
  b.box([5, 8], [top, top + 2], [-3, 0], "concrete", "structure");
  return b.entrance(-3, 0, edge + 0.75).build();
}
