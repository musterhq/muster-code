/**
 * #840: dictation in the composer. The renderer records with MediaRecorder; a transcription backend chosen in
 * Settings › Chat turns the recording into text. Audio leaves the computer only when a cloud backend is chosen,
 * and nothing is kept after transcription (no file, no log line).
 */
/** `off`: no backend (a browser host may still use its own Web Speech). `cloud`: an OpenAI-compatible
 *  `/audio/transcriptions` endpoint with the person's own key. `macos` (on-device speech) and `local` (a local model)
 *  are listed for the choice but not available in this build. */
export type DictationBackendId = 'off' | 'cloud' | 'macos' | 'local';
export const DICTATION_BACKENDS: readonly DictationBackendId[] = ['off', 'cloud', 'macos', 'local'];
export interface DictationBackendView { id: DictationBackendId; label: string; available: boolean; reason?: string }
export interface DictationCloudView {
  /** A saved OpenAI-compatible connection (Settings › Providers) whose endpoint and key are used; null for the endpoint below. */
  connectionId: string | null;
  endpoint: string;
  model: string;
  /** A key entered for dictation is saved (encrypted). Never the key itself. */
  keyStored: boolean;
  secureStorage: boolean;
}
export interface DictationConfigView {
  backend: DictationBackendId;
  /** The chosen backend can transcribe now. */
  ready: boolean;
  /** Why it cannot, in a sentence the composer can show. */
  reason?: string;
  backends: DictationBackendView[];
  cloud: DictationCloudView;
}
export interface DictationConfigInput {
  backend?: DictationBackendId;
  connectionId?: string | null;
  endpoint?: string;
  model?: string;
  /** A new key for the dictation endpoint; null removes the saved one. */
  apiKey?: string | null;
}
export type MicrophoneStatus = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown';
export interface MicrophoneAccess { granted: boolean; status: MicrophoneStatus; message?: string }
export interface DictationTranscribeInput { /** The recording, base64. */ audio: string; mime: string }

/** The cloud limit most OpenAI-compatible services share (25 MB), less room for the multipart envelope. */
export const DICTATION_MAX_AUDIO_BYTES = 24 * 1024 * 1024;
/** A recording longer than this stops by itself and is transcribed. */
export const DICTATION_MAX_SECONDS = 300;
/** Holding the shortcut longer than this is push-to-talk (release transcribes); a shorter tap toggles recording on. */
export const DICTATION_HOLD_MS = 350;
export const MICROPHONE_SETTINGS_HINT = 'Turn it on in System Settings › Privacy & Security › Microphone, then try again.';

export interface DictationCommands {
  'dictation.config.get': { input: Record<string, never> | undefined; output: DictationConfigView };
  'dictation.config.set': { input: DictationConfigInput; output: DictationConfigView };
  'dictation.transcribe': { input: DictationTranscribeInput; output: { text: string } };
  /** Asks the system for microphone access when it has not been decided (macOS); answered by the main process. */
  'dictation.microphone': { input: Record<string, never> | undefined; output: MicrophoneAccess };
}
export type DictationEvent = never;
export const DICTATION_COMMANDS = {'dictation.config.get': true, 'dictation.config.set': true, 'dictation.transcribe': true, 'dictation.microphone': true} as const satisfies Record<keyof DictationCommands, true>;
