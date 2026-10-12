/**
 * three-engine: the shared three.js runtime for Muster (model preview today, the 3D device frame next).
 * This barrel is the only import surface; import it lazily (`await import('.../three-engine')`) so three.js stays
 * out of the initial renderer bundle. Contract and examples: ./README.md
 */
export {Engine, createEngine} from './engine.ts';
export type {ActivityGate, EngineOptions, EngineStats, FrameOptions, FrameScheduler, RendererLike} from './engine.ts';
export {OrbitState, bindOrbitInput, angleDelta, DEFAULT_ORBIT} from './controls.ts';
export type {OrbitOptions, OrbitLimits, OrbitPhase, SnapOptions} from './controls.ts';
export {CAMERA_PRESETS} from './cameraPresets.ts';
export type {CameraPreset} from './cameraPresets.ts';
export {createLighting} from './lighting.ts';
export type {LightingPreset} from './lighting.ts';
export {readEngineTheme, deriveTheme, resolveCssColor, THEME_TOKENS} from './theme.ts';
export type {EngineTheme} from './theme.ts';
export {FrameTexture} from './frameTexture.ts';
export type {FrameHost, FrameSource} from './frameTexture.ts';
export {pickObjects, pointerToNdc, uvToPixel, pixelToUv} from './raycast.ts';
export type {PickHit} from './raycast.ts';
export {disposeObject, disposeMaterial, disposeTexture} from './dispose.ts';
