/**
 * #840: dictation for the composers (chat, steer and new chat). In the desktop app the page records with
 * MediaRecorder (webm/opus) and the backend chosen in Settings › Chat transcribes it (`dictation.transcribe`, sent
 * from the main process). In a browser with no backend chosen, the browser's own Web Speech is used when it has one.
 *
 * Recording is visible (the mic is pressed and the status line says Listening), Esc cancels without sending
 * anything, and the microphone is released as soon as recording stops. The audio lives only in memory until it is
 * transcribed; nothing is stored or logged.
 */
import { useEffect, useRef, useState } from 'react';
import { DICTATION_HOLD_MS, DICTATION_MAX_SECONDS, MICROPHONE_SETTINGS_HINT } from '../shared/domains/dictation-protocol';
import { invoke } from './bridge';
import { runtimeMessage as errorText } from './composerBridge';
import { openAppSettings, pushNotice } from './store';

export type DictationPhase = 'idle' | 'starting' | 'recording' | 'transcribing';
export interface DictationState { phase: DictationPhase; interim: string }

/** Web Speech (Chromium exposes the prefixed constructor). Electron exposes it too but ships no speech service. */
type Recognition = { continuous: boolean; interimResults: boolean; lang: string; start(): void; stop(): void; abort(): void;
  onresult: ((event: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null; onerror: ((event: { error: string }) => void) | null; onend: (() => void) | null };
const SPEECH_ERRORS: Record<string, string> = { 'not-allowed': `Microphone access was denied. ${MICROPHONE_SETTINGS_HINT}`, 'service-not-allowed': 'Dictation is not available on this system', 'no-speech': 'No speech heard', network: 'Dictation needs a network connection', 'audio-capture': 'No microphone found' };
type Recorder = { state: string; mimeType?: string; start(): void; stop(): void; ondataavailable: ((event: { data: Blob }) => void) | null; onstop: (() => void) | null; onerror: ((event: unknown) => void) | null };
type RecorderClass = (new (stream: MediaStream, options?: { mimeType?: string }) => Recorder) & { isTypeSupported?(type: string): boolean };
const MIME_PREFERENCE = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];

const nav = (): (Navigator & { mediaDevices?: MediaDevices }) | undefined => (globalThis as { navigator?: Navigator }).navigator;
const recorderClass = (): RecorderClass | undefined => (globalThis as { MediaRecorder?: RecorderClass }).MediaRecorder;
const electron = () => /\bElectron\//.test(nav()?.userAgent ?? '');
export function webSpeech(): (new () => Recognition) | undefined {
  if (typeof window === 'undefined' || electron()) return undefined;
  const scope = window as unknown as Record<string, new () => Recognition>;
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
}
/** The app can record and send audio to a transcription backend. */
export function canRecord(): boolean {
  return typeof window !== 'undefined' && Boolean((window as { muster?: unknown }).muster) && typeof nav()?.mediaDevices?.getUserMedia === 'function' && typeof recorderClass() === 'function';
}
export const dictationSupported = (): boolean => canRecord() || Boolean(webSpeech());
/** ⌘⇧D (Ctrl+Shift+D elsewhere): hold to talk, tap to toggle. */
export const isDictationShortcut = (event: { key: string; code?: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }) =>
  (event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && (event.code === 'KeyD' || event.key.toLowerCase() === 'd');
export const DICTATION_SHORTCUT_LABEL = () => (/Mac/i.test(nav()?.platform ?? '') ? '⌘⇧D' : 'Ctrl+Shift+D');

function base64(bytes: Uint8Array): string {
  let out = '';
  for (let at = 0; at < bytes.length; at += 0x8000) out += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(out);
}
const pickMime = (Class: RecorderClass) => MIME_PREFERENCE.find(type => { try { return Class.isTypeSupported?.(type) ?? false; } catch { return false; } });
const release = (stream: MediaStream | undefined) => { for (const track of stream?.getTracks() ?? []) { try { track.stop(); } catch { /* already stopped */ } } };

interface Session { stream: MediaStream; recorder: Recorder; chunks: Blob[]; mime: string; cancelled: boolean; timer: ReturnType<typeof setTimeout> }

export interface DictationOptions {
  /** Final words to insert at the caret. */
  onText(words: string): void;
  /** A short line in the composer's status area. */
  flash(message: string): void;
  /** Back to idle (after inserting, cancelling or failing). */
  onIdle?(): void;
}

export function useDictation(options: DictationOptions) {
  const latest = useRef(options); latest.current = options;
  const [state, setState] = useState<DictationState>({ phase: 'idle', interim: '' });
  const phase = useRef<DictationPhase>('idle');
  const session = useRef<Session | null>(null);
  const speech = useRef<Recognition | null>(null);
  const generation = useRef(0);
  const hold = useRef<{ at: number } | null>(null);
  const move = (next: DictationPhase, interim = '') => {
    phase.current = next; setState({ phase: next, interim });
    if (next === 'idle') latest.current.onIdle?.();
  };

  const startSpeech = (Speech: new () => Recognition) => {
    let engine: Recognition;
    try { engine = new Speech(); } catch (cause) { latest.current.flash(errorText(cause)); move('idle'); return; }
    engine.continuous = true; engine.interimResults = true; engine.lang = nav()?.language || 'en-US';
    engine.onresult = event => {
      let final = '', interim = '';
      for (let index = event.resultIndex; index < event.results.length; index++) { const result = event.results[index]!; if (result.isFinal) final += result[0]!.transcript; else interim += result[0]!.transcript; }
      if (speech.current === engine) setState({ phase: 'recording', interim });
      if (final.trim()) latest.current.onText(final);
    };
    engine.onerror = event => { if (event.error !== 'aborted') latest.current.flash(SPEECH_ERRORS[event.error] ?? `Dictation stopped (${event.error})`); };
    engine.onend = () => { if (speech.current === engine) { speech.current = null; move('idle'); } };
    speech.current = engine;
    try { engine.start(); move('recording'); } catch (cause) { speech.current = null; latest.current.flash(errorText(cause)); move('idle'); }
  };

  const transcribe = async (current: Session) => {
    const blob = new Blob(current.chunks, { type: current.mime });
    current.chunks.length = 0;
    if (!blob.size) { latest.current.flash('No audio was recorded'); move('idle'); return; }
    move('transcribing');
    const mine = generation.current;
    try {
      const audio = base64(new Uint8Array(await blob.arrayBuffer()));
      const result = await invoke('dictation.transcribe', { audio, mime: current.mime });
      if (mine !== generation.current) return;
      const words = result?.text?.trim() ?? '';
      if (words) latest.current.onText(words); else latest.current.flash('No speech heard');
    } catch (cause) { if (mine === generation.current) latest.current.flash(errorText(cause)); }
    finally { if (mine === generation.current) move('idle'); }
  };

  const start = async () => {
    if (phase.current !== 'idle') return;
    const mine = ++generation.current;
    move('starting');
    try {
      const config = canRecord() ? await invoke('dictation.config.get', {}) : undefined;
      if (mine !== generation.current) return;
      if (!config?.ready) {
        const Speech = webSpeech();
        if (Speech) { startSpeech(Speech); return; }
        const reason = config?.reason ?? 'Choose a dictation service in Settings › Chat.';
        latest.current.flash(reason);
        pushNotice(reason, { kind: 'info', action: { label: 'Open Settings', run: () => openAppSettings('chat') } });
        move('idle'); return;
      }
      const access = await invoke('dictation.microphone', {});
      if (mine !== generation.current) return;
      if (!access?.granted) { latest.current.flash(access?.message ?? `Microphone access is off for Muster. ${MICROPHONE_SETTINGS_HINT}`); move('idle'); return; }
      const stream = await nav()!.mediaDevices!.getUserMedia({ audio: true });
      if (mine !== generation.current) { release(stream); return; }
      const Class = recorderClass()!, wanted = pickMime(Class);
      const recorder = new Class(stream, wanted ? { mimeType: wanted } : undefined);
      const current: Session = { stream, recorder, chunks: [], mime: recorder.mimeType || wanted || 'audio/webm', cancelled: false,
        timer: setTimeout(() => { if (session.current === current) finish(); }, DICTATION_MAX_SECONDS * 1000) };
      recorder.ondataavailable = event => { if (event.data && event.data.size) current.chunks.push(event.data); };
      recorder.onerror = () => { if (session.current === current) cancel(); latest.current.flash('Recording stopped unexpectedly'); };
      recorder.onstop = () => {
        clearTimeout(current.timer); release(current.stream);
        if (session.current === current) session.current = null;
        if (current.cancelled) { current.chunks.length = 0; return; }
        void transcribe(current);
      };
      session.current = current;
      recorder.start();
      move('recording');
    } catch (cause) {
      if (mine !== generation.current) return;
      const name = (cause as { name?: string })?.name;
      latest.current.flash(name === 'NotAllowedError' || name === 'SecurityError' ? `Microphone access was denied. ${MICROPHONE_SETTINGS_HINT}` : name === 'NotFoundError' ? 'No microphone found' : errorText(cause));
      if (session.current) { release(session.current.stream); session.current = null; }
      move('idle');
    }
  };
  /** Stop recording and transcribe what was said. */
  const finish = () => {
    if (phase.current === 'starting') { cancel(); return; }
    if (speech.current) { speech.current.stop(); return; }
    const current = session.current;
    if (!current) return;
    try { if (current.recorder.state !== 'inactive') current.recorder.stop(); else { session.current = null; release(current.stream); move('idle'); } }
    catch (cause) { session.current = null; release(current.stream); latest.current.flash(errorText(cause)); move('idle'); }
  };
  /** Discard: nothing is transcribed and the microphone is released. */
  const cancel = () => {
    generation.current++;
    hold.current = null;
    const engine = speech.current; speech.current = null;
    try { engine?.abort(); } catch { /* already ended */ }
    const current = session.current; session.current = null;
    if (current) {
      current.cancelled = true; current.chunks.length = 0; clearTimeout(current.timer);
      try { if (current.recorder.state !== 'inactive') current.recorder.stop(); } catch { /* already stopped */ }
      release(current.stream);
    }
    if (phase.current !== 'idle') move('idle');
  };
  const toggle = () => {
    if (phase.current === 'recording') finish();
    else if (phase.current === 'starting') cancel();
    else if (phase.current === 'idle') void start();
  };
  /** The composer's keydown: the hold-to-talk shortcut and Esc. Returns true when the key was handled. */
  const onKeyDown = (event: { key: string; code?: string; repeat?: boolean; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; preventDefault(): void; stopPropagation(): void }): boolean => {
    if (isDictationShortcut(event)) {
      event.preventDefault();
      if (event.repeat) return true;
      if (phase.current === 'idle') { hold.current = { at: Date.now() }; void start(); }
      else { hold.current = null; toggle(); }
      return true;
    }
    if (event.key === 'Escape' && phase.current !== 'idle') { event.preventDefault(); event.stopPropagation(); cancel(); return true; }
    return false;
  };
  // Releasing D (or the modifier: macOS sends no keyup for a key pressed with ⌘) ends a hold; a short tap keeps recording.
  useEffect(() => {
    const onKeyUp = (event: KeyboardEvent) => {
      const pressed = hold.current;
      if (!pressed) return;
      const key = event.key?.toLowerCase();
      if (!(event.code === 'KeyD' || key === 'd' || key === 'meta' || key === 'control' || key === 'shift')) return;
      hold.current = null;
      if (Date.now() - pressed.at >= DICTATION_HOLD_MS) finish();
    };
    document.addEventListener('keyup', onKeyUp);
    return () => document.removeEventListener('keyup', onKeyUp);
  }, []);
  useEffect(() => () => cancel(), []);

  return { state, active: state.phase !== 'idle', supported: dictationSupported(), toggle, start, finish, cancel, onKeyDown };
}
