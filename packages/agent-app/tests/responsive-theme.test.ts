import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolveTheme} from '../src/renderer/components/settings/preferences.ts';
import {validateSetting, SETTING_DEFAULTS} from '../src/shared/domains/settings-protocol.ts';
import {applyThemeSource, themeFromSettingsResult, windowBackground} from '../src/main/theme.ts';

test('UX-19: theme setting validates, resolves and drives nativeTheme', () => {
  assert.equal(SETTING_DEFAULTS['appearance.theme'], 'dark', 'the app keeps shipping dark');
  assert.equal(validateSetting('appearance.theme', 'light'), 'light');
  assert.throws(() => validateSetting('appearance.theme', 'sepia'), /"system", "dark" or "light"/);
  assert.equal(resolveTheme('light', false), 'light');
  assert.equal(resolveTheme('dark', true), 'dark');
  assert.equal(resolveTheme('system', true), 'light');
  assert.equal(resolveTheme('system', false), 'dark');
  assert.equal(resolveTheme(undefined, true), 'dark');
  const native = {themeSource: 'dark' as 'dark' | 'light' | 'system'};
  assert.equal(applyThemeSource(native, themeFromSettingsResult({values: {'appearance.theme': 'system'}})), true);
  assert.equal(native.themeSource, 'system');
  assert.equal(applyThemeSource(native, themeFromSettingsResult({values: {'appearance.theme': 'system'}})), false, 'no-op when unchanged');
  assert.equal(themeFromSettingsResult({path: null}), undefined, 'non-settings results are ignored');
  assert.equal(windowBackground(false), '#fbfbfb');
});
