import type { Scene } from "@babylonjs/core";
import type { TargetSpawn } from "@twobullets/shared";
import type { HitboxRegistry } from "../combat/hitboxes";
import type { Environment } from "../world/environment";
import { DummyAssets } from "./DummyAssets";
import { TargetDummy } from "./TargetDummy";

/** All practice dummies of a level, sharing one set of materials and geometry. */
export class TargetRange {
  readonly dummies: readonly TargetDummy[];
  private readonly assets: DummyAssets;

  constructor(scene: Scene, spawns: readonly TargetSpawn[], registry: HitboxRegistry, environment: Environment) {
    this.assets = new DummyAssets(scene);
    this.dummies = spawns.map((spawn, i) => new TargetDummy(scene, `dummy${i}`, spawn, this.assets, registry, environment));
  }

  update(dt: number): void {
    for (const dummy of this.dummies) dummy.update(dt);
  }

  dispose(): void {
    for (const dummy of this.dummies) dummy.dispose();
    this.assets.dispose();
  }
}
