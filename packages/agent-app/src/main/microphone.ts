/** #840: microphone access for dictation. macOS asks once per app (Info.plist NSMicrophoneUsageDescription); the
 *  window's permission handler lets only the app's own page open the microphone, and only for audio. */
import { MICROPHONE_SETTINGS_HINT, type MicrophoneAccess, type MicrophoneStatus } from '../shared/domains/dictation-protocol.ts';
import { device } from '../shared/device-noun.ts';

export interface MediaAccessProbe {
  getMediaAccessStatus(type: 'microphone'): string;
  askForMediaAccess?(type: 'microphone'): Promise<boolean>;
}
const DENIED = `Microphone access is off for Muster. ${MICROPHONE_SETTINGS_HINT}`;
const RESTRICTED = `Microphone access is blocked on ${device().lower} (a device profile or Screen Time restriction).`;

export async function microphoneAccess(probe: MediaAccessProbe, platform: string = process.platform): Promise<MicrophoneAccess> {
  // Windows and Linux: Chromium's own getUserMedia prompt and the system privacy settings decide.
  if (platform !== 'darwin') return { granted: true, status: 'unknown' };
  let status: string;
  try { status = probe.getMediaAccessStatus('microphone'); } catch { return { granted: true, status: 'unknown' }; }
  if (status === 'granted') return { granted: true, status: 'granted' };
  if (status === 'denied') return { granted: false, status: 'denied', message: DENIED };
  if (status === 'restricted') return { granted: false, status: 'restricted', message: RESTRICTED };
  if (!probe.askForMediaAccess) return { granted: true, status: status as MicrophoneStatus };
  const granted = await probe.askForMediaAccess('microphone').catch(() => false);
  return granted ? { granted: true, status: 'granted' } : { granted: false, status: 'denied', message: DENIED };
}

/** The app window's session refuses every permission except an audio-only media request from the app page itself. */
export function allowMediaPermission(input: { permission: string; mediaTypes?: readonly string[]; requestingUrl?: string; fromAppWindow: boolean; rendererURL: string }): boolean {
  if (input.permission !== 'media' || !input.fromAppWindow) return false;
  const types = input.mediaTypes ?? [];
  if (!types.length || types.some(type => type !== 'audio')) return false;
  return typeof input.requestingUrl === 'string' && input.requestingUrl.split('#')[0] === input.rendererURL;
}
