import type { On, SessionMessage } from 'claude-code';
import { expect, mock, test } from 'claude-code/testing';

function transcript(): SessionMessage[] {
  const messages: SessionMessage[] = [{ role: 'user', text: 'Continue the task.', toolUses: [] }];
  for (let i = 0; i < 5; i += 1) {
    messages.push({
      role: 'assistant', text: '',
      toolUses: [{ tool_use_id: `call-${i}`, tool: 'Read', input: { file_path: 'x.ts' } }],
    }, {
      role: 'user', text: '', toolUses: [],
      toolResults: [{ tool_use_id: `call-${i}`, text: 'x'.repeat(2000), isError: false }],
    });
  }
  return messages;
}

function host(on: On, noul: number) {
  mock.clock(on);
  mock.env(on, { TYPESAFE_API_KEY: 'test-key', HOME: '/home/me' });
  const seen = { files: [] as Array<{ path: string; text: string }>, status: [] as Array<string | undefined>, summaries: 0 };
  on('ui.log', () => ({ value: undefined }));
  on('ui.toast', () => ({ value: undefined }));
  on('ui.status', (_$, event) => {
    seen.status.push(event.text);
    return { value: undefined };
  });
  on('fs.write', (_$, event) => {
    seen.files.push({ path: event.path, text: event.text });
    return { value: undefined };
  });
  on('session.id', () => ({ value: 'session-1' }));
  on('session.cwd', () => ({ value: '/work/acme/api' }));
  on('settings.read', () => ({ value: {} }));
  on('http.fetch', (_$, event) => {
    const { questions } = JSON.parse(event.init?.body ?? '{}');
    return { value: {
      status: 200, ok: true, headers: {},
      text: JSON.stringify({
        answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { type: 'noul', noul }])),
        usage: { input_tokens: 4321 },
      }),
    } };
  });
  on('session.compact', () => {
    seen.summaries += 1;
    return { messages: [{ role: 'user', text: 'built-in summary', toolUses: [] }] };
  });
  return seen;
}

test('an installed compaction is written to the ledger and shown on the status line', async ($, on) => {
  const seen = host(on, 0);
  const result = await $.session.compact({ trigger: 'manual', messages: transcript() });
  expect(result.skip).toBeUndefined();
  expect(seen.summaries).toBe(0);
  expect(seen.files.length).toBe(1);
  expect(seen.files[0]!.path.startsWith('/home/me/.fast-jev/events/')).toBe(true);
  const event = JSON.parse(seen.files[0]!.text);
  expect(event.outcome).toBe('compacted');
  expect(event.session).toBe('session-1');
  expect(event.project).toBe('api');
  expect(event.jevTokens).toBe(4321);
  expect(event.tokensFreed).toBe(Math.round((event.charsBefore - event.charsAfter) / 4));
  expect(event.tokensFreed > 0).toBe(true);
  expect(seen.files[0]!.text.includes('xxxxxxxxxx')).toBe(false);
  expect(seen.status.at(-1)).toBe(
    `Jev ● armed · compacts at 60% · freed ~${event.tokensFreed >= 1000 ? `${Math.round(event.tokensFreed / 1000)}k` : event.tokensFreed} tokens in 1 run`,
  );
});

test('a /compact Jev cannot shrink is recorded as a skip that freed nothing', async ($, on) => {
  const seen = host(on, 1);
  const result = await $.session.compact({ trigger: 'manual', messages: transcript() });
  expect(typeof result.skip).toBe('string');
  expect(seen.files.length).toBe(1);
  const event = JSON.parse(seen.files[0]!.text);
  expect(event.outcome).toBe('skipped');
  expect(event.tokensFreed).toBe(0);
  expect(event.charsAfter).toBe(event.charsBefore);
});
