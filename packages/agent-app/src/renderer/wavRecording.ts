/**
 * #840: the local dictation backend (whisper.cpp) reads 16 kHz mono 16-bit WAV, and MediaRecorder makes webm/opus.
 * Chromium decodes the recording, an OfflineAudioContext mixes it to one channel at 16 kHz, and the samples are
 * written as PCM WAV. Everything stays in memory.
 */
import { DICTATION_WAV_RATE } from '../shared/domains/dictation-protocol';

type AudioScope = { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext; OfflineAudioContext?: typeof OfflineAudioContext };

/** PCM 16-bit mono WAV of the given samples (-1..1). */
export function encodeWav(samples: Float32Array, rate = DICTATION_WAV_RATE): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(44 + samples.length * 2), view = new DataView(out.buffer);
  const text = (at: number, value: string) => { for (let i = 0; i < value.length; i++) out[at + i] = value.charCodeAt(i); };
  text(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff), true);
  }
  return out;
}

/** The recording as 16 kHz mono WAV. Throws a plain message when this window cannot decode it. */
export async function recordingAsWav(blob: Blob): Promise<Blob> {
  const scope = globalThis as unknown as AudioScope;
  const Context = scope.AudioContext ?? scope.webkitAudioContext, Offline = scope.OfflineAudioContext;
  if (!Context || !Offline) throw new Error('This window cannot convert the recording for the local model.');
  const context = new Context();
  let decoded: AudioBuffer;
  try { decoded = await context.decodeAudioData(await blob.arrayBuffer()); }
  catch { throw new Error('The recording could not be read. Try again.'); }
  finally { void context.close().catch(() => undefined); }
  const frames = Math.max(1, Math.ceil(decoded.duration * DICTATION_WAV_RATE));
  const offline = new Offline(1, frames, DICTATION_WAV_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return new Blob([encodeWav(rendered.getChannelData(0))], { type: 'audio/wav' });
}
