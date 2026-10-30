import {Raycaster, Vector2, type Camera, type Object3D, type Vector3} from 'three';

/** A surface hit with the texture coordinate under the pointer. */
export interface PickHit {
  object: Object3D;
  point: Vector3;
  distance: number;
  faceIndex: number | null;
  /** Texture coordinate of the hit, v = 1 at the TOP of the image (three.js convention). Absent when the mesh has no uv. */
  uv: {u: number; v: number} | null;
}

/** Client coordinates to normalized device coordinates (-1..1, y up) for `rect`. */
export function pointerToNdc(rect: {left: number; top: number; width: number; height: number}, clientX: number, clientY: number): {x: number; y: number} {
  return {x: ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1, y: 1 - ((clientY - rect.top) / Math.max(1, rect.height)) * 2};
}

/**
 * Texture coordinate to pixel of an image `width` x `height`. The engine's FrameTexture shows image row 0 at v = 1, so
 * `y = (1 - v) * height` for every source type (video, canvas, ImageBitmap). Clamped to the image.
 */
export function uvToPixel(uv: {u: number; v: number}, width: number, height: number): {x: number; y: number} {
  return {x: Math.min(width - 1, Math.max(0, Math.floor(uv.u * width))), y: Math.min(height - 1, Math.max(0, Math.floor((1 - uv.v) * height)))};
}

/** Inverse of uvToPixel for the centre of a pixel. */
export function pixelToUv(x: number, y: number, width: number, height: number): {u: number; v: number} {
  return {u: (x + 0.5) / width, v: 1 - (y + 0.5) / height};
}

const raycaster = new Raycaster();
const ndc = new Vector2();

/** Nearest hit of `targets` (recursive) under NDC (x, y), or null. Allocation-light; one shared Raycaster. */
export function pickObjects(camera: Camera, targets: Object3D | Object3D[], x: number, y: number): PickHit | null {
  ndc.set(x, y);
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(Array.isArray(targets) ? targets : [targets], true);
  const hit = hits[0];
  if (!hit) return null;
  return {object: hit.object, point: hit.point.clone(), distance: hit.distance, faceIndex: hit.faceIndex ?? null, uv: hit.uv ? {u: hit.uv.x, v: hit.uv.y} : null};
}
