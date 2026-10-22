import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { GATEWAY_BUDGET_REFUSAL_MESSAGE } from '../../model-gateway-relay.js';

/** The SDK error text a harness sees after the relay rewrote a budget refusal. */
export const RELAYED_BUDGET_ERROR_TEXT = `400 ${JSON.stringify({
  type: 'error',
  error: { type: 'budget_exceeded', code: 'budget_exceeded', param: null, message: GATEWAY_BUDGET_REFUSAL_MESSAGE },
})}`;

/**
 * Run a real loopback relay in front of a fake gateway that refuses for
 * budget, and drive one call for `turnId` through it, so the relay holds the
 * refusal exactly as it would after a harness client hit the cap.
 *
 * The relay modules are imported at call time so a test that reset the
 * module registry registers the relay the freshly imported harness reads.
 */
export async function recordRelayBudgetRefusal(
  turnId: string,
  amounts: { spentUsd: number; capUsd: number } = { spentUsd: 0.0512, capUsd: 0.05 },
): Promise<{ cleanup: () => Promise<void> }> {
  const gateway: Server = createServer((_req, res) => {
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        message: `Budget has been exceeded! Key=stablehand-session-test (sk-...test) Current cost: ${amounts.spentUsd}, Max budget: ${amounts.capUsd}`,
        type: 'budget_exceeded',
        param: null,
        code: '429',
      },
    }));
  });
  await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  const { ModelGatewayRelay, registerModelGatewayRelay } = await import('../../model-gateway-relay.js');
  const { createGatewayCorrelationHeaders } = await import('../../model-gateway.js');
  const relay = new ModelGatewayRelay({
    upstreamUrl: `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });
  const relayUrl = await relay.start();
  registerModelGatewayRelay(relay);
  const response = await fetch(`${relayUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...createGatewayCorrelationHeaders(turnId) },
    body: '{}',
  });
  await response.text();
  return {
    cleanup: async () => {
      registerModelGatewayRelay(undefined);
      await relay.stop();
      gateway.closeAllConnections();
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
    },
  };
}
