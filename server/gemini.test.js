const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createGeminiClient, DEFAULT_MODEL } = require('./gemini');
const { RECOMMENDATION_RESPONSE_SCHEMA: schema } = require('./ai-recommendations');

const plan = { contractVersion: 2, goal: 'general', actions: [] };
const reply = (text = JSON.stringify(plan), finishReason = 'STOP') => Response.json({
  candidates: [{ finishReason, content: { parts: [{ text }] } }],
});

test('Gemini transport sends compact evidence and structured schema with credentials confined to a header', async () => {
  // Random synthetic transport token; no actual credentials are loaded by tests.
  const token = randomUUID();
  const input = { contractVersion: 1, goal: 'general', skills: [] };
  const signal = new AbortController().signal;
  for (const model of [DEFAULT_MODEL, 'synthetic-model']) {
    let calls = 0;
    const client = createGeminiClient({ getApiKey: () => token, getModel: () => model,
      request: async (url, options) => {
        calls++;
        assert.equal(url, `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`);
        assert.ok(!url.includes(token));
        assert.equal(options.headers['x-goog-api-key'], token);
        assert.equal(options.method, 'POST');
        assert.equal(options.signal, signal);
        assert.ok(!options.body.includes(token));
        const body = JSON.parse(options.body);
        assert.deepEqual(JSON.parse(body.contents[0].parts[0].text), input);
        assert.equal(body.generationConfig.responseFormat.text.mimeType, 'APPLICATION_JSON');
        assert.deepEqual(body.generationConfig.responseFormat.text.schema.properties, schema.properties);
        assert.equal(body.tools, undefined);
        return reply();
      } });
    assert.equal(client.isConfigured(), true);
    assert.deepEqual(await client.generate({ input, schema, signal }), plan);
    assert.equal(calls, 1);
  }
});

test('missing configuration makes no request; HTTP failures and blocked, truncated or malformed replies are rejected', async () => {
  let calls = 0;
  const missing = createGeminiClient({ getApiKey: () => '', request: async () => { calls++; } });
  assert.equal(missing.isConfigured(), false);
  await assert.rejects(missing.generate({ input: {}, schema }), /configuration/);
  assert.equal(calls, 0);
  const responses = [new Response('Do not expose this upstream body', { status: 403 }),
    reply('not JSON'), reply('{}', 'MAX_TOKENS'), Response.json({ promptFeedback: { blockReason: 'SAFETY' } }),
    Response.json({ candidates: [] }), Response.json({ candidates: [{ finishReason: 'STOP', content: {} }] }),
  ];
  for (const response of responses) {
    const client = createGeminiClient({ getApiKey: () => randomUUID(), request: async () => response });
    await assert.rejects(client.generate({ input: {}, schema }));
  }
});
