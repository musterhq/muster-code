/**
 * Device bodies for the 3D view (#363), built in code from the same frame spec and layout the flat view draws
 * (shared/device-frames.ts): the outline, screen corners, cut-out, bezel marks and buttons all come from one place, so
 * the flat and 3D views always show the same device. Provenance: written for Muster (MIT, this repository); no external
 * model, scan, photo or maker artwork is used.
 *
 * Every body has one mesh named SCREEN_NAME whose UVs run 0..1 across the visible display (u right, v up), so the live
 * picture maps onto it and a ray hit maps back to a touch. The screen's long side is SCREEN_HEIGHT scene units.
 */
import {BoxGeometry, CircleGeometry, Color, CylinderGeometry, ExtrudeGeometry, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, RingGeometry, Shape, ShapeGeometry, type BufferGeometry} from 'three';
import {frameLayout, type FrameShape, type FrameSpec, type PathOp} from '../../shared/device-frames.ts';

export const SCREEN_NAME = 'muster-live-screen';
export const SCREEN_HEIGHT = 2.2;
export interface BodyColors {body: Color; trim: Color; lens: Color; screenOff: Color}

const roundShape = (width: number, height: number, radius: number): Shape => {
  const r = Math.min(radius, width / 2, height / 2), x = -width / 2, y = -height / 2, shape = new Shape();
  shape.moveTo(x + r, y); shape.lineTo(x + width - r, y); shape.quadraticCurveTo(x + width, y, x + width, y + r);
  shape.lineTo(x + width, y + height - r); shape.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  shape.lineTo(x + r, y + height); shape.quadraticCurveTo(x, y + height, x, y + height - r);
  shape.lineTo(x, y + r); shape.quadraticCurveTo(x, y, x + r, y);
  return shape;
};
function normalizeUv(geometry: BufferGeometry, width: number, height: number): BufferGeometry {
  const position = geometry.attributes.position!, uv = geometry.attributes.uv!;
  for (let i = 0; i < position.count; i++) uv.setXY(i, (position.getX(i) + width / 2) / width, (position.getY(i) + height / 2) / height);
  uv.needsUpdate = true;
  return geometry;
}
/** A rounded rectangle in the XY plane, centred, with UVs normalised to 0..1 over its bounds. */
export const roundedRect = (width: number, height: number, radius: number, segments = 10): BufferGeometry => normalizeUv(new ShapeGeometry(roundShape(width, height, radius), segments), width, height);

/** Device depth as a share of the body's long side, by form. */
const DEPTH: Record<FrameSpec['form'], number> = {phone: 0.052, foldable: 0.04, tablet: 0.022, 'watch-round': 0.22, 'watch-square': 0.22, tv: 0.03, automotive: 0.06};

/** The 3D body for `spec` around a screen of the picture's proportions (natural orientation). */
export function buildBody(spec: FrameSpec, picture: {width: number; height: number} | undefined, colors: BodyColors): Group {
  const layout = frameLayout(spec, picture, 0);
  const {glass, bodyRect} = layout;
  const k = SCREEN_HEIGHT / Math.max(glass.w, glass.h);
  // Layout units (y down, origin top-left) → scene units (y up, centred on the body).
  const cx = bodyRect.x + bodyRect.w / 2, cy = bodyRect.y + bodyRect.h / 2;
  const X = (x: number) => (x - cx) * k, Y = (y: number) => (cy - y) * k;
  const toShape = (ops: PathOp[]): Shape => {
    const shape = new Shape();
    for (const op of ops) {
      if (op[0] === 'M') shape.moveTo(X(op[1]), Y(op[2]));
      else if (op[0] === 'L') shape.lineTo(X(op[1]), Y(op[2]));
      else if (op[0] === 'Q') shape.quadraticCurveTo(X(op[1]), Y(op[2]), X(op[3]), Y(op[4]));
    }
    return shape;
  };
  const shapeGeometry = (item: FrameShape): BufferGeometry => {
    if (item.circle) return new CircleGeometry(item.circle.r * k, 32).translate(X(item.circle.cx), Y(item.circle.cy), 0);
    return new ShapeGeometry(toShape(item.path!), 8);
  };

  const group = new Group();
  group.name = `muster-${spec.id}`;
  const bw = bodyRect.w * k, bh = bodyRect.h * k;
  const depth = Math.max(bw, bh) * DEPTH[spec.form];
  const curved = spec.edge === 'curved';
  const bevel = curved ? Math.min(depth * 0.45, 0.06) : Math.min(depth * 0.12, 0.012);
  const body = new MeshStandardMaterial({color: colors.body, metalness: spec.color === 'light' ? 0.25 : 0.6, roughness: curved ? 0.3 : 0.42});
  const trim = new MeshStandardMaterial({color: colors.trim, metalness: 0.2, roughness: 0.6});
  // The shell: the body outline extruded, its edge bevelled round (curved) or nearly square (flat).
  const shell = new ExtrudeGeometry(toShape(layout.body), {depth: Math.max(0.001, depth - bevel * 2), bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel * 0.9, bevelSegments: curved ? 6 : 2, curveSegments: 16});
  shell.translate(0, 0, -Math.max(0.001, depth - bevel * 2) / 2);
  group.add(new Mesh(shell, body));
  const front = depth / 2;
  // Front glass across the bezels (the outline, a hair inside the edge), then the live screen just above it.
  const face = new Mesh(new ShapeGeometry(toShape(layout.body), 12), new MeshBasicMaterial({color: colors.screenOff}));
  face.scale.set(1 - 0.03 / Math.max(bw, 0.1), 1 - 0.03 / Math.max(bh, 0.1), 1);
  face.position.z = front + 0.002;
  group.add(face);
  const screenW = glass.w * k, screenH = glass.h * k;
  const screenGeometry = glass.round ? normalizeUv(new CircleGeometry(screenW / 2, 64), screenW, screenH) : roundedRect(screenW, screenH, glass.r * k);
  const screen = new Mesh(screenGeometry, new MeshBasicMaterial({color: colors.screenOff, toneMapped: false}));
  screen.name = SCREEN_NAME;
  screen.position.set(X(glass.x + glass.w / 2), Y(glass.y + glass.h / 2), front + 0.004);
  group.add(screen);
  // The cut-out over the screen, and the bezel marks (camera, speaker, Home button ring, hinge).
  const black = new MeshBasicMaterial({color: 0x000000, toneMapped: false});
  for (const cutout of layout.cutouts) { const mesh = new Mesh(shapeGeometry(cutout), black); mesh.position.z = front + 0.006; mesh.name = 'muster-cutout'; group.add(mesh); }
  const mark = new MeshStandardMaterial({color: colors.lens, metalness: 0.2, roughness: 0.3});
  for (const item of layout.marks) {
    const mesh = item.ring && item.circle
      ? new Mesh(new RingGeometry(item.circle.r * k * 0.82, item.circle.r * k, 40).translate(X(item.circle.cx), Y(item.circle.cy), 0), trim)
      : new Mesh(shapeGeometry(item), mark);
    mesh.position.z = front + 0.005;
    group.add(mesh);
  }
  // Buttons stand out from the side faces where the spec puts them.
  for (const button of layout.buttons) {
    const {rect} = button;
    const b = new Mesh(new BoxGeometry(Math.max(rect.w * k, 0.02), Math.max(rect.h * k, 0.02), depth * 0.42), body);
    b.position.set(X(rect.x + rect.w / 2), Y(rect.y + rect.h / 2), 0);
    b.name = `muster-button-${button.kind}`;
    group.add(b);
  }
  // A TV's stand.
  for (const path of layout.stand) { const stand = new Mesh(new ExtrudeGeometry(toShape(path), {depth: depth * 1.6, bevelEnabled: false}), body); stand.position.z = -depth * 0.8; group.add(stand); }
  // Back cameras, styled per family (seen from the back the module sits top-left, which is +x in front coordinates).
  const backZ = -depth / 2 - 0.012, s = Math.min(bw, bh);
  const lensMaterial = new MeshStandardMaterial({color: colors.lens, metalness: 0.1, roughness: 0.15});
  const lens = (x: number, y: number, r: number) => { const g = new Mesh(new CylinderGeometry(r, r, 0.03, 28), lensMaterial); g.rotation.x = Math.PI / 2; g.position.set(x, y, backZ - 0.02); group.add(g); };
  const plate = (w: number, h: number, x: number, y: number, r: number) => { const m = new Mesh(new ExtrudeGeometry(roundShape(w, h, r), {depth: 0.03, bevelEnabled: false}), trim); m.position.set(x, y, backZ - 0.015); group.add(m); };
  if (spec.back === 'square') { const size = s * 0.42, x = bw / 2 - s * 0.06 - size / 2, y = bh / 2 - s * 0.06 - size / 2; plate(size, size, x, y, size * 0.22); lens(x - size * 0.22, y + size * 0.22, size * 0.17); lens(x - size * 0.22, y - size * 0.22, size * 0.17); lens(x + size * 0.22, y, size * 0.15); }
  else if (spec.back === 'bar') { const h = s * 0.16, y = bh / 2 - bh * 0.18; plate(bw * 1.002, h, 0, y, h * 0.5); lens(bw * 0.2, y, h * 0.3); lens(bw * 0.05, y, h * 0.3); }
  else if (spec.back === 'pill') { const w = bw * 0.62, h = s * 0.18, y = bh / 2 - bh * 0.16; plate(w, h, 0, y, h * 0.5); lens(-w * 0.28, y, h * 0.3); lens(-w * 0.06, y, h * 0.3); }
  else if (spec.back === 'single') lens(bw / 2 - s * 0.12, bh / 2 - s * 0.12, s * 0.05);
  return group;
}
