import type { Scene } from "@babylonjs/core";
import type { TargetSpawn } from "@twobullets/shared";
import type { AssetLibrary } from "../assets";
import type { HitboxRegistry } from "../combat/hitboxes";
import type { Environment } from "../world/environment";
import { SoldierResources } from "./SoldierResources";
import { TargetDummy } from "./TargetDummy";

/** All practice soldiers of a level, sharing the rifle mesh, grip calibration and animation masks. */
export class TargetRange {
  readonly dummies: readonly TargetDummy[];
  private readonly resources: SoldierResources;

  constructor(scene: Scene, spawns: readonly TargetSpawn[], registry: HitboxRegistry, environment: Environment, assets: AssetLibrary) {
    this.resources = new SoldierResources(assets);
    this.dummies = spawns.map((spawn, i) => new TargetDummy(scene, `soldier${i}`, spawn, this.resources, registry, environment));
  }

  update(dt: number): void {
    for (const dummy of this.dummies) dummy.update(dt);
  }

  dispose(): void {
    for (const dummy of this.dummies) dummy.dispose();
    this.resources.dispose();
  }
}
