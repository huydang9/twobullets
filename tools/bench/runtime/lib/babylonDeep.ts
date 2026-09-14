/**
 * Minimal Babylon surface used by the server-side code paths (CharacterBody, HavokRaycaster, buildLevel, BabylonMatch),
 * imported from deep module paths instead of the `@babylonjs/core` barrel. With TB_BABYLON_DEEP=1, lib/resolve.ts
 * redirects every `@babylonjs/core` import to this file, which approximates what a tree-shaken server bundle loads.
 */
import "@babylonjs/core/Physics/joinedPhysicsEngineComponent.js";
export { PhysicsCharacterController, CharacterSupportedState } from "@babylonjs/core/Physics/v2/characterController.js";
export { PhysicsRaycastResult } from "@babylonjs/core/Physics/physicsRaycastResult.js";
export { ShapeCastResult } from "@babylonjs/core/Physics/shapeCastResult.js";
export { PhysicsShapeSphere, PhysicsShapeBox, PhysicsShapeCapsule, PhysicsShapeHeightField } from "@babylonjs/core/Physics/v2/physicsShape.js";
export { PhysicsBody } from "@babylonjs/core/Physics/v2/physicsBody.js";
export { PhysicsAggregate } from "@babylonjs/core/Physics/v2/physicsAggregate.js";
export { PhysicsShapeType, PhysicsMotionType } from "@babylonjs/core/Physics/v2/IPhysicsEnginePlugin.js";
export { HavokPlugin } from "@babylonjs/core/Physics/v2/Plugins/havokPlugin.js";
export { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector.js";
export { Mesh } from "@babylonjs/core/Meshes/mesh.js";
export { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData.js";
export { TransformNode } from "@babylonjs/core/Meshes/transformNode.js";
export { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
export { Scene } from "@babylonjs/core/scene.js";
export { FreeCamera } from "@babylonjs/core/Cameras/freeCamera.js";
export { Observable } from "@babylonjs/core/Misc/observable.js";
