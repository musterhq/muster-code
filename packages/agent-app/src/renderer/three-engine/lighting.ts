import {Color, DirectionalLight, Group, HemisphereLight} from 'three';
import type {EngineTheme} from './theme.ts';

/**
 * Lighting presets. All are rig-relative to the camera orbit target and need no environment map (no PMREM
 * compile, so the first frame never stalls on shader work).
 *  - studio: soft key from the upper front-left, fill from the right, rim from behind. Models with PBR materials.
 *  - soft:   mostly ambient, gentle key. Devices and flat-shaded CAD parts where highlights distract.
 *  - flat:   ambient only, for unlit previews and texture checks.
 */
export type LightingPreset = 'studio' | 'soft' | 'flat';

export function createLighting(preset: LightingPreset, theme: EngineTheme): Group {
  const rig = new Group();
  rig.name = 'three-engine:lights';
  const k = theme.dark ? 1 : 0.92; // on a light surface the same intensity reads brighter
  const sky = new Color(0xffffff), ground = new Color(theme.background).multiplyScalar(0.5);
  if (preset === 'flat') {
    rig.add(new HemisphereLight(sky, ground, 2.6 * k));
    return rig;
  }
  rig.add(new HemisphereLight(sky, ground, (preset === 'soft' ? 1.7 : 0.85) * k));
  const key = new DirectionalLight(0xffffff, (preset === 'soft' ? 1.4 : 2.6) * k);
  key.position.set(-2.5, 4, 3.5);
  const fill = new DirectionalLight(0xffffff, (preset === 'soft' ? 0.6 : 1.0) * k);
  fill.position.set(4, 1.5, 2);
  rig.add(key, fill);
  if (preset === 'studio') {
    const rim = new DirectionalLight(0xffffff, 1.2 * k);
    rim.position.set(0.5, 3, -4);
    rig.add(rim);
  }
  return rig;
}

export function disposeLighting(rig: Group): void {
  for (const child of [...rig.children]) (child as {dispose?: () => void}).dispose?.();
  rig.clear();
}
