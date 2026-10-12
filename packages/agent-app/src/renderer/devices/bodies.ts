/**
 * Muster's own device bodies (#363): stylised, generic phone, tablet and foldable shapes built in code from three.js
 * primitives. Provenance: written for Muster (MIT, this repository); no external model, scan or trade dress is used.
 * They are the bodies for every Android device and the fallback for iOS when Apple's models are off or unavailable.
 *
 * Every body has one mesh named SCREEN_NAME whose UVs run 0..1 across the visible display (u right, v up), so the live
 * picture maps onto it and a ray hit maps back to a touch. Screen height is always 2.2 scene units.
 */
import {BoxGeometry, Color, CylinderGeometry, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, Shape, ShapeGeometry, type BufferGeometry} from 'three';
import {RoundedBoxGeometry} from 'three/addons/geometries/RoundedBoxGeometry.js';
import type {DeviceFormFactor} from '../../shared/device-protocol';

export const SCREEN_NAME = 'muster-live-screen';
export const SCREEN_HEIGHT = 2.2;
export interface BodyColors {body: Color; trim: Color; lens: Color; screenOff: Color}

/** A rounded rectangle in the XY plane, centred, with UVs normalised to 0..1 over its bounds. */
export function roundedRect(width: number, height: number, radius: number, segments = 10): BufferGeometry {
  const r = Math.min(radius, width / 2, height / 2), x = -width / 2, y = -height / 2;
  const shape = new Shape();
  shape.moveTo(x + r, y); shape.lineTo(x + width - r, y); shape.quadraticCurveTo(x + width, y, x + width, y + r);
  shape.lineTo(x + width, y + height - r); shape.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  shape.lineTo(x + r, y + height); shape.quadraticCurveTo(x, y + height, x, y + height - r);
  shape.lineTo(x, y + r); shape.quadraticCurveTo(x, y, x + r, y);
  const geometry = new ShapeGeometry(shape, segments);
  const position = geometry.attributes.position!, uv = geometry.attributes.uv!;
  for (let i = 0; i < position.count; i++) uv.setXY(i, (position.getX(i) - x) / width, (position.getY(i) - y) / height);
  uv.needsUpdate = true;
  return geometry;
}

interface Spec {bezel: number; depth: number; corner: number; screenCorner: number; lenses: number}
const SPECS: Record<DeviceFormFactor, Spec> = {
  phone: {bezel: 0.07, depth: 0.17, corner: 0.2, screenCorner: 0.15, lenses: 3},
  tablet: {bezel: 0.12, depth: 0.12, corner: 0.14, screenCorner: 0.08, lenses: 1},
  foldable: {bezel: 0.07, depth: 0.12, corner: 0.16, screenCorner: 0.1, lenses: 3},
};

/** A generic body for a screen of the given aspect (width / height). */
export function buildBody(formFactor: DeviceFormFactor, aspect: number, colors: BodyColors): Group {
  const spec = SPECS[formFactor], group = new Group();
  group.name = `muster-${formFactor}`;
  const screenW = SCREEN_HEIGHT * Math.min(Math.max(aspect, 0.3), 3.2), screenH = SCREEN_HEIGHT;
  const width = screenW + spec.bezel * 2, height = screenH + spec.bezel * 2;
  const body = new MeshStandardMaterial({color: colors.body, metalness: 0.55, roughness: 0.38});
  const trim = new MeshStandardMaterial({color: colors.trim, metalness: 0.2, roughness: 0.6});
  // The shell: one rounded slab, or two halves with a hinge for a foldable (shown open).
  if (formFactor === 'foldable') {
    const half = width / 2;
    for (const side of [-1, 1]) {
      const panel = new Mesh(new RoundedBoxGeometry(half, height, spec.depth, 4, Math.min(spec.corner, spec.depth / 2)), body);
      panel.position.x = side * half / 2;
      group.add(panel);
    }
    const hinge = new Mesh(new CylinderGeometry(spec.depth * 0.42, spec.depth * 0.42, height * 0.94, 18), trim);
    hinge.position.z = -spec.depth * 0.32;
    group.add(hinge);
  } else group.add(new Mesh(new RoundedBoxGeometry(width, height, spec.depth, 6, Math.min(spec.corner, spec.depth / 2)), body));
  // Front glass: a black face, then the live screen just above it.
  const face = new Mesh(roundedRect(width - spec.bezel * 0.6, height - spec.bezel * 0.6, spec.corner * 0.9), new MeshBasicMaterial({color: colors.screenOff}));
  face.position.z = spec.depth / 2 + 0.002;
  group.add(face);
  const screen = new Mesh(roundedRect(screenW, screenH, spec.screenCorner), new MeshBasicMaterial({color: colors.screenOff, toneMapped: false}));
  screen.name = SCREEN_NAME;
  screen.position.z = spec.depth / 2 + 0.004;
  group.add(screen);
  // Back: a generic camera module (a rounded plate with round lenses), placed top-left like most current devices.
  const plate = new Mesh(new RoundedBoxGeometry(formFactor === 'tablet' ? 0.32 : 0.62, formFactor === 'tablet' ? 0.32 : 0.62, 0.04, 3, 0.015), trim);
  const margin = formFactor === 'tablet' ? 0.3 : 0.45;
  // Seen from the back, the module sits top-left: in front coordinates that is the top-right (+x), mirrored.
  plate.position.set(formFactor === 'foldable' ? width / 4 : width / 2 - margin, height / 2 - margin, -spec.depth / 2 - 0.02);
  group.add(plate);
  const lens = new MeshStandardMaterial({color: colors.lens, metalness: 0.1, roughness: 0.15});
  for (let i = 0; i < spec.lenses; i++) {
    const glass = new Mesh(new CylinderGeometry(0.1, 0.1, 0.05, 24), lens);
    glass.rotation.x = Math.PI / 2;
    const angle = (i / Math.max(1, spec.lenses)) * Math.PI * 2;
    glass.position.set(plate.position.x + (spec.lenses > 1 ? Math.cos(angle) * 0.15 : 0), plate.position.y + (spec.lenses > 1 ? Math.sin(angle) * 0.15 : 0), plate.position.z - 0.035);
    group.add(glass);
  }
  // Side buttons on phones and foldables (right edge), a top button on tablets.
  const button = (w: number, h: number, d: number, x: number, y: number) => { const b = new Mesh(new BoxGeometry(w, h, d), body); b.position.set(x, y, 0); group.add(b); };
  if (formFactor === 'tablet') button(0.32, 0.03, spec.depth * 0.5, width / 2 - 0.5, height / 2 + 0.012);
  else { button(0.03, 0.32, spec.depth * 0.5, width / 2 + 0.012, 0.45); button(0.03, 0.2, spec.depth * 0.5, -width / 2 - 0.012, 0.62); button(0.03, 0.2, spec.depth * 0.5, -width / 2 - 0.012, 0.36); }
  return group;
}
