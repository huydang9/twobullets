import "./resolve.ts";
const shared = await import("@twobullets/shared");
const { findRealMap } = await import("../../../packages/shared/src/map/real/index.ts");
const { lookOf, facadeLook } = await import("../../../apps/client/src/world/buildings/BuildingMaterials.ts");
const { getPrefabGeometry } = await import("../../../apps/client/src/world/buildings/BuildingVisuals.ts");
const id = process.argv[2] ?? "vn-hangxanh";
const map = id === "v1" ? shared.MAP_V1 : (await findRealMap(id)!.load()).map;
const terrain = shared.buildTerrain({ ...map.terrain, resolution: 257 }, map.flatten);
const layout = shared.buildMapLayout(map, terrain);
let verts = 0, tris = 0;
const looks = new Set<string>();
for (const size of [60, 80, 100, 125, 160, 250]) {
  const pairs = new Set<string>(); const cells = new Set<string>(); const prefabCells = new Set<string>(); const plain = new Set<string>();
  for (const b of layout.buildings) {
    const prefab = shared.getBuildingPrefab(b.prefab);
    const g = getPrefabGeometry(prefab);
    const cell = `${Math.floor(b.position[0] / size)},${Math.floor(b.position[2] / size)}`;
    cells.add(cell); prefabCells.add(`${b.prefab}@${cell}`);
    const color = shared.facadeColor(prefab.id, b.position[0], b.position[2]);
    for (const grp of g.groups) { const l = facadeLook(lookOf(prefab.id, grp.material), color); looks.add(l); pairs.add(`${cell}|${l}`); plain.add(`${cell}|${lookOf(prefab.id, grp.material).startsWith("plaster") && lookOf(prefab.id, grp.material) !== "plasterInterior" ? "plasterFam" : lookOf(prefab.id, grp.material)}`); }
    if (size === 250) { verts += g.vertices; tris += g.triangles; }
  }
  console.log(`cell ${size}: cells ${cells.size}, prefab×cell ${prefabCells.size}, cell×look ${pairs.size}, cell×look (plaster family merged) ${plain.size}`);
}
console.log(`buildings ${layout.buildings.length}, verts ${verts}, tris ${tris}, looks ${looks.size}: ${[...looks].join(",")}`);
const xs = layout.buildings.map((b) => b.position[0]), zs = layout.buildings.map((b) => b.position[2]);
console.log("extent", Math.min(...xs), Math.max(...xs), Math.min(...zs), Math.max(...zs));
const byLook = new Map<string, number>();
for (const b of layout.buildings) {
  const prefab = shared.getBuildingPrefab(b.prefab);
  for (const grp of getPrefabGeometry(prefab).groups) byLook.set(grp.material, (byLook.get(grp.material) ?? 0) + grp.indices.length / 3);
}
console.log("triangles by material slot", JSON.stringify([...byLook].sort((a, b) => b[1] - a[1])));
{
  let t0 = 0, t1 = 0; const started = performance.now();
  const cache = new Map<string, number>();
  for (const b of layout.buildings) {
    const prefab = shared.getBuildingPrefab(b.prefab);
    t0 += getPrefabGeometry(prefab).triangles;
    let c = cache.get(prefab.id);
    if (c === undefined) cache.set(prefab.id, (c = shared.buildPrefabGeometry(prefab, { maxCell: 1e6, aoRays: 0 }).triangles));
    t1 += c;
  }
  console.log(`coarse shadow geometry: ${t0} -> ${t1} triangles (${(performance.now() - started).toFixed(0)} ms)`);
}
{
  const seen = new Set<string>(); let batchVerts = 0, batchIdx = 0, allVerts = 0, allIdx = 0;
  for (const b of layout.buildings) {
    const prefab = shared.getBuildingPrefab(b.prefab); const g = getPrefabGeometry(prefab);
    const idx = g.groups.reduce((n, grp) => n + grp.indices.length, 0);
    allVerts += g.vertices; allIdx += idx;
    const key = `${b.prefab}@${Math.floor(b.position[0] / 250)},${Math.floor(b.position[2] / 250)}`;
    if (seen.has(key)) continue; seen.add(key); batchVerts += g.vertices; batchIdx += idx;
  }
  const mb = (v: number, i: number) => ((v * 40 + i * 4) / 1e6).toFixed(1);
  console.log(`instanced batches geometry ${mb(batchVerts, batchIdx)} MB (GPU, plus the same retained on the CPU); merged ${mb(allVerts, allIdx)} MB (GPU only)`);
}
