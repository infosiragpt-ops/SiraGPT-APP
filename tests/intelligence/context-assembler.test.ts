import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createDefaultContextAssembler } from '../../server/intelligence/core/context-assembler';
import type { ChatMessage } from '../../server/intelligence/ports/common';

const assembler = createDefaultContextAssembler();

function userMsg(content: string): ChatMessage {
  return { role: 'user', content };
}
function asstMsg(content: string): ChatMessage {
  return { role: 'assistant', content };
}

describe('intelligence/context-assembler', () => {
  it('keeps a small conversation verbatim and appends the current turn', async () => {
    const history = [userMsg('hi'), asstMsg('hello'), userMsg('how are you')];
    const r = await assembler.assemble({
      history,
      currentTurn: userMsg('what is 2+2?'),
      options: { maxContextTokens: 4000, reserveOutputTokens: 500 },
    });
    assert.equal(r.truncated, false);
    assert.equal(r.summarized, false);
    assert.equal(r.summary, undefined);
    assert.equal(r.messages[r.messages.length - 1].content, 'what is 2+2?');
    assert.equal(r.messages.length, history.length + 1);
  });

  it('de-duplicates repeated turns', async () => {
    const history = [userMsg('repeat'), userMsg('repeat'), asstMsg('ok'), userMsg('repeat')];
    const r = await assembler.assemble({
      history,
      currentTurn: userMsg('next'),
      options: { maxContextTokens: 4000, reserveOutputTokens: 500 },
    });
    assert.ok(r.dedupedMessages >= 1);
  });

  it('compacts overflow into a rolling summary and stays within budget', async () => {
    const big = (n: number) => userMsg(`message-${n} ` + 'lorem ipsum dolor sit amet '.repeat(40));
    const history: ChatMessage[] = [];
    for (let i = 0; i < 30; i += 1) history.push(big(i));
    const r = await assembler.assemble({
      history,
      currentTurn: userMsg('final question'),
      options: { maxContextTokens: 1500, reserveOutputTokens: 300, minRecentMessages: 2 },
    });
    assert.equal(r.summarized, true);
    assert.ok(r.summary && r.summary.length > 0);
    assert.ok(r.droppedMessages > 0);
    assert.ok(r.truncated);
    assert.ok(r.estimatedTokens <= 1500);
  });

  it('guarantees the most-recent turns are retained', async () => {
    const history: ChatMessage[] = [];
    for (let i = 0; i < 20; i += 1) history.push(userMsg(`turn-${i} ` + 'x'.repeat(200)));
    const r = await assembler.assemble({
      history,
      currentTurn: userMsg('latest'),
      options: { maxContextTokens: 800, reserveOutputTokens: 200, minRecentMessages: 3 },
    });
    const texts = r.messages.map((m) => m.content).join('\n');
    assert.ok(texts.includes('turn-19'));
  });

  it('uses an injected summarizer and falls back when it throws', async () => {
    const history: ChatMessage[] = [];
    for (let i = 0; i < 12; i += 1) history.push(userMsg(`m${i} ` + 'data '.repeat(50)));

    const ok = await assembler.assemble({
      history,
      currentTurn: userMsg('q'),
      options: {
        maxContextTokens: 600,
        reserveOutputTokens: 150,
        summarize: async () => 'INJECTED SUMMARY',
      },
    });
    assert.equal(ok.summary, 'INJECTED SUMMARY');

    const fallback = await assembler.assemble({
      history,
      currentTurn: userMsg('q'),
      options: {
        maxContextTokens: 600,
        reserveOutputTokens: 150,
        summarize: async () => {
          throw new Error('summarizer down');
        },
      },
    });
    assert.ok(fallback.summary && fallback.summary.length > 0);
  });
});
