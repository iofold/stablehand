// Chromium through the egress proxy, launched the way the browse tool does it
// (packages/sandbox-daemon/src/sandbox/browser-handler.ts): the lease goes to Playwright as proxy
// credentials, which it sends when the proxy answers 407.
// Usage: node client_browser.mjs <default-lease-proxy-url> <deny-lease-proxy-url>
import { chromium } from 'playwright';

const [defaultProxy, denyProxy] = process.argv.slice(2);

function proxySettings(proxyUrl) {
  const url = new URL(proxyUrl);
  return {
    server: `${url.protocol}//${url.host}`,
    ...(url.username
      ? { username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) }
      : {}),
  };
}

async function visit(proxy, target) {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium-browser',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    proxy,
  });
  try {
    const page = await browser.newPage();
    const response = await page.goto(target, { timeout: 20_000 });
    return `${response?.status()} ${(await page.textContent('body'))?.trim()}`;
  } catch (error) {
    return `error:${String(error.message).split('\n')[0]}`;
  } finally {
    await browser.close();
  }
}

function report(name, ok, actual) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} (${actual})`);
}

const allowed = await visit(proxySettings(defaultProxy), 'https://git.example.test:8443/x');
report('chromium: default lease answers the 407 and loads the page', allowed.startsWith('200 upstream:git.example.test'), allowed);
const denied = await visit(proxySettings(denyProxy), 'https://git.example.test:8443/x');
report('chromium: deny lease cannot load a server default', denied.startsWith('error:'), denied);
const runtime = await visit(proxySettings(denyProxy), 'https://model.example.test:8443/x');
report('chromium: deny lease loads the runtime host', runtime.startsWith('200 upstream:model.example.test'), runtime);
const noLease = await visit({ server: new URL(defaultProxy).origin }, 'https://git.example.test:8443/x');
report('chromium: no lease on the lease listener cannot load anything', noLease.startsWith('error:'), noLease);
