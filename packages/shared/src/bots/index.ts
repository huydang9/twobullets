// Bots (docs/bots/design.md §3–7). Pure: no engine imports; the match sim feeds a BotWorldView and steps the PlayerInput
// the brain writes.
export * from "./types";
export * from "./nav/index";
export { BOT_PROFILES, botProfile } from "./profiles/profiles";
export { createBotBrain } from "./brain/brain";
export { idleBrain, wanderBrain } from "./brain/testBrains";
export { FakeNavQuery, type FakeNavBox, type FakeNavOptions } from "./brain/fakeNav";
export { createNavPath, NAV_PATH_CAPACITY } from "./motor/motor";
export { MAX_SLOTS } from "./perception/perception";
export { AIM_HEIGHT, aimHeight, solveAim, createAimSolution, type AimSolution } from "./aim/aim";
export { lootNeed, chooseWeaponSlot, chooseHeal } from "./goals/equipment";
export { planRotate, secondsUntilEdge, createRotatePlan, type RotatePlan } from "./goals/zone";
export { scoreGoals, createGoalFacts, GOALS, GoalIndex, type GoalFacts } from "./goals/utility";
