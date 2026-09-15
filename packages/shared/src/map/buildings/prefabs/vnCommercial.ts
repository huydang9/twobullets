import { KIT, PrefabBuilder, type Range } from "../kit";
import type { BuildingPrefab } from "../types";
import { doorAprons, facadeBands, facadeFins, H, lootRoom, parapetRing, RAISED, SKIN, T, WALL, type Rect } from "./vnCommon";

/** Vietnamese city commercial buildings: kiosk, petrol station, workshop, office tower, high-rise, construction site. */

/** Cửa hàng tiện lợi: a one-story convenience store with a glass shopfront, sign band, awning, shelves and a counter. */
export function kiosk(): BuildingPrefab {
  const b = new PrefabBuilder("shop_kiosk", "Convenience store");
  const [hw, hd, wall] = [4, 5, 3.6];
  const ix: Range = [-hw + T, hw - T];
  const iz: Range = [-hd + T, hd - T];
  const frontDoor: Range = [-3.0, -1.4];
  const backDoor: Range = [-3.55, -2.45];
  b.foundation([-hw, hw], [-hd, hd], "concrete");
  b.shell({
    ...WALL,
    x: [-hw, hw],
    z: [-hd, hd],
    y: [0, wall],
    openings: {
      "+z": [{ kind: "door", u: frontDoor, head: 2.4 }, { kind: "window", u: [-0.8, 3.3], sill: 1.0, head: 2.6 }],
      "-z": [{ kind: "window", at: 0, width: 0.8, sill: 1.5, head: 2.2 }],
      "+x": [{ kind: "window", at: 0 }],
      "-x": [{ kind: "door", u: backDoor }],
    },
  });
  b.slab({ x: ix, z: iz, y: [wall - 0.2, wall], top: "roofAsphalt", bottom: "plasterInterior", side: "plaster", role: "roof" });
  b.box([-hw - 0.2, hw + 0.2], [2.9, 3.9], [hd, hd + 0.2], "paintedSteel", "prop");
  b.box([-hw, hw], [wall, 3.9], [-hd, -hd + T], "plaster", "railing");
  b.box([-hw, -hw + T], [wall, 3.9], [-hd + T, hd], "plaster", "railing");
  b.box([hw - T, hw], [wall, 3.9], [-hd + T, hd], "plaster", "railing");
  b.box([-3.6, 3.8], [2.7, 2.8], [hd + 0.2, hd + 1.4], "corrugated", "prop");
  const props: Rect[] = [
    { x: [-2.8, 2.2], z: [-1.0, -0.5] },
    { x: [-2.8, 2.2], z: [-3.0, -2.5] },
    { x: [3.2, 3.7], z: [-4.0, -1.5] },
    { x: [1.5, 3.6], z: [2.6, 3.2] },
  ];
  props.forEach((p, i) => b.box(p.x, [0, i === 3 ? 1.0 : 1.7], p.z, "woodTrim", "prop"));
  lootRoom(b, "store", 0, { x: ix, z: iz }, [...doorAprons("x", frontDoor, [iz[1], hd], "min"), ...doorAprons("z", backDoor, [-hw, ix[0]], "max"), ...props], [[1.5, -3.75], [-3, 0.75]]);
  return b.entrance(-2.2, 0, hd + 0.75).build();
}

/** Trạm xăng: a canopy on four columns over two pump islands, and a small shop behind it. */
export function petrolStation(): BuildingPrefab {
  const b = new PrefabBuilder("petrol_station", "Petrol station");
  const shop = { x: [-4, 4] as Range, z: [-6.5, -1.5] as Range };
  const door: Range = [-2.6, -1.4];
  b.foundation([-6.5, 6.5], [-6.5, 9.2], "concrete");
  b.shell({ ...WALL, x: shop.x, z: shop.z, y: [0, 3.2], openings: { "+z": [{ kind: "door", u: door }, { kind: "window", u: [-0.8, 3.2] }], "+x": [{ kind: "window", at: -4 }] } });
  b.slab({ x: [-4 + T, 4 - T], z: [shop.z[0] + T, shop.z[1] - T], y: [3.0, 3.2], top: "roofAsphalt", bottom: "plasterInterior", side: "plaster", role: "roof" });
  const counter: Rect = { x: [1.2, 3.6], z: [-5.0, -4.4] };
  const shelf: Rect = { x: [-3.6, -3.1], z: [-6.1, -3.5] };
  b.box(counter.x, [0, 1.0], counter.z, "woodTrim", "prop");
  b.box(shelf.x, [0, 1.8], shelf.z, "woodTrim", "prop");
  lootRoom(b, "shop", 0, { x: [-4 + T, 4 - T], z: [shop.z[0] + T, shop.z[1] - T] }, [...doorAprons("x", door, [shop.z[1] - T, shop.z[1]], "min"), counter, shelf], [[0, -5.5]]);

  for (const side of [-1, 1]) {
    const island: Range = side < 0 ? [-3.3, -2.5] : [2.5, 3.3];
    const column: Range = side < 0 ? [-3.1, -2.7] : [2.7, 3.1];
    b.box(island, [0, 0.2], [1.2, 7.2], "concrete", "structure");
    for (const z of [[1.4, 1.8], [6.6, 7.0]] as const) b.box(column, [0.2, 4.7], z, "plaster", "structure");
    b.box(side < 0 ? [-3.15, -2.65] : [2.65, 3.15], [0.2, 1.7], [3.6, 4.8], "paintedSteel", "prop");
  }
  b.slab({ x: [-6, 6], z: [-0.5, 8.5], y: [4.7, 5.3], top: "roofAsphalt", bottom: "plaster", side: "containerRed", role: "roof" });
  b.box([5.4, 6.0], [0, 6.5], [8.7, 9.1], "containerRed", "prop");
  b.room("forecourt", 0, [-1.2, 1.2], [2.9, 5.1], false);
  return b.entrance(-2, 0, -0.75).build();
}

/** Nhà kho / xưởng: a single-story workshop with a roll-up door opening, a corner office, benches and a low tin roof. */
export function workshop(): BuildingPrefab {
  const b = new PrefabBuilder("workshop", "Workshop (xưởng)");
  const [hw, hd, wall] = [6, 8, 4.5];
  const ix: Range = [-hw + T, hw - T];
  const iz: Range = [-hd + T, hd - T];
  const rollUp: Range = [-4.5, -0.5];
  const door: Range = [2.95, 4.05];
  const office: Rect = { x: [-5.8, -2.0], z: [-7.8, -4.0] };
  const officeDoor: Range = [-3.75, -2.65];
  const high = { width: 1.2, sill: 1.5, head: 2.3 };
  b.foundation([-hw, hw], [-hd, hd], "concrete");
  b.shell({
    ...WALL,
    x: [-hw, hw],
    z: [-hd, hd],
    y: [0, wall],
    openings: {
      "+z": [{ kind: "door", u: rollUp, head: 3.6 }, { kind: "door", u: door }],
      "-z": [{ kind: "window", at: 0, ...high }],
      "+x": [-4, 0, 4].map((at) => ({ kind: "window" as const, at, ...high })),
      "-x": [0, 4].map((at) => ({ kind: "window" as const, at, ...high })),
    },
  });
  b.box([rollUp[0] - 0.2, rollUp[1] + 0.2], [3.7, 4.1], [iz[1] - 0.45, iz[1] - 0.05], "darkSteel", "prop");
  b.gableRoof({ x: [-hw, hw], z: [-hd, hd], baseY: wall, ridge: "z", pitchDeg: 15, eave: 0.4, gable: 0.3, roof: "corrugated", body: "corrugated", fascia: "darkSteel" });
  b.wall({ interior: "plasterInterior", frame: "woodTrim", axis: "x", along: office.x, across: [office.z[1] - 0.15, office.z[1]], y: [0, 2.8], openings: [{ kind: "door", u: officeDoor }] });
  b.wall({ interior: "plasterInterior", axis: "z", along: [office.z[0], office.z[1] - 0.15], across: [office.x[1] - 0.15, office.x[1]], y: [0, 2.8] });
  b.slab({ x: office.x, z: office.z, y: [2.8, 3.0], top: "woodPlanks", bottom: "plasterInterior", side: "plaster" });
  const props: Rect[] = [
    { x: [3.0, 5.6], z: [-6.5, -5.7] },
    { x: [3.0, 5.6], z: [-2.5, -1.7] },
    { x: [-5.5, -4.5], z: [1, 2] },
  ];
  props.forEach((p) => b.box(p.x, [0, 0.9], p.z, "woodPlanks", "prop"));
  lootRoom(b, "workshop", 0, { x: ix, z: iz }, [office, ...props, ...doorAprons("x", rollUp, [iz[1], hd], "min"), ...doorAprons("x", door, [iz[1], hd], "min"), ...doorAprons("x", officeDoor, [office.z[1] - 0.15, office.z[1]], "max")], [[0, -6], [-4, 5]]);
  lootRoom(b, "office", 0, { x: [office.x[0], office.x[1] - 0.15], z: [office.z[0], office.z[1] - 0.15] }, doorAprons("x", officeDoor, [office.z[1] - 0.15, office.z[1]], "min"), [[-4.5, -6.5]]);
  return b.entrance(-2.5, 0, hd + 0.75).build();
}

/**
 * Office tower: 8 floors. The lobby and first floor are enterable (stair on the west wall); the six floors above are a
 * closed body behind a banded curtain wall with fins.
 */
export function officeTower(): BuildingPrefab {
  const b = new PrefabBuilder("office_tower", "Office tower (8 floors)");
  const [hw, hd, lobby] = [10, 8, 4];
  const top = lobby + H + 6 * H;
  const ix: Range = [-hw + T, hw - T];
  const iz: Range = [-hd + T, hd - T];
  const core: Range = [ix[0], ix[0] + KIT.stairs.width];
  const coreWall: Range = [core[1], core[1] + 0.1];
  const stair: Range = [-2.9, 1.0];
  const partition: Range = [-3.65, -3.5];
  const innerDoors = [[-6.55, -5.45], [4.45, 5.55]] as const;
  const frontDoor: Range = [-1.2, 1.2];
  const backDoor: Range = [5.45, 6.55];
  const tall = { sill: 1.0, head: 3.2 };

  b.foundation([-hw, hw], [-hd, hd], "concrete");
  b.shell({
    ...WALL,
    x: [-hw, hw],
    z: [-hd, hd],
    y: [0, lobby],
    openings: {
      "+z": [{ kind: "window", u: [-9.2, -5.4], ...tall }, { kind: "window", u: [-4.4, -2.2], ...tall }, { kind: "door", u: frontDoor, head: 2.8 }, { kind: "window", u: [2.2, 4.4], ...tall }, { kind: "window", u: [5.4, 9.2], ...tall }],
      "-z": [{ kind: "window", at: -6 }, { kind: "window", at: -2 }, { kind: "window", at: 2 }, { kind: "door", u: backDoor }],
      "+x": [-5.6, 0, 4].map((at) => ({ kind: "window" as const, at, ...tall })),
      "-x": [-6, 4.5].map((at) => ({ kind: "window" as const, at, ...tall })),
    },
  });
  b.slab({ x: ix, z: iz, y: [lobby - 0.2, lobby], holes: [{ x: core, z: stair }], top: "concrete", bottom: "plasterInterior", side: "plaster" });
  b.flight({ dir: "-z", start: stair[1], across: core, fromY: 0, toY: lobby, solid: true, material: "concrete", balustrade: ["max"] });
  b.wall({ interior: "plasterInterior", frame: "darkSteel", axis: "x", along: [core[1], ix[1]], across: partition, y: [0, lobby - 0.2], openings: innerDoors.map((u) => ({ kind: "door" as const, u })) });
  const desk: Rect = { x: [-2.5, 2.5], z: [2.8, 3.4] };
  b.box(desk.x, [0, 1.1], desk.z, "woodTrim", "prop");
  const aprons = (side: "min" | "max") => innerDoors.flatMap((u) => doorAprons("x", u, partition, side));
  lootRoom(b, "lobby", 0, { x: [core[1], ix[1]], z: [partition[1], iz[1]] }, [...doorAprons("x", frontDoor, [iz[1], hd], "min"), ...aprons("max"), desk], [[6, 0], [-6, 5]]);
  lootRoom(b, "mailroom", 0, { x: [core[1], ix[1]], z: [iz[0], partition[0]] }, [...aprons("min"), ...doorAprons("x", backDoor, [-hd, iz[0]], "max")], [[0, -6]]);
  b.slab({ x: [-3, 3], z: [hd, hd + 2], y: [3.3, 3.5], top: "roofAsphalt", bottom: "plaster", side: "darkSteel" });

  // First floor.
  const y0 = lobby;
  b.shell({
    ...WALL,
    x: [-hw, hw],
    z: [-hd, hd],
    y: [y0, y0 + H],
    openings: {
      "+z": [-7.5, -2.5, 2.5, 7.5].map((at) => ({ kind: "window" as const, at, width: 3, sill: 1.0, head: 2.6 })),
      "-z": [-6, -2, 2, 6].map((at) => ({ kind: "window" as const, at })),
      "+x": [-5.6, 0, 4].map((at) => ({ kind: "window" as const, at })),
      "-x": [-6, 4.5].map((at) => ({ kind: "window" as const, at })),
    },
  });
  b.wall({ interior: "plasterInterior", axis: "z", along: stair, across: coreWall, y: [y0, y0 + H] });
  b.railing([[core[0] + 0.035, stair[1] + 0.04], [core[1] - 0.035, stair[1] + 0.04]], y0, "darkSteel");
  b.wall({ interior: "plasterInterior", frame: "darkSteel", axis: "x", along: [coreWall[1], ix[1]], across: partition, y: [y0, y0 + H], openings: innerDoors.map((u) => ({ kind: "door" as const, u })) });
  for (const z of [[2, 2.8], [4.5, 5.3]] as const) for (const x of [[-6, -2], [2, 6]] as const) b.box(x, [y0 + RAISED, y0 + 0.85], z, "woodTrim", "prop");
  b.box([-2, 2], [y0 + RAISED, y0 + 0.85], [-6.2, -5.2], "woodTrim", "prop");
  lootRoom(b, "office1", y0, { x: [coreWall[1], ix[1]], z: [partition[1], iz[1]] }, aprons("max"), [[7.5, 0]]);
  lootRoom(b, "meeting1", y0, { x: [coreWall[1], ix[1]], z: [iz[0], partition[0]] }, aprons("min"), [[6, -6]]);

  // Closed body and curtain wall.
  const body: Range = [y0 + H, top];
  b.box([-hw + SKIN, hw - SKIN], body, [-hd + SKIN, hd - SKIN], "concrete", "structure", { "-y": "plasterInterior", "+y": "roofAsphalt" });
  facadeBands(b, [-hw, hw], [-hd, hd], body, H, 0.9, "plaster", "darkSteel");
  facadeFins(b, [-hw, hw], [-hd, hd], body, 2.5, "concrete");
  parapetRing(b, [-hw, hw], [-hd, hd], top, 1.2);
  b.box([-4, 4], [top, top + 2.5], [-3, 3], "plaster", "structure");
  b.box([-0.1, 0.1], [top + 2.5, top + 8], [-0.1, 0.1], "darkSteel", "prop");
  return b.entrance(0, 0, hd + 0.75).build();
}

/**
 * Chung cư cao tầng: a 16-floor apartment tower on a shop podium. The podium (three shops and a hall) is enterable,
 * its stair climbs to the roof terrace round the tower; the tower is a closed body with floor bands and pilasters.
 */
export function highrise(): BuildingPrefab {
  const b = new PrefabBuilder("highrise_apartment", "High-rise apartments (16 floors)");
  const [pw, pd, podium] = [15, 12, 4.5];
  const tower = { x: [-10, 10] as Range, z: [-9, 7] as Range };
  const top = podium + 15 * H;
  const ix: Range = [-pw + T, pw - T];
  const iz: Range = [-pd + T, pd - T];
  const core: Range = [ix[0], ix[0] + KIT.stairs.width];
  const stair: Range = [-2.2, 2.0];
  const shopWall: Range = [5.85, 6.0];
  const shopDoors = [-9, 0, 9].map((at) => [at - 1.2, at + 1.2] as Range);
  const innerDoors = [-9, 0, 9].map((at) => [at - 0.55, at + 0.55] as Range);
  const sideDoor: Range = [-6.7, -5.3];
  const tall = { sill: 1.0, head: 3.2 };

  b.foundation([-pw, pw], [-pd, pd], "concrete");
  b.shell({
    ...WALL,
    x: [-pw, pw],
    z: [-pd, pd],
    y: [0, podium],
    openings: {
      "+z": [...shopDoors.map((u) => ({ kind: "door" as const, u, head: 3.0 })), ...[-13, -3.2, 3.2, 13].map((at) => ({ kind: "window" as const, at, width: 2.4, ...tall }))],
      "-z": [-10, -5, 0, 5, 10].map((at) => ({ kind: "window" as const, at, width: 2, ...tall })),
      "+x": [{ kind: "door", u: sideDoor, head: 2.6 }, { kind: "window", at: 2, width: 2, ...tall }, { kind: "window", at: 9, width: 2, ...tall }],
      "-x": [{ kind: "door", u: sideDoor, head: 2.6 }, { kind: "window", at: -9.5, width: 2, ...tall }, { kind: "window", at: 9, width: 2, ...tall }],
    },
  });
  b.slab({ x: ix, z: iz, y: [podium - 0.2, podium], holes: [{ x: core, z: stair }], top: "roofAsphalt", bottom: "plasterInterior", side: "plaster" });
  b.flight({ dir: "-z", start: stair[1], across: core, fromY: 0, toY: podium, solid: true, material: "concrete", balustrade: ["max"] });
  b.railing([[core[0] + 0.035, stair[1] + 0.04], [core[1] + 0.04, stair[1] + 0.04], [core[1] + 0.04, stair[0] + 0.035]], podium, "darkSteel");
  parapetRing(b, [-pw, pw], [-pd, pd], podium, 1.0);

  // Shops along the front, a hall with columns behind.
  b.wall({ interior: "plasterInterior", frame: "darkSteel", axis: "x", along: ix, across: shopWall, y: [0, podium - 0.2], openings: innerDoors.map((u) => ({ kind: "door" as const, u })) });
  for (const x of [-5.075, 4.925]) b.wall({ interior: "plasterInterior", axis: "z", along: [shopWall[1], iz[1]], across: [x, x + 0.15], y: [0, podium - 0.2] });
  const shops: Range[] = [[ix[0], -5.075], [-4.925, 4.925], [5.075, ix[1]]];
  shops.forEach((x, i) => {
    lootRoom(b, `shop${i}`, 0, { x, z: [shopWall[1], iz[1]] }, [...doorAprons("x", shopDoors[i]!, [iz[1], pd], "min"), ...doorAprons("x", innerDoors[i]!, shopWall, "max")], [[(x[0] + x[1]) / 2 + 2.5, 8]]);
  });
  const columns: Rect[] = [];
  for (const cx of [-5, 5]) for (const cz of [-5, 2]) columns.push({ x: [cx - 0.3, cx + 0.3], z: [cz - 0.3, cz + 0.3] });
  for (const c of columns) b.box(c.x, [0, podium - 0.2], c.z, "concrete", "structure");
  lootRoom(b, "hall", 0, { x: [core[1], ix[1]], z: [iz[0], shopWall[0]] }, [...columns, ...innerDoors.flatMap((u) => doorAprons("x", u, shopWall, "min")), ...doorAprons("z", sideDoor, [ix[1], pw], "min")], [[8, -8], [-8, 0]]);
  b.room("terrace", podium, [-14.6, -12.1], [3, 5], false);

  // Tower body.
  const body: Range = [podium, top];
  const inner = { x: [tower.x[0] + SKIN, tower.x[1] - SKIN] as Range, z: [tower.z[0] + SKIN, tower.z[1] - SKIN] as Range };
  b.box(inner.x, body, inner.z, "concrete", "structure", { "+y": "roofAsphalt" });
  facadeBands(b, tower.x, tower.z, body, H, 1.0, "plaster", "darkSteel");
  facadeFins(b, tower.x, tower.z, body, 4, "plaster");
  parapetRing(b, tower.x, tower.z, top, 1.2);
  b.box([-3, 3], [top, top + 2.5], [-4, 2], "plaster", "structure");
  return b.entrance(0, 0, pd + 0.75).build();
}

/** Công trường: a concrete frame going up, three floors of slabs with stairs, scaffolding along the front, rebar stubs. */
export function constructionSite(): BuildingPrefab {
  const b = new PrefabBuilder("construction_site", "Construction site");
  const [hw, hd] = [8, 6];
  const xs: readonly Range[] = [[-8, -7.6], [-2.8, -2.4], [2.4, 2.8], [7.6, 8]];
  const zs: readonly Range[] = [[-6, -5.6], [-0.2, 0.2], [5.6, 6]];
  const stairAcross: Range = [-2.2, -1.1];
  const stair: Range = [0.2, 2.9];
  const openBay: Rect = { x: [2.8, hw], z: [0.2, hd] };

  b.foundation([-hw, hw], [-hd, hd], "concrete");
  for (const level of [0, 1, 2]) {
    const y0 = level * H;
    for (const x of xs) {
      for (const z of zs) {
        const inBay = x[0] >= openBay.x[0] && z[0] >= openBay.z[0];
        if (level === 2 && x[0] > 2.8) continue;
        if (level === 2 && inBay) continue;
        b.box(x, [y0, y0 + H - 0.2], z, "concrete", "structure");
        if (level === 1 && inBay) b.box([(x[0] + x[1]) / 2 - 0.02, (x[0] + x[1]) / 2 + 0.02], [y0 + H - 0.2, y0 + H + 0.6], [(z[0] + z[1]) / 2 - 0.02, (z[0] + z[1]) / 2 + 0.02], "darkSteel", "prop");
      }
    }
    const slabX: Range = level === 2 ? [-hw, 2.8] : [-hw, hw];
    const holes = [{ x: stairAcross, z: stair }, ...(level === 1 ? [openBay] : [])];
    b.slab({ x: slabX, z: [-hd, hd], y: [y0 + H - 0.2, y0 + H], holes, top: "concrete", bottom: "concrete", side: "concrete", role: level === 2 ? "roof" : "floor" });
    b.flight({ dir: "-z", start: stair[1], across: stairAcross, fromY: y0, toY: y0 + H, solid: level === 0, material: "concrete" });
  }
  for (const [x, z] of [[-7.8, -5.8], [-2.6, 5.8], [2.6, -5.8], [-7.8, 5.8]] as const) b.box([x - 0.02, x + 0.02], [3 * H, 3 * H + 0.8], [z - 0.02, z + 0.02], "darkSteel", "prop");

  // Scaffolding along the front: thin poles, plank decks every 2 m.
  for (let x = -8; x <= 8; x += 2) {
    for (const z of [6.13, 7.07]) b.box([x - 0.025, x + 0.025], [0, 9.5], [z - 0.025, z + 0.025], "darkSteel", "structure");
  }
  for (const y of [2, 4, 6, 8]) b.box([-7.97, 7.97], [y - 0.05, y], [6.18, 7.02], "woodPlanks", "floor");
  b.box([-6.5, -5.3], [0, 0.8], [-4.5, -3.3], "roofMetal", "prop");
  b.box([4, 5], [0, 1.3], [-3, -2], "paintedSteel", "prop");

  b.room("ground", 0, [-5.4, -3.0], [1.2, 3.2]);
  b.room("level1", H, [3.4, 5.8], [-3.4, -1.4]);
  b.room("level2", 2 * H, [-6.6, -4.2], [-3.4, -1.4]);
  b.room("deck", 3 * H, [-6.6, -4.2], [2.2, 4.2], false);
  return b.entrance(-1, 0, 7.8).build();
}
