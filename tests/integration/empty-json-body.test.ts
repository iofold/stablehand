import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, type TestAppHandle } from '../utils/test-app.js';

// Many HTTP clients send Content-Type: application/json on every request, even a
// DELETE with no body. The API must treat that as "no body", not answer 400.
describe('empty JSON bodies', () => {
  let testApp: TestAppHandle | undefined;
  let app: TestAppHandle['app'];

  beforeAll(async () => {
    testApp = await createTestApp({ dirPrefix: 'stablehand-empty-json-body-' });
    app = testApp.app;
  });

  afterAll(async () => {
    await testApp?.close();
  });

  it('accepts a DELETE with a JSON content type and no body', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/agents',
      payload: {
        name: 'empty-body-delete',
        harness: 'langgraph',
        harnessConfig: { model: 'gpt-5.4-mini' },
        systemPrompt: 'test',
        tools: [],
      },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/agents/${id}`,
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(204);
  });

  it('still rejects malformed JSON', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents',
      headers: { 'content-type': 'application/json' },
      payload: '{"name": ',
    });
    expect(res.statusCode).toBe(400);
  });

  it('still rejects prototype poisoning', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agents',
      headers: { 'content-type': 'application/json' },
      payload: '{"name":"x","__proto__":{"polluted":true}}',
    });
    expect(res.statusCode).toBe(400);
  });
});
