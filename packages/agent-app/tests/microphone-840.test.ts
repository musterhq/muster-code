/** #840: microphone access for dictation in the main process. Fake systemPreferences: no Electron, no real microphone. */
import assert from 'node:assert/strict';
import {test} from 'node:test';

// Spec: MUS-SPEC-01-840J (docs/spec/clauses/01-chat-and-composer.md#mus-spec-01-840j)
test('microphone access asks macOS when undecided and explains a denial', async () => {
  const {microphoneAccess} = await import('../src/main/microphone.ts');
  const asked: string[] = [];
  const undecided = {getMediaAccessStatus: () => 'not-determined', askForMediaAccess: async (type: 'microphone') => { asked.push(type); return true; }};
  const granted = await microphoneAccess(undecided, 'darwin');
  assert.deepEqual(asked, ['microphone'], 'macOS is asked once');
  assert.equal(granted.granted, true);

  const refused = {getMediaAccessStatus: () => 'not-determined', askForMediaAccess: async () => false};
  const no = await microphoneAccess(refused, 'darwin');
  assert.equal(no.granted, false);
  assert.match(no.message ?? '', /System Settings › Privacy & Security › Microphone/);

  asked.length = 0;
  const denied = {getMediaAccessStatus: () => 'denied', askForMediaAccess: async (type: 'microphone') => { asked.push(type); return true; }};
  const result = await microphoneAccess(denied, 'darwin');
  assert.deepEqual(asked, [], 'a denial is not asked again (macOS would not show the prompt)');
  assert.equal(result.granted, false);
  assert.equal(result.status, 'denied');
  assert.match(result.message ?? '', /System Settings › Privacy & Security › Microphone/);

  const ready = await microphoneAccess({getMediaAccessStatus: () => 'granted'}, 'darwin');
  assert.equal(ready.granted, true);
  const linux = await microphoneAccess({getMediaAccessStatus: () => { throw new Error('not on linux'); }}, 'linux');
  assert.equal(linux.granted, true, 'other systems let the page ask for itself');
});

// Spec: MUS-SPEC-01-840K (docs/spec/clauses/01-chat-and-composer.md#mus-spec-01-840k)
test('only the app page may open the microphone, and only for audio', async () => {
  const {allowMediaPermission} = await import('../src/main/microphone.ts');
  const page = 'file:///Applications/Muster%20Agent.app/Contents/Resources/app/dist/renderer/index.html';
  const base = {permission: 'media', mediaTypes: ['audio'], requestingUrl: `${page}#chat`, fromAppWindow: true, rendererURL: page};
  assert.equal(allowMediaPermission(base), true, 'audio from the app page');
  assert.equal(allowMediaPermission({...base, mediaTypes: ['audio', 'video']}), false, 'no camera');
  assert.equal(allowMediaPermission({...base, mediaTypes: ['video']}), false, 'no camera');
  assert.equal(allowMediaPermission({...base, mediaTypes: []}), false, 'an unspecified media request');
  assert.equal(allowMediaPermission({...base, permission: 'geolocation'}), false, 'other permissions');
  assert.equal(allowMediaPermission({...base, permission: 'notifications'}), false, 'other permissions');
  assert.equal(allowMediaPermission({...base, requestingUrl: 'https://evil.example/'}), false, 'another page');
  assert.equal(allowMediaPermission({...base, fromAppWindow: false}), false, 'another window (a plugin frame or the browser pane)');
});
