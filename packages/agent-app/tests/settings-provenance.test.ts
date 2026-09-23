import assert from 'node:assert/strict';
import {test} from 'node:test';
import {SETTING_DEFAULTS, normalizeSettings, validateSetting} from '../src/shared/domains/settings-protocol.ts';
import {provenance, recordProvenance, settingProvenance} from '../src/renderer/components/settings/provenance.ts';
import {attentionAllowed, notificationPrefs, notificationsMuted, wantedNotices, type SettledNotice} from '../src/main/chat-notifications.ts';

test('PRO-10: each setting names where its value comes from and whether it can reset to the inherited level', () => {
  assert.deepEqual(settingProvenance('general.sendKey', SETTING_DEFAULTS), {level: 'built-in', label: 'Built-in default', canReset: false});
  const mine = settingProvenance('general.sendKey', {...SETTING_DEFAULTS, 'general.sendKey': 'mod-enter'});
  assert.deepEqual(mine, {level: 'user', label: 'Set by you', inherits: 'the built-in default', canReset: true});
  assert.equal(settingProvenance('general.defaultModel', {...SETTING_DEFAULTS, 'general.defaultModel': {providerId: 'hybrow', model: 'm'}}).level, 'user', 'object values compare structurally');
  assert.equal(recordProvenance(true, {a: 1}, {a: 1}).level, 'built-in', 'a stored record equal to the inherited one is not an override');
  assert.equal(recordProvenance(true, {a: 2}, {a: 1}).level, 'user');
  assert.equal(recordProvenance(false, {a: 2}, {a: 1}).level, 'built-in');
  assert.deepEqual(provenance('project'), {level: 'project', label: 'Project override', inherits: 'your default', canReset: true});
  assert.equal(provenance('folder').label, 'Folder override');
});

test('AUT-05: notification preferences validate and survive normalisation', () => {
  assert.equal(SETTING_DEFAULTS['notifications.runs'], 'all');
  assert.equal(SETTING_DEFAULTS['notifications.attention'], true);
  assert.equal(SETTING_DEFAULTS['notifications.mutedUntil'], null);
  assert.equal(validateSetting('notifications.runs', 'failures'), 'failures');
  assert.throws(() => validateSetting('notifications.runs', 'loud'), /notifications.runs must be "all", "failures" or "off"/);
  assert.throws(() => validateSetting('notifications.mutedUntil', 'tomorrow-ish'), /ISO date-time/);
  assert.equal(validateSetting('notifications.mutedUntil', '2026-09-24T10:00:00.000Z'), '2026-09-24T10:00:00.000Z');
  assert.equal(normalizeSettings({'notifications.attention': 'no'})['notifications.attention'], true, 'invalid stored values fall back');
});

test('AUT-05: run notifications follow the preference and mute; attention alerts can be turned off', () => {
  const notices: SettledNotice[] = [{chatId: 'a', title: 'A', body: 'Finished', status: 'completed'}, {chatId: 'b', title: 'B', body: 'Failed: x', status: 'failed'}];
  const now = Date.parse('2026-09-23T12:00:00Z');
  const prefs = notificationPrefs(undefined);
  assert.deepEqual(wantedNotices(notices, prefs, now).map(n => n.chatId), ['a', 'b']);
  assert.deepEqual(wantedNotices(notices, {...prefs, 'notifications.runs': 'failures'}, now).map(n => n.chatId), ['b']);
  assert.deepEqual(wantedNotices(notices, {...prefs, 'notifications.runs': 'off'}, now), []);
  const muted = {...prefs, 'notifications.mutedUntil': '2026-09-23T13:00:00Z'};
  assert.equal(notificationsMuted(muted, now), true);
  assert.deepEqual(wantedNotices(notices, muted, now), [], 'muted silences everything');
  assert.equal(attentionAllowed(muted, now), false);
  assert.equal(notificationsMuted(muted, Date.parse('2026-09-23T13:00:01Z')), false, 'a mute expires on its own');
  assert.equal(attentionAllowed({...prefs, 'notifications.attention': false}, now), false);
  assert.equal(attentionAllowed(prefs, now), true);
});
