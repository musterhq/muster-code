/** Named camera views as (azimuth, polar) in the OrbitState convention: azimuth 0 / polar PI/2 looks at the model's +Z face. */
export type CameraPreset = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'iso';

export const CAMERA_PRESETS: Record<CameraPreset, {azimuth: number; polar: number; label: string}> = {
  front: {azimuth: 0, polar: Math.PI / 2, label: 'Front'},
  back: {azimuth: Math.PI, polar: Math.PI / 2, label: 'Back'},
  left: {azimuth: -Math.PI / 2, polar: Math.PI / 2, label: 'Left'},
  right: {azimuth: Math.PI / 2, polar: Math.PI / 2, label: 'Right'},
  top: {azimuth: 0, polar: 0.05, label: 'Top'},
  bottom: {azimuth: 0, polar: Math.PI - 0.05, label: 'Bottom'},
  iso: {azimuth: Math.PI / 4, polar: Math.PI / 2.6, label: '3/4 view'},
};
