import assert from 'node:assert/strict';
import {test} from 'node:test';
import {agentDisplayName, agentDisplayNames, agentTaskName} from '../src/renderer/agentIdentity.ts';
import {groupActivity, segmentActivity, subagentRowLabel} from '../src/renderer/components/activityGrouping.ts';
import {getSubagentActivity, phaseCounts} from '../src/renderer/subagentActivity.ts';
import type {TimelineItem} from '../src/shared/protocol.ts';

// The three prompts of the QA run in #582/#651: the same location clause, three different jobs.
const REPO = '/private/tmp/claude-501/w-qa/scratch';
const PROMPTS = [
  `In the repository at ${REPO}, count the lines in data/lines.txt and report the number.`,
  `In the repository at ${REPO}, list the files in assets/ and report their names.`,
  `In the repository at ${REPO}, summarize README.md in 5 words.`,
];

// Spec: MUS-SPEC-14-651A (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-651a)
test('a sub-agent is named from its task, not from the location clause the prompt opens with', () => {
  assert.deepEqual(PROMPTS.map(prompt => agentDisplayName({prompt})), [
    'Count the lines in data/lines.txt', 'List the files in assets/', 'Summarize README.md in 5 words',
  ]);
  assert.equal(agentTaskName(`In ${REPO}, fix the failing parser test.`), 'Fix the failing parser test');
  assert.equal(agentTaskName(`In the repo at ~/work/app: review the diff`), 'Review the diff');
  assert.equal(agentTaskName(`You are a careful reviewer. Check the migration for data loss.`), 'Check the migration for data loss');
  assert.equal(agentTaskName(`Please, in the repository at C:\\Users\\me\\app, audit the lockfile`), 'Audit the lockfile');
  assert.equal(agentTaskName('Task: map the build scripts. Then stop.'), 'Map the build scripts');
  assert.equal(agentTaskName('Refactor the cache layer to cut memory use in the parser and the lexer by half'), 'Refactor the cache layer to cut…', 'long tasks are cut at a word');
  assert.equal(agentTaskName(`In the repository at ${REPO}`), undefined, 'a prompt that is only a location names nothing');
  assert.equal(agentTaskName('   '), undefined);
  assert.equal(agentDisplayName({name:'Mira', prompt:PROMPTS[0]}), 'Mira', 'a provider name still wins');
  assert.equal(agentDisplayName({role:'explore', prompt:PROMPTS[0]}), 'Count the lines in data/lines.txt', 'the task beats a generic role');
  assert.equal(agentDisplayName({role:'explore'}), 'Explore');
  assert.equal(agentDisplayName({name:'019a1b2c-0001-7000-8000-000000000001'}, 3), 'Agent 3', 'thread ids are never names');
});

// Spec: MUS-SPEC-14-651B (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-651b)
test('names stay unique within a chat, and an unreadable prompt falls back to Agent N plus its first distinctive words', () => {
  const same = [{id:'a', prompt:'Run the tests.'}, {id:'b', prompt:'Run the tests.'}, {id:'c', prompt:'run the tests'}];
  assert.deepEqual([...agentDisplayNames(same).values()], ['Run the tests', 'Run the tests (2)', 'Run the tests (3)']);
  const bare = [{id:'a'}, {id:'b', prompt:`In the repository at ${REPO}`}, {id:'c', prompt:'/tmp/x/y'}];
  assert.equal(agentDisplayNames(bare).get('a'), 'Agent 1');
  assert.equal(agentDisplayName({prompt:'/tmp/x/y'}, 2), 'Agent 2', 'only a path: nothing distinctive to add');
});

const T0 = '2026-01-01T00:00:00Z';
const tool = (id: string, data: Record<string, unknown>, status = 'completed'): TimelineItem => ({id, chatId:'chat', kind:'tool', text:'', createdAt:T0, status, data});
const kids = ['019a1b2c-0001-7000-8000-000000000001', '019a1b2c-0002-7000-8000-000000000002', '019a1b2c-0003-7000-8000-000000000003'];
const spawns = PROMPTS.map((prompt, i) => tool(`s${i}`, {type:'collabAgentToolCall', tool:'spawnAgent', senderThreadId:'parent', prompt, receiverThreadIds:[kids[i]], agentsStates:{[kids[i]]:{status:'running'}}}));
const waited = tool('w', {type:'collabAgentToolCall', tool:'wait', senderThreadId:'parent', receiverThreadIds:kids, agentsStates:{[kids[0]]:{status:'completed'}, [kids[1]]:{status:'completed'}, [kids[2]]:{status:'completed'}}});

// Spec: MUS-SPEC-14-651C (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-651c)
test('three parallel sub-agents with the same location clause show three distinct rows in the transcript', () => {
  const labels = groupActivity([...spawns, waited]).flatMap(entry => entry.kind === 'activity' ? segmentActivity(entry.items, entry.prior, entry.agents).filter(row => row.kind === 'subagents').map(subagentRowLabel) : []);
  assert.deepEqual(labels, [
    'Count the lines in data/lines.txt, List the files in assets/ and Summarize README.md in 5 words started working',
    'Count the lines in data/lines.txt finished', 'List the files in assets/ finished', 'Summarize README.md in 5 words finished',
  ]);
  assert.equal(new Set(getSubagentActivity([...spawns, waited]).agents.map(agent => agent.prompt)).size, 3);
});
