import assert from 'node:assert/strict';
import {test} from 'node:test';
import {formatBytes,runLabel,terminalText,TIMEOUTS} from '../src/renderer/scopedComputerText.ts';
import {SCOPED_COMPUTER_DEFAULT_TIMEOUT_MS,SCOPED_COMPUTER_MAX_TIMEOUT_MS,SCOPED_COMPUTER_COMMANDS,isScopedComputerCommand} from '../src/shared/scoped-computer-protocol.ts';

test('terminal text strips ANSI escapes and keeps the last carriage-return frame',()=>{
  assert.equal(terminalText('\x1b[1;32mok\x1b[0m done\n'),'ok done\n');
  assert.equal(terminalText('\x1b]0;title\x07prompt'),'prompt');
  assert.equal(terminalText('10%\r50%\r100%\nnext\r\n'),'100%\nnext\n');
  assert.equal(terminalText('plain'),'plain');
});
test('labels and sizes read as plain language',()=>{
  assert.equal(formatBytes(512),'512 B');assert.equal(formatBytes(1536),'1.5 KB');assert.equal(formatBytes(250*1024**2),'250 MB');
  assert.equal(runLabel({state:'failed',exitCode:2}),'Exit 2');assert.equal(runLabel({state:'recovery-needed',exitCode:null,restored:true}),'Ended when Muster closed');assert.equal(runLabel({state:'timed-out',exitCode:143}),'Timed out');
});
test('the UI defaults to 30 minutes and offers limits up to the two-hour cap',()=>{
  assert.equal(SCOPED_COMPUTER_DEFAULT_TIMEOUT_MS,30*60_000);assert.ok(TIMEOUTS.some(item=>item.ms===SCOPED_COMPUTER_DEFAULT_TIMEOUT_MS));
  assert.equal(Math.max(...TIMEOUTS.map(item=>item.ms)),SCOPED_COMPUTER_MAX_TIMEOUT_MS);
  for(const command of ['computer.execStream','computer.input','computer.setNetwork','computer.repair','computer.files.list','computer.files.import','computer.files.export','computer.workspace.size','computer.workspace.delete','computer.history'])assert.ok(isScopedComputerCommand(command)&&command in SCOPED_COMPUTER_COMMANDS,command);
  assert.equal(isScopedComputerCommand('computer.toString'),false);assert.equal(isScopedComputerCommand('constructor'),false);
});
