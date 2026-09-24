import assert from 'node:assert/strict';
import test from 'node:test';
import {resolvePersonality} from '../src/runtime/domains/settings.ts';
import {SETTING_DEFAULTS,validateSetting} from '../src/shared/domains/settings-protocol.ts';

test('response style: Automatic follows the Codex config personality, else Friendly; an explicit choice always wins', () => {
  assert.equal(SETTING_DEFAULTS['chat.responseStyle'],'auto');
  assert.equal(resolvePersonality('auto',''),'friendly','no config: the desktop default');
  assert.equal(resolvePersonality('auto','model = "x"\npersonality = "pragmatic"\n'),undefined,'the user\'s own personality is left to Codex');
  assert.equal(resolvePersonality('auto','  model_personality = "friendly"'),undefined,'the older key counts too');
  assert.equal(resolvePersonality('auto','# personality = "pragmatic"'),'friendly','a commented-out line does not');
  assert.equal(resolvePersonality('pragmatic','personality = "friendly"'),'pragmatic');
  assert.equal(resolvePersonality('friendly',''),'friendly');
  assert.equal(validateSetting('chat.responseStyle','pragmatic'),'pragmatic');
  assert.throws(()=>validateSetting('chat.responseStyle','chatty'),/auto.*friendly.*pragmatic/);
});
