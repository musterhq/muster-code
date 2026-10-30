import {BufferAttribute, type BufferGeometry, type Mesh} from 'three';

/** A landscape picture on a portrait screen: the body turns a quarter and the screen's UVs turn with it, so the picture
 *  stays upright and a hit's uv still names the picture's pixel. */
export function orientScreen(screen: Mesh, landscape: boolean): void {
  const geometry = screen.geometry as BufferGeometry, uv = geometry.attributes.uv as BufferAttribute | undefined;
  if (!uv) return;
  const original = (screen.userData.uv as Float32Array | undefined) ?? (screen.userData.uv = Float32Array.from(uv.array as ArrayLike<number>));
  const next = new Float32Array(original.length);
  for (let i = 0; i < original.length; i += 2) {
    const u = original[i]!, v = original[i + 1]!;
    next[i] = landscape ? 1 - v : u; next[i + 1] = landscape ? u : v;
  }
  geometry.setAttribute('uv', new BufferAttribute(next, 2));
}

