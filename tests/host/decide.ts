import type { On } from 'claude-code';
import { expect, mock, test } from 'claude-code/testing';

const TOOL = 'mcp__fast-jev-compaction__jev_decide';

function host(on: On, answer: unknown) {
  mock.clock(on);
  mock.env(on, { TYPESAFE_API_KEY: 'test-key', HOME: '/home/me' });
  const seen = { files: [] as string[], logs: [] as string[], bodies: [] as string[] };
  on('ui.log', (_$, event) => {
    seen.logs.push(event.text);
    return { value: undefined };
  });
  on('fs.write', (_$, event) => {
    seen.files.push(event.text);
    return { value: undefined };
  });
  on('session.id', () => ({ value: 'session-1' }));
  on('session.cwd', () => ({ value: '/work/acme/api' }));
  on('settings.read', () => ({ value: {} }));
  on('http.fetch', (_$, event) => {
    seen.bodies.push(event.init?.body ?? '');
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ answers: { decision: answer }, usage: { input_tokens: 77 } }) } };
  });
  return seen;
}

test('a yes/no decision is answered by the tool.call hook and recorded', async ($, on) => {
  const seen = host(on, { noul: 0.9 });
  const out = await $.tool.call({ tool: TOOL, question: 'Is it done?', context: 'All tests pass.' });
  expect(out.result).toBe('Jev: yes (probability of yes: 90%). Jev gives no reasons and saw only the question and context of this call.');
  expect(seen.logs).toEqual(['Jev decided: yes (yes 90%)']);
  expect(JSON.parse(seen.bodies[0]!).state).toEqual({ question: 'Is it done?', context: 'All tests pass.' });
  const event = JSON.parse(seen.files[0]!);
  expect(event.outcome).toBe('decision');
  expect(event.kind).toBe('yesno');
  expect(event.jevTokens).toBe(77);
  expect(seen.files[0]!.includes('done')).toBe(false);
});

test('a choice decision names the option and its probabilities', async ($, on) => {
  host(on, { choice: 'B', confidence: 0.8, probabilities: { A: 0.2, B: 0.8 } });
  const out = await $.tool.call({ tool: TOOL, question: 'Which?', options: [{ name: 'a' }, { name: 'b', description: 'The second.' }] });
  expect(out.result).toBe('Jev: "b" (confidence 80%). Probabilities: b 80%, a 20%. Jev gives no reasons and saw only the question, options and context of this call.');
});
