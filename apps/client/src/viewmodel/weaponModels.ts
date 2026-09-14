import { TransformNode, Vector3, type Material, type Mesh, type Scene } from "@babylonjs/core";
import type { WeaponId } from "@twobullets/shared";
import type { Surface } from "./materials";
import { MeshKit, type Vec3Tuple } from "./MeshKit";

/** Real-world finishes: anodized/parkerized steel, polymer furniture, rubber, tactical gloves and a field shirt. */
const C = {
  steel: "#2b2d31",
  steelDark: "#1c1d20",
  steelWorn: "#55585e",
  blued: "#24272d",
  polymer: "#1f2022",
  polymerLight: "#2d2f32",
  fde: "#8a7a5c",
  odg: "#4e533d",
  walnut: "#5a3a22",
  walnutDark: "#2e1d11",
  rubber: "#141516",
  slot: "#0b0b0c",
  glove: "#2f2e2b",
  glovePad: "#48453f",
  sleeve: "#5a5c47",
  sleeveDark: "#45473a",
  lens: "#13283a",
  redDot: "#ff2a1f",
  tritium: "#8bff6e",
  fiber: "#ff6a1a",
} as const;

/**
 * A built weapon. Model space: +Z along the barrel, +Y up, origin on the bore axis at the receiver (the pose pivot).
 * Animated parts are separate nodes whose rest positions are stored so animation can write absolute offsets.
 */
export interface WeaponModel {
  readonly id: WeaponId;
  readonly root: TransformNode;
  readonly meshes: readonly Mesh[];
  readonly muzzle: TransformNode;
  readonly ejectPort: TransformNode;
  readonly leftHand: TransformNode;
  readonly leftHandRest: Vector3;
  readonly mag: TransformNode | null;
  readonly magRest: Vector3;
  /** Sniper bolt (rotates about Z, slides along Z). */
  readonly bolt: TransformNode | null;
  readonly boltRest: Vector3;
  /** Shotgun pump; the left hand is parented to it. */
  readonly pump: TransformNode | null;
  readonly pumpRest: Vector3;
  /** Pistol slide. */
  readonly slide: TransformNode | null;
  readonly slideRest: Vector3;
  /** Where the eye sits when aiming (rear of the optic / rear sight / scope eyepiece), model space. */
  readonly sightPoint: Vector3;
  /** Shotgun loading port, in the left hand's parent space. */
  readonly loadPort: Vector3;
}

interface Builder {
  readonly root: TransformNode;
  node(name: string, position: Vec3Tuple, parent?: TransformNode): TransformNode;
  mesh(kit: MeshKit, name: string, parent: TransformNode): void;
}

type Parts = Pick<WeaponModel, "muzzle" | "ejectPort" | "leftHand" | "mag" | "bolt" | "pump" | "slide" | "sightPoint" | "loadPort">;

export function buildWeaponModel(
  id: WeaponId,
  scene: Scene,
  materials: Readonly<Record<Surface, Material>>,
  parent: TransformNode,
): WeaponModel {
  const root = new TransformNode(`vm_${id}`, scene);
  root.parent = parent;
  const meshes: Mesh[] = [];
  const builder: Builder = {
    root,
    node(name, position, nodeParent = root) {
      const node = new TransformNode(`vm_${id}_${name}`, scene);
      node.parent = nodeParent;
      node.position.set(...position);
      return node;
    },
    mesh(kit, name, nodeParent) {
      meshes.push(...kit.build(`vm_${id}_${name}`, scene, materials, nodeParent));
    },
  };
  const parts = BUILDERS[id](builder);
  return {
    id,
    root,
    meshes,
    ...parts,
    leftHandRest: parts.leftHand.position.clone(),
    magRest: parts.mag?.position.clone() ?? Vector3.Zero(),
    boltRest: parts.bolt?.position.clone() ?? Vector3.Zero(),
    pumpRest: parts.pump?.position.clone() ?? Vector3.Zero(),
    slideRest: parts.slide?.position.clone() ?? Vector3.Zero(),
  };
}

// --- Hands ---------------------------------------------------------------------------------------------------------

interface GripSpec {
  /** Grip center (model space) at the height of the middle finger. */
  readonly at: Vec3Tuple;
  /** Forward lean of the grip, radians (top toward +Z). */
  readonly tilt: number;
  readonly width: number;
  readonly depth: number;
  /** Trigger face in grip space: [y, z]. */
  readonly trigger: readonly [number, number];
}

/** Right hand wrapped around a pistol grip, index finger on the trigger, sleeve reaching down-right out of frame. */
function gripHand(kit: MeshKit, grip: GripSpec): void {
  const hw = grip.width / 2;
  const front = grip.depth / 2;
  const [triggerY, triggerZ] = grip.trigger;
  kit.group(grip.at, [grip.tilt, 0, 0], (k) => {
    // Palm and back of the hand on the right side and back strap; thumb web over the top.
    k.rounded([hw + 0.006, -0.004, -0.004], [0.02, 0.085, grip.depth + 0.018], 0.009, C.glove, "glove");
    k.rounded([hw + 0.015, 0.004, 0.002], [0.004, 0.05, grip.depth * 0.8], 0.002, C.glovePad, "glove");
    k.rounded([0.003, 0.036, -front - 0.006], [grip.width + 0.012, 0.026, 0.024], 0.01, C.glove, "glove");
    // Middle, ring and little fingers curl around the front strap onto the left side.
    const fingers: readonly (readonly [number, number])[] = [
      [0.016, 0.0088],
      [-0.006, 0.0084],
      [-0.027, 0.0074],
    ];
    for (const [y, r] of fingers) {
      const p0: Vec3Tuple = [hw + 0.006, y, front - 0.012];
      const p1: Vec3Tuple = [hw - 0.001, y, front + 0.009];
      const p2: Vec3Tuple = [-hw + 0.004, y - 0.002, front + 0.009];
      const p3: Vec3Tuple = [-hw - 0.006, y - 0.004, front - 0.009];
      k.capsule(p0, p1, r, C.glove, "glove").capsule(p1, p2, r * 0.95, C.glove, "glove").capsule(p2, p3, r * 0.88, C.glove, "glove");
    }
    // Trigger finger.
    const i0: Vec3Tuple = [hw + 0.006, triggerY - 0.006, front - 0.01];
    const i1: Vec3Tuple = [hw + 0.002, triggerY, (front + triggerZ) / 2 + 0.004];
    const i2: Vec3Tuple = [0.002, triggerY - 0.004, triggerZ + 0.004];
    k.capsule(i0, i1, 0.0086, C.glove, "glove").capsule(i1, i2, 0.008, C.glove, "glove");
    // Thumb along the left side (the side the camera sees).
    k.rounded([-hw - 0.005, 0.004, -front + 0.006], [0.014, 0.05, 0.032], 0.007, C.glove, "glove");
    const t0: Vec3Tuple = [-hw - 0.004, 0.022, -front - 0.002];
    const t1: Vec3Tuple = [-hw - 0.009, 0.036, 0.0];
    const t2: Vec3Tuple = [-hw - 0.007, 0.042, front + 0.004];
    k.capsule(t0, t1, 0.0098, C.glove, "glove").capsule(t1, t2, 0.0088, C.glove, "glove");
    // Glove cuff, shirt cuff and forearm.
    const wrist: Vec3Tuple = [hw * 0.5, -0.05, -front - 0.012];
    k.taper(wrist, [0.012, -0.09, -front - 0.034], 0.024, 0.026, C.glove, "glove");
    k.taper([0.012, -0.085, -front - 0.03], [0.02, -0.11, -front - 0.05], 0.033, 0.034, C.sleeveDark, "fabric");
    k.taper([0.018, -0.105, -front - 0.045], [0.13, -0.36, -front - 0.31], 0.031, 0.043, C.sleeve, "fabric");
  });
}

/** Left hand cupping a foregrip from below: fingers up the right side, thumb along the visible left side. */
function supportHand(kit: MeshKit, at: Vec3Tuple, width: number): void {
  const hw = width / 2;
  kit.group(at, [0, 0, 0], (k) => {
    k.rounded([0.004, -0.013, 0], [width + 0.006, 0.024, 0.08], 0.01, C.glove, "glove");
    k.rounded([0.004, -0.025, 0.004], [width * 0.7, 0.003, 0.05], 0.0015, C.glovePad, "glove");
    for (const z of [0.027, 0.009, -0.009, -0.027]) {
      const r = z < -0.02 ? 0.0074 : 0.0083;
      const p0: Vec3Tuple = [hw - 0.002, -0.014, z];
      const p1: Vec3Tuple = [hw + 0.008, 0.002, z];
      const p2: Vec3Tuple = [hw + 0.004, 0.018, z * 0.95];
      k.capsule(p0, p1, r, C.glove, "glove").capsule(p1, p2, r * 0.9, C.glove, "glove");
    }
    k.rounded([-hw - 0.002, -0.014, -0.022], [0.016, 0.02, 0.036], 0.007, C.glove, "glove");
    const t0: Vec3Tuple = [-hw + 0.002, -0.016, -0.03];
    const t1: Vec3Tuple = [-hw - 0.008, -0.004, -0.004];
    const t2: Vec3Tuple = [-hw - 0.007, 0.011, 0.024];
    k.capsule(t0, t1, 0.0095, C.glove, "glove").capsule(t1, t2, 0.0086, C.glove, "glove");
    k.taper([-0.004, -0.024, -0.034], [-0.02, -0.048, -0.064], 0.024, 0.026, C.glove, "glove");
    k.taper([-0.018, -0.044, -0.058], [-0.03, -0.062, -0.078], 0.033, 0.034, C.sleeveDark, "fabric");
    k.taper([-0.028, -0.058, -0.072], [-0.16, -0.32, -0.32], 0.031, 0.043, C.sleeve, "fabric");
  });
}

/** Picatinny rail: base plus teeth, spanning [zFrom, zTo] with its top at `top`. */
function rail(kit: MeshKit, zFrom: number, zTo: number, top: number, width: number): void {
  kit.box([0, top - 0.004, (zFrom + zTo) / 2], [width * 0.8, 0.005, zTo - zFrom], C.steel, "metal");
  for (let z = zFrom + 0.004; z <= zTo - 0.003; z += 0.01) {
    kit.box([0, top - 0.002, z], [width, 0.004, 0.0048], C.steel, "metal");
  }
}

// --- Weapons -------------------------------------------------------------------------------------------------------

const BUILDERS: Readonly<Record<WeaponId, (b: Builder) => Parts>> = {
  /** AR-15 style carbine: FDE furniture, free-float handguard, tube red-dot. */
  rifle(b) {
    const body = new MeshKit();
    // Upper and lower receiver.
    body.profile([[-0.09, -0.012], [-0.09, 0.02], [-0.078, 0.028], [0.092, 0.028], [0.092, -0.012]], 0.034, 0.004, C.steel, "metal");
    body.profile(
      [[-0.082, -0.012], [0.082, -0.012], [0.082, -0.03], [0.074, -0.064], [0.022, -0.064], [0.018, -0.042], [-0.034, -0.042], [-0.058, -0.032], [-0.082, -0.03]],
      0.032,
      0.003,
      C.steel,
      "metal",
    );
    rail(body, -0.088, 0.09, 0.036, 0.021);
    body.box([0, 0.024, -0.1], [0.05, 0.007, 0.012], C.steelWorn, "metal"); // charging handle
    body.rounded([-0.0175, -0.024, -0.012], [0.004, 0.012, 0.022], 0.0015, C.steelWorn, "metal"); // bolt catch
    body.rounded([-0.0175, -0.03, -0.05], [0.004, 0.006, 0.02], 0.002, C.steelWorn, "metal"); // selector
    body.cylinder([-0.0165, -0.02, 0.07], 0.003, 0.003, C.steelWorn, "metal", [0, Math.PI / 2, 0]); // takedown pin
    // Buffer tube, castle nut, stock and butt pad.
    body.cylinder([0, -0.004, -0.16], 0.0145, 0.15, C.steel, "metal");
    body.lathe([0, -0.004, -0.088], [[0.014, -0.004], [0.018, -0.004], [0.018, 0.004], [0.014, 0.004]], C.steelWorn, "metal");
    body.profile([[-0.15, 0.018], [-0.262, 0.024], [-0.27, 0.016], [-0.272, -0.066], [-0.262, -0.074], [-0.236, -0.072], [-0.198, -0.03], [-0.15, -0.024]], 0.042, 0.007, C.fde, "polymer");
    body.profile([[-0.27, 0.022], [-0.283, 0.022], [-0.285, -0.07], [-0.271, -0.073]], 0.044, 0.004, C.rubber, "rubber");
    // Pistol grip, trigger guard, trigger.
    body.profile([[-0.036, -0.04], [-0.004, -0.04], [-0.008, -0.056], [-0.024, -0.124], [-0.034, -0.13], [-0.058, -0.128], [-0.064, -0.118], [-0.052, -0.05]], 0.03, 0.006, C.fde, "polymer");
    body.box([0, -0.064, 0.006], [0.01, 0.004, 0.05], C.steel, "metal");
    body.rounded([0, -0.052, 0.002], [0.004, 0.018, 0.005], 0.0015, C.steelWorn, "metal", [0.3, 0, 0]);
    // Free-float handguard with M-LOK slots and top rail.
    body.rounded([0, 0.004, 0.2], [0.046, 0.05, 0.216], 0.013, C.polymer, "polymer");
    rail(body, 0.094, 0.306, 0.036, 0.021);
    for (const z of [0.13, 0.17, 0.21, 0.25]) {
      body.rounded([-0.0232, -0.004, z], [0.002, 0.009, 0.026], 0.001, C.slot, "rubber");
      body.rounded([0.0232, -0.004, z], [0.002, 0.009, 0.026], 0.001, C.slot, "rubber");
    }
    // Barrel and birdcage flash hider with slots.
    body.lathe([0, 0, 0.308], [[0, 0], [0.0085, 0], [0.0085, 0.094], [0, 0.094]], C.steelDark, "metal");
    body.lathe([0, 0, 0.4], [[0, 0], [0.0108, 0], [0.0112, 0.005], [0.0112, 0.046], [0.0098, 0.05], [0.0055, 0.05], [0.0055, 0.03]], C.steel, "metal");
    body.box([-0.0112, 0, 0.428], [0.002, 0.004, 0.022], C.slot, "rubber");
    body.box([0.0112, 0, 0.428], [0.002, 0.004, 0.022], C.slot, "rubber");
    body.box([0, 0.0112, 0.428], [0.004, 0.002, 0.022], C.slot, "rubber");
    // Tube red-dot on a riser mount: open tube, the dot floats on the sight line.
    const optic = 0.064;
    body.rounded([0, 0.043, -0.012], [0.024, 0.014, 0.036], 0.003, C.steel, "metal");
    body.lathe([0, optic, -0.03], [[0.0122, 0], [0.0152, 0], [0.0156, 0.004], [0.0146, 0.008], [0.0146, 0.038], [0.0156, 0.042], [0.0152, 0.048], [0.0122, 0.048], [0.0122, 0]], C.steelDark, "metal", [0, 0, 0], 24);
    body.cylinder([0, optic + 0.018, -0.006], 0.0055, 0.008, C.steelDark, "metal", [-Math.PI / 2, 0, 0]);
    body.cylinder([0.018, optic, -0.006], 0.0055, 0.008, C.steelDark, "metal", [0, Math.PI / 2, 0]);
    body.sphere([0, optic, 0.012], 0.001, C.redDot, "glow");
    gripHand(body, { at: [0, -0.085, -0.0325], tilt: 0.29, width: 0.03, depth: 0.039, trigger: [0.045, 0.026] });
    b.mesh(body, "body", b.root);

    const magPivot: Vec3Tuple = [0, -0.05, 0.048];
    const mag = b.node("mag", magPivot);
    b.mesh(
      new MeshKit(magPivot)
        .profile([[0.024, -0.05], [0.07, -0.05], [0.074, -0.1], [0.082, -0.155], [0.086, -0.172], [0.046, -0.178], [0.042, -0.16], [0.034, -0.1]], 0.024, 0.004, C.polymer, "polymer")
        .profile([[0.044, -0.172], [0.09, -0.166], [0.092, -0.18], [0.044, -0.187]], 0.028, 0.003, C.polymerLight, "polymer")
        .rounded([-0.0122, -0.11, 0.057], [0.002, 0.05, 0.004], 0.001, C.polymerLight, "polymer", [-0.15, 0, 0])
        .rounded([-0.0122, -0.11, 0.066], [0.002, 0.05, 0.004], 0.001, C.polymerLight, "polymer", [-0.15, 0, 0]),
      "mag",
      mag,
    );

    const handPivot: Vec3Tuple = [0, -0.021, 0.21];
    const leftHand = b.node("leftHand", handPivot);
    b.mesh(handKit(handPivot, (k) => supportHand(k, handPivot, 0.046)), "leftHand", leftHand);

    return {
      muzzle: b.node("muzzle", [0, 0, 0.452]),
      ejectPort: b.node("eject", [0.018, 0.01, 0.01]),
      leftHand,
      mag,
      bolt: null,
      pump: null,
      slide: null,
      sightPoint: new Vector3(0, optic, -0.03),
      loadPort: Vector3.Zero(),
    };
  },

  /** Tactical pump shotgun: blued steel, walnut forend, ghost-ring rear and fiber-optic front sight. */
  shotgun(b) {
    const body = new MeshKit();
    body.profile([[-0.065, -0.036], [-0.065, 0.014], [-0.056, 0.022], [0.118, 0.022], [0.124, 0.014], [0.124, -0.036]], 0.038, 0.006, C.blued, "metal");
    body.profile([[-0.06, -0.036], [0.066, -0.036], [0.06, -0.046], [0.02, -0.05], [-0.05, -0.046]], 0.03, 0.003, C.blued, "metal");
    body.box([0, -0.0365, 0.05], [0.022, 0.0015, 0.07], C.slot, "rubber"); // loading port
    body.cylinder([0, -0.04, -0.045], 0.004, 0.034, C.steelWorn, "metal", [0, Math.PI / 2, 0]); // safety
    body.lathe([0, 0, 0.12], [[0, 0], [0.0118, 0], [0.0118, 0.38], [0.0075, 0.38], [0.0075, 0.36]], C.blued, "metal");
    body.box([0, 0.0135, 0.3], [0.008, 0.003, 0.36], C.blued, "metal"); // vent rib
    body.box([0, 0.022, 0.478], [0.004, 0.014, 0.008], C.blued, "metal");
    body.sphere([0, 0.03, 0.478], 0.0022, C.fiber, "glow");
    // Ghost-ring rear sight with protective ears.
    body.lathe([0, 0.03, -0.045], [[0.0045, -0.003], [0.0075, -0.003], [0.0075, 0.003], [0.0045, 0.003], [0.0045, -0.003]], C.steelDark, "metal");
    body.box([-0.011, 0.028, -0.045], [0.004, 0.018, 0.012], C.steelDark, "metal");
    body.box([0.011, 0.028, -0.045], [0.004, 0.018, 0.012], C.steelDark, "metal");
    body.box([0, 0.024, -0.045], [0.026, 0.006, 0.016], C.steelDark, "metal");
    // Magazine tube, cap and barrel clamp.
    body.cylinder([0, -0.026, 0.28], 0.0105, 0.32, C.blued, "metal");
    body.lathe([0, -0.026, 0.44], [[0, 0], [0.0125, 0], [0.0125, 0.016], [0.009, 0.022], [0, 0.022]], C.blued, "metal");
    body.rounded([0, -0.007, 0.42], [0.02, 0.042, 0.012], 0.004, C.steelDark, "metal");
    // Stock, butt pad, pistol grip, trigger guard, trigger.
    body.profile([[-0.06, 0.016], [-0.06, -0.034], [-0.09, -0.042], [-0.28, -0.058], [-0.296, -0.07], [-0.31, -0.07], [-0.312, 0.028], [-0.296, 0.032], [-0.1, 0.016]], 0.036, 0.007, C.polymer, "polymer");
    body.profile([[-0.31, 0.03], [-0.326, 0.03], [-0.328, -0.07], [-0.31, -0.072]], 0.038, 0.004, C.rubber, "rubber");
    body.profile([[-0.055, -0.034], [-0.02, -0.034], [-0.024, -0.05], [-0.04, -0.116], [-0.05, -0.122], [-0.074, -0.12], [-0.08, -0.11], [-0.068, -0.044]], 0.03, 0.006, C.polymer, "polymer");
    body.box([0, -0.058, -0.002], [0.01, 0.004, 0.046], C.blued, "metal");
    body.box([0, -0.052, 0.02], [0.01, 0.012, 0.004], C.blued, "metal");
    body.rounded([0, -0.046, -0.004], [0.004, 0.014, 0.005], 0.0015, C.steelWorn, "metal", [0.3, 0, 0]);
    gripHand(body, { at: [0, -0.078, -0.053], tilt: 0.21, width: 0.03, depth: 0.042, trigger: [0.034, 0.05] });
    b.mesh(body, "body", b.root);

    // Ribbed walnut forend around the magazine tube; the left hand rides on it.
    const pumpPivot: Vec3Tuple = [0, -0.026, 0.24];
    const pump = b.node("pump", pumpPivot);
    const pumpKit = new MeshKit(pumpPivot)
      .lathe(pumpPivot, [[0.011, -0.07], [0.017, -0.07], [0.021, -0.062], [0.021, 0.062], [0.017, 0.07], [0.011, 0.07]], C.walnut, "polymer", [0, 0, 0], 20)
      .box([-0.0125, -0.012, 0.18], [0.003, 0.006, 0.12], C.blued, "metal")
      .box([0.0125, -0.012, 0.18], [0.003, 0.006, 0.12], C.blued, "metal");
    for (const z of [-0.045, -0.03, -0.015, 0, 0.015, 0.03, 0.045]) {
      pumpKit.lathe([0, -0.026, 0.24 + z], [[0.0214, -0.002], [0.0214, 0.002]], C.walnutDark, "polymer", [0, 0, 0], 20);
    }
    b.mesh(pumpKit, "pump", pump);

    const handModel: Vec3Tuple = [0, -0.047, 0.24];
    const leftHand = b.node("leftHand", [0, -0.021, 0], pump);
    b.mesh(handKit(handModel, (k) => supportHand(k, handModel, 0.042)), "leftHand", leftHand);

    return {
      muzzle: b.node("muzzle", [0, 0, 0.5]),
      ejectPort: b.node("eject", [0.02, 0.005, 0.03]),
      leftHand,
      mag: null,
      bolt: null,
      pump,
      slide: null,
      sightPoint: new Vector3(0, 0.03, -0.048),
      // Loading port under the receiver (model (0, -0.05, 0.05)), relative to the pump pivot.
      loadPort: new Vector3(0, -0.024, -0.19),
    };
  },

  /** Polymer-frame striker pistol with tritium night sights. */
  pistol(b) {
    const tilt = 0.17;
    const body = new MeshKit();
    body.profile([[-0.018, 0.0], [0.156, 0.0], [0.156, -0.014], [0.05, -0.014], [0.036, -0.011], [-0.018, -0.011]], 0.025, 0.004, C.polymer, "polymer");
    body.box([0, -0.013, 0.12], [0.026, 0.002, 0.004], C.slot, "rubber");
    body.box([0, -0.013, 0.135], [0.026, 0.002, 0.004], C.slot, "rubber");
    body.profile([[-0.024, -0.004], [0.014, -0.012], [0.008, -0.032], [-0.002, -0.1], [-0.01, -0.108], [-0.048, -0.106], [-0.052, -0.094], [-0.038, -0.02], [-0.034, -0.004]], 0.03, 0.007, C.polymer, "polymer");
    body.rounded([-0.0152, -0.062, -0.022], [0.001, 0.05, 0.03], 0.0005, C.polymerLight, "polymer", [tilt, 0, 0]);
    body.capsule([0, -0.012, 0.042], [0, -0.034, 0.046], 0.003, C.polymer, "polymer");
    body.capsule([0, -0.034, 0.046], [0, -0.036, 0.012], 0.003, C.polymer, "polymer");
    body.capsule([0, -0.036, 0.012], [0, -0.03, 0.004], 0.003, C.polymer, "polymer");
    body.rounded([0, -0.021, 0.018], [0.005, 0.016, 0.006], 0.002, C.polymerLight, "polymer", [0.25, 0, 0]);
    body.box([-0.0128, -0.004, 0.035], [0.002, 0.004, 0.016], C.steelWorn, "metal"); // slide stop
    gripHand(body, { at: [0, -0.06, -0.021], tilt, width: 0.03, depth: 0.046, trigger: [0.045, 0.034] });
    b.mesh(body, "body", b.root);

    const slidePivot: Vec3Tuple = [0, 0.018, 0.07];
    const slide = b.node("slide", slidePivot);
    const slideKit = new MeshKit(slidePivot)
      .profile([[-0.022, 0.0], [-0.022, 0.028], [-0.016, 0.035], [0.158, 0.035], [0.166, 0.029], [0.166, 0.003], [0.158, 0.0]], 0.025, 0.004, C.steel, "metal")
      .box([0.004, 0.0352, 0.075], [0.013, 0.0012, 0.036], C.slot, "rubber")
      .cylinder([0, 0.012, 0.1662], 0.0055, 0.001, C.slot, "rubber")
      .rounded([0, 0.037, -0.012], [0.02, 0.004, 0.009], 0.0015, C.steelDark, "metal")
      .rounded([-0.0055, 0.0395, -0.012], [0.007, 0.009, 0.009], 0.0015, C.steelDark, "metal")
      .rounded([0.0055, 0.0395, -0.012], [0.007, 0.009, 0.009], 0.0015, C.steelDark, "metal")
      .rounded([0, 0.0395, 0.154], [0.0035, 0.009, 0.005], 0.001, C.steelDark, "metal")
      .sphere([0, 0.041, 0.1512], 0.0011, C.tritium, "glow")
      .sphere([-0.0055, 0.041, -0.0168], 0.0011, C.tritium, "glow")
      .sphere([0.0055, 0.041, -0.0168], 0.0011, C.tritium, "glow");
    for (let z = -0.016; z <= 0.014; z += 0.006) {
      slideKit.box([-0.0127, 0.017, z], [0.0012, 0.022, 0.0022], C.slot, "rubber").box([0.0127, 0.017, z], [0.0012, 0.022, 0.0022], C.slot, "rubber");
    }
    b.mesh(slideKit, "slide", slide);

    const magPivot: Vec3Tuple = [0, -0.07, -0.025];
    const mag = b.node("mag", magPivot);
    b.mesh(
      new MeshKit(magPivot)
        .rounded([0, -0.07, -0.022], [0.02, 0.08, 0.03], 0.003, C.steel, "metal", [tilt, 0, 0])
        .rounded([0, -0.111, -0.03], [0.028, 0.009, 0.046], 0.003, C.polymer, "polymer", [tilt, 0, 0]),
      "mag",
      mag,
    );

    // Support hand wraps the right hand's fingers; thumb points forward along the frame.
    const handPivot: Vec3Tuple = [-0.02, -0.065, -0.01];
    const leftHand = b.node("leftHand", handPivot);
    b.mesh(
      handKit(handPivot, (k) => {
        k.rounded([-0.024, -0.066, -0.014], [0.014, 0.075, 0.052], 0.007, C.glove, "glove", [tilt, 0, 0]);
        for (const y of [-0.05, -0.068, -0.086]) {
          const shift = (y + 0.06) * tilt;
          const p0: Vec3Tuple = [-0.022, y, 0.016 + shift];
          const p1: Vec3Tuple = [-0.006, y, 0.033 + shift];
          const p2: Vec3Tuple = [0.014, y, 0.03 + shift];
          const p3: Vec3Tuple = [0.025, y, 0.012 + shift];
          k.capsule(p0, p1, 0.0088, C.glove, "glove").capsule(p1, p2, 0.0084, C.glove, "glove").capsule(p2, p3, 0.0078, C.glove, "glove");
        }
        k.rounded([-0.026, -0.036, -0.006], [0.014, 0.03, 0.035], 0.007, C.glove, "glove");
        k.capsule([-0.021, -0.03, -0.004], [-0.021, -0.018, 0.03], 0.0095, C.glove, "glove");
        k.capsule([-0.021, -0.018, 0.03], [-0.019, -0.013, 0.058], 0.0086, C.glove, "glove");
        k.taper([-0.03, -0.095, -0.03], [-0.04, -0.115, -0.055], 0.024, 0.026, C.glove, "glove");
        k.taper([-0.038, -0.11, -0.05], [-0.046, -0.126, -0.068], 0.033, 0.034, C.sleeveDark, "fabric");
        k.taper([-0.044, -0.122, -0.064], [-0.17, -0.35, -0.28], 0.031, 0.043, C.sleeve, "fabric");
      }),
      "leftHand",
      leftHand,
    );

    return {
      muzzle: b.node("muzzle", [0, 0.012, 0.17]),
      ejectPort: b.node("eject", [0.012, 0.036, 0.075]),
      leftHand,
      mag,
      bolt: null,
      pump: null,
      slide,
      sightPoint: new Vector3(0, 0.041, -0.017),
      loadPort: Vector3.Zero(),
    };
  },

  /** Bolt-action precision rifle: OD green stock, heavy barrel with brake, long scope in rings. */
  sniper(b) {
    const scopeY = 0.056;
    const body = new MeshKit();
    body.lathe([0, 0, -0.02], [[0, -0.06], [0.0145, -0.06], [0.0165, -0.052], [0.0165, 0.13], [0.014, 0.14], [0, 0.14]], C.steel, "metal");
    body.lathe([0, 0, -0.09], [[0, -0.025], [0.009, -0.025], [0.0125, -0.012], [0.0125, 0.012], [0, 0.012]], C.steel, "metal");
    rail(body, -0.05, 0.11, 0.0255, 0.02);
    body.lathe([0, 0, 0.12], [[0, 0], [0.0125, 0], [0.0105, 0.1], [0.009, 0.48], [0, 0.48]], C.steelDark, "metal");
    body.lathe([0, 0, 0.6], [[0, 0], [0.0135, 0], [0.0135, 0.055], [0.011, 0.06], [0.005, 0.06]], C.steel, "metal");
    for (const z of [0.614, 0.634]) {
      body.rounded([-0.0136, 0, z], [0.002, 0.008, 0.012], 0.0008, C.slot, "rubber");
      body.rounded([0.0136, 0, z], [0.002, 0.008, 0.012], 0.0008, C.slot, "rubber");
    }
    body.profile(
      [
        [0.36, -0.008], [0.36, -0.03], [0.33, -0.044], [0.06, -0.048], [0.052, -0.052], [-0.03, -0.052], [-0.036, -0.046],
        [-0.052, -0.13], [-0.062, -0.138], [-0.088, -0.136], [-0.094, -0.124], [-0.08, -0.044], [-0.11, -0.036], [-0.28, -0.074],
        [-0.335, -0.084], [-0.345, -0.076], [-0.345, 0.03], [-0.335, 0.04], [-0.21, 0.036], [-0.14, 0.024], [-0.1, -0.008],
      ],
      0.044,
      0.008,
      C.odg,
      "polymer",
    );
    body.rounded([0, 0.042, -0.23], [0.036, 0.012, 0.12], 0.005, C.polymer, "polymer"); // cheek riser
    body.profile([[-0.345, 0.032], [-0.36, 0.032], [-0.362, -0.078], [-0.345, -0.08]], 0.046, 0.004, C.rubber, "rubber");
    body.capsule([0, -0.052, 0.03], [0, -0.068, 0.022], 0.003, C.steel, "metal");
    body.capsule([0, -0.068, 0.022], [0, -0.07, -0.018], 0.003, C.steel, "metal");
    body.capsule([0, -0.07, -0.018], [0, -0.05, -0.034], 0.003, C.steel, "metal");
    body.rounded([0, -0.061, 0.006], [0.004, 0.016, 0.005], 0.0015, C.steelWorn, "metal", [0.3, 0, 0]);
    // Scope: eyepiece, tube, turret saddle, objective bell, glass, rings.
    body.lathe(
      [0, scopeY, 0],
      [
        [0.0165, -0.15], [0.02, -0.155], [0.021, -0.148], [0.021, -0.1], [0.019, -0.095], [0.0145, -0.07], [0.0145, 0.08],
        [0.02, 0.12], [0.024, 0.13], [0.024, 0.19], [0.0215, 0.196], [0.0185, 0.196], [0.0185, 0.186],
      ],
      C.steelDark,
      "metal",
      [0, 0, 0],
      24,
    );
    body.lathe([0, scopeY, -0.147], [[0, 0], [0.0168, 0]], C.lens, "glass", [0, 0, 0], 24);
    body.lathe([0, scopeY, 0.186], [[0.0186, 0], [0, 0]], C.lens, "glass", [0, 0, 0], 24);
    body.rounded([0, scopeY, 0], [0.034, 0.034, 0.05], 0.008, C.steelDark, "metal");
    body.cylinder([0, scopeY + 0.025, 0], 0.0105, 0.018, C.steelDark, "metal", [-Math.PI / 2, 0, 0]);
    body.cylinder([0, scopeY + 0.0355, 0], 0.0095, 0.004, C.steelWorn, "metal", [-Math.PI / 2, 0, 0]);
    body.cylinder([0.025, scopeY, 0], 0.0105, 0.018, C.steelDark, "metal", [0, Math.PI / 2, 0]);
    body.cylinder([-0.024, scopeY, 0], 0.009, 0.014, C.steelDark, "metal", [0, Math.PI / 2, 0]);
    for (const z of [-0.045, 0.06]) {
      body.lathe([0, scopeY, z], [[0.0145, -0.008], [0.0185, -0.008], [0.0185, 0.008], [0.0145, 0.008]], C.steel, "metal");
      body.rounded([0, 0.0335, z], [0.02, 0.018, 0.016], 0.003, C.steel, "metal");
    }
    gripHand(body, { at: [0, -0.088, -0.0655], tilt: 0.18, width: 0.04, depth: 0.043, trigger: [0.039, 0.066] });
    b.mesh(body, "body", b.root);

    // Bolt pivot on the bore axis: rotation.z lifts the handle, position.z slides it.
    const boltPivot: Vec3Tuple = [0, 0, -0.03];
    const bolt = b.node("bolt", boltPivot);
    b.mesh(
      new MeshKit(boltPivot)
        .cylinder([0, 0, -0.04], 0.0095, 0.06, C.steelWorn, "metal")
        .capsule([0.008, 0, -0.05], [0.04, -0.012, -0.058], 0.0035, C.steel, "metal")
        .sphere([0.046, -0.015, -0.06], 0.0085, C.steelDark, "metal"),
      "bolt",
      bolt,
    );

    const magPivot: Vec3Tuple = [0, -0.05, 0.07];
    const mag = b.node("mag", magPivot);
    b.mesh(
      new MeshKit(magPivot)
        .rounded([0, -0.062, 0.07], [0.03, 0.03, 0.07], 0.004, C.steelDark, "metal")
        .rounded([0, -0.078, 0.07], [0.034, 0.006, 0.074], 0.002, C.polymer, "polymer"),
      "mag",
      mag,
    );

    const handPivot: Vec3Tuple = [0, -0.045, 0.24];
    const leftHand = b.node("leftHand", handPivot);
    b.mesh(handKit(handPivot, (k) => supportHand(k, handPivot, 0.044)), "leftHand", leftHand);

    return {
      muzzle: b.node("muzzle", [0, 0, 0.66]),
      ejectPort: b.node("eject", [0.018, 0.008, 0.03]),
      leftHand,
      mag,
      bolt,
      pump: null,
      slide: null,
      sightPoint: new Vector3(0, scopeY, -0.155),
      loadPort: Vector3.Zero(),
    };
  },
};

function handKit(pivot: Vec3Tuple, build: (kit: MeshKit) => void): MeshKit {
  const kit = new MeshKit(pivot);
  build(kit);
  return kit;
}
