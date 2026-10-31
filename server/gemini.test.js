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
  const allowedActions = [{ kind: 'train_skill', reasons: ['recorded_progress'], focusFactIds: ['skill:mining'] }];
  const signal = new AbortController().signal;
  for (const model of [DEFAULT_MODEL, 'gemini-3.6-flash', 'gemini-2.5-flash', 'synthetic-model']) {
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
        assert.deepEqual(body.contents[0].parts[1], { text: JSON.stringify({ allowedActions }) });
        assert.equal(body.generationConfig.responseFormat.text.mimeType, 'APPLICATION_JSON');
        assert.equal(body.generationConfig.candidateCount, undefined, 'Gemini 3 does not support candidateCount');
        assert.deepEqual(body.generationConfig.thinkingConfig,
          model.startsWith('gemini-3') ? { thinkingLevel: 'LOW' } : undefined);
        assert.deepEqual(body.generationConfig.responseFormat.text.schema.properties, schema.properties);
        assert.equal(body.tools, undefined);
        return reply();
      } });
    assert.equal(client.isConfigured(), true);
    assert.deepEqual(await client.generate({ input, schema, allowedActions, signal }), plan);
    assert.equal(calls, 1);
  }
});

test('temporary Gemini errors retry with bounded backoff and can recover', async () => {
  let calls = 0;
  const waits = [];
  const signal = new AbortController().signal;
  const client = createGeminiClient({ getApiKey: () => randomUUID(),
    wait: async (ms, passedSignal) => { waits.push(ms); assert.equal(passedSignal, signal); },
    request: async () => ++calls < 3 ? new Response(null, { status: 503 }) : reply(),
  });
  assert.deepEqual(await client.generate({ input: {}, schema, signal }), plan);
  assert.equal(calls, 3);
  assert.ok(waits[0] >= 500 && waits[0] < 750);
  assert.ok(waits[1] >= 1000 && waits[1] < 1250);
});

test('a server-authored duplicate correction reaches the model alongside the same saved input', async () => {
  const input = { contractVersion: 1, goal: 'combat', skills: [] };
  const allowedActions = [{ kind: 'train_skill', reasons: ['recorded_progress'], focusFactIds: ['skill:combat'] }];
  const correction = 'Return each training focus only once.';
  const client = createGeminiClient({ getApiKey: () => randomUUID(), request: async (url, options) => {
    const body = JSON.parse(options.body);
    assert.deepEqual(body.contents[0].parts, [{ text: JSON.stringify(input) },
      { text: JSON.stringify({ allowedActions }) }, { text: correction }]);
    return reply();
  } });
  await client.generate({ input, schema, allowedActions, correction });
});

test('persistent server errors stop after three attempts and expose only safe status metadata', async () => {
  let calls = 0, waits = 0;
  const privateDetail = randomUUID();
  const client = createGeminiClient({ getApiKey: () => randomUUID(), wait: async () => { waits++; },
    request: async () => { calls++; return new Response(privateDetail, { status: 503 }); },
  });
  await assert.rejects(client.generate({ input: {}, schema }), error => {
    assert.equal(error.code, 'GEMINI_UNAVAILABLE');
    assert.equal(error.httpStatus, 503);
    assert.ok(!JSON.stringify(error).includes(privateDetail));
    assert.ok(!error.message.includes(privateDetail));
    return true;
  });
  assert.equal(calls, 3);
  assert.equal(waits, 2);
});

test('access, quota, model and request errors do not retry', async () => {
  for (const [status, code] of [[400, 'GEMINI_REQUEST'], [401, 'GEMINI_ACCESS'], [403, 'GEMINI_ACCESS'],
    [404, 'GEMINI_MODEL'], [429, 'GEMINI_QUOTA']]) {
    let calls = 0;
    const client = createGeminiClient({ getApiKey: () => randomUUID(),
      wait: async () => assert.fail('Permanent errors must not back off'),
      request: async () => { calls++; return new Response(null, { status }); },
    });
    await assert.rejects(client.generate({ input: {}, schema }), { code, httpStatus: status });
    assert.equal(calls, 1);
  }
});

test('abort during backoff prevents another request; Retry-After is respected within the deadline', async () => {
  let calls = 0;
  const controller = new AbortController();
  const client = createGeminiClient({ getApiKey: () => randomUUID(),
    request: async () => { calls++; return new Response(null, { status: 503, headers: { 'Retry-After': '2' } }); },
    wait: async ms => { assert.equal(ms, 2000); controller.abort(); },
  });
  await assert.rejects(client.generate({ input: {}, schema, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 1);
  const longWait = createGeminiClient({ getApiKey: () => randomUUID(),
    request: async () => new Response(null, { status: 503, headers: { 'Retry-After': '60' } }),
    wait: async () => assert.fail('Do not wait beyond the recommendation deadline'),
  });
  await assert.rejects(longWait.generate({ input: {}, schema }), { code: 'GEMINI_UNAVAILABLE' });
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
