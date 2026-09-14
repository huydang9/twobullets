import { Color3, CreateCylinder, Matrix, Quaternion, StandardMaterial, Vector3, type Mesh, type Scene } from "@babylonjs/core";
import type { Vec3, WeaponId } from "@twobullets/shared";

const CAPACITY = 32;
const LIFE_SECONDS = 1.2;
const SHRINK_SECONDS = 0.15;
const GRAVITY = 12;

interface CasingStyle {
  readonly size: readonly [number, number];
  readonly color: Color3;
}

const STYLES: Readonly<Record<WeaponId, CasingStyle>> = {
  rifle: { size: [0.008, 0.03], color: Color3.FromHexString("#b8903f") },
  pistol: { size: [0.008, 0.02], color: Color3.FromHexString("#b8903f") },
  shotgun: { size: [0.018, 0.05], color: Color3.FromHexString("#9b2a26") },
  sniper: { size: [0.01, 0.048], color: Color3.FromHexString("#c39a48") },
};

class Casing {
  active = false;
  age = 0;
  bounced = false;
  floorY = 0;
  readonly position = new Vector3();
  readonly velocity = new Vector3();
  readonly rotation = new Vector3();
  readonly spin = new Vector3();
  readonly scale = new Vector3(1, 1, 1);
  color: Color3 = STYLES.rifle.color;
}

/** Spent shells: cheap kinematic arcs with one floor bounce, drawn as one thin-instanced mesh. */
export class ShellCasings {
  /** Called on a casing's first bounce with its position (for a tink sound). */
  onBounce: ((position: Vector3) => void) | null = null;

  private readonly mesh: Mesh;
  private readonly material: StandardMaterial;
  private readonly casings = Array.from({ length: CAPACITY }, () => new Casing());
  private readonly matrices = new Float32Array(CAPACITY * 16);
  private readonly colors = new Float32Array(CAPACITY * 4);
  private next = 0;
  private readonly matrix = new Matrix();
  private readonly quaternion = new Quaternion();
  private readonly scaling = new Vector3();

  constructor(scene: Scene) {
    this.mesh = CreateCylinder("fx_casings", { height: 1, diameter: 1, tessellation: 6 }, scene);
    this.mesh.bakeTransformIntoVertices(Matrix.RotationX(Math.PI / 2));
    this.material = new StandardMaterial("fx_casings_material", scene);
    this.material.diffuseColor = Color3.White();
    this.material.specularColor = new Color3(0.6, 0.55, 0.4);
    this.material.specularPower = 40;
    this.material.emissiveColor = new Color3(0.12, 0.12, 0.12);
    this.mesh.material = this.material;
    this.mesh.isPickable = false;
    this.mesh.doNotSyncBoundingInfo = true;
    this.mesh.alwaysSelectAsActiveMesh = true;
    this.mesh.thinInstanceSetBuffer("matrix", this.matrices, 16, false);
    this.mesh.thinInstanceSetBuffer("color", this.colors, 4, false);
    this.mesh.thinInstanceCount = 0;
    this.mesh.isVisible = false;
  }

  /** `right`/`up`/`forward` are the camera axes; `inherit` is the shooter's velocity. */
  eject(weaponId: WeaponId, port: Vector3, right: Vector3, up: Vector3, forward: Vector3, inherit: Vec3, floorY: number): void {
    const casing = this.casings[this.next] as Casing;
    this.next = (this.next + 1) % CAPACITY;
    const style = STYLES[weaponId];
    const side = 1.3 + Math.random() * 0.9;
    const lift = 1.3 + Math.random() * 0.9;
    const back = -0.4 + Math.random() * 0.5;
    casing.active = true;
    casing.age = 0;
    casing.bounced = false;
    casing.floorY = floorY;
    casing.position.copyFrom(port);
    casing.velocity.set(
      right.x * side + up.x * lift + forward.x * back + inherit.x,
      right.y * side + up.y * lift + forward.y * back + inherit.y,
      right.z * side + up.z * lift + forward.z * back + inherit.z,
    );
    casing.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);
    casing.spin.set((Math.random() - 0.5) * 40, (Math.random() - 0.5) * 30, (Math.random() - 0.5) * 20);
    casing.scale.set(style.size[0], style.size[0], style.size[1]);
    casing.color = style.color;
  }

  update(dt: number): void {
    let count = 0;
    for (let i = 0; i < CAPACITY; i++) {
      const casing = this.casings[i] as Casing;
      if (!casing.active) continue;
      casing.age += dt;
      if (casing.age >= LIFE_SECONDS) {
        casing.active = false;
        continue;
      }
      const v = casing.velocity;
      v.y -= GRAVITY * dt;
      casing.position.addInPlaceFromFloats(v.x * dt, v.y * dt, v.z * dt);
      casing.rotation.addInPlaceFromFloats(casing.spin.x * dt, casing.spin.y * dt, casing.spin.z * dt);
      if (casing.position.y < casing.floorY && v.y < 0) {
        casing.position.y = casing.floorY;
        v.set(v.x * 0.45, -v.y * 0.3, v.z * 0.45);
        casing.spin.scaleInPlace(0.5);
        if (!casing.bounced) this.onBounce?.(casing.position);
        casing.bounced = true;
      }

      const shrink = Math.min(1, (LIFE_SECONDS - casing.age) / SHRINK_SECONDS);
      Quaternion.RotationYawPitchRollToRef(casing.rotation.y, casing.rotation.x, casing.rotation.z, this.quaternion);
      casing.scale.scaleToRef(shrink, this.scaling);
      Matrix.ComposeToRef(this.scaling, this.quaternion, casing.position, this.matrix);
      // Live casings are packed densely at the front of the instance buffers.
      this.matrix.copyToArray(this.matrices, count * 16);
      const c = count * 4;
      this.colors[c] = casing.color.r;
      this.colors[c + 1] = casing.color.g;
      this.colors[c + 2] = casing.color.b;
      this.colors[c + 3] = 1;
      count++;
    }
    this.mesh.thinInstanceCount = count;
    this.mesh.isVisible = count > 0;
    if (count > 0) {
      this.mesh.thinInstanceBufferUpdated("matrix");
      this.mesh.thinInstanceBufferUpdated("color");
    }
  }

  dispose(): void {
    this.mesh.dispose();
    this.material.dispose();
  }
}
