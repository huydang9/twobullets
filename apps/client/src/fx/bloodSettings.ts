/** Master switch for blood on character hits (mist, droplets, splatter decals, wounds, death pools). */
export const BLOOD_ENABLED = true;
/** 0..2 scale on particle counts, mist size and decal opacity; 1 is the tuned default. */
export const BLOOD_INTENSITY = 1;
/** Small wound decals that follow the hit bone. */
export const BLOOD_WOUNDS_ENABLED = true;

export interface BloodSettings {
  enabled: boolean;
  intensity: number;
  wounds: boolean;
}

/** Live values read by the blood effects every hit. DEV: `__twobullets.presentation.debugBlood({ intensity: 0.5 })`. */
export const bloodSettings: BloodSettings = {
  enabled: BLOOD_ENABLED,
  intensity: BLOOD_INTENSITY,
  wounds: BLOOD_WOUNDS_ENABLED,
};
