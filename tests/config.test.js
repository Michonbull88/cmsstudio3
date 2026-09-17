import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { runtimeConfig } from '../server/config.js';
import { isAllowedRequestOrigin } from '../server/request-origin.js';
import { createApplication } from '../server/index.js';

test('local and Codespaces runtime configuration', () => {
  assert.deepEqual(runtimeConfig({}), { port: 3000, host: '127.0.0.1', origin: 'http://localhost:3000', secureCookies: false, localProxyHosts: [] });
  const config = runtimeConfig({ CODESPACES: 'true', CODESPACE_NAME: 'studio-test-123', GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: 'app.github.dev' });
  assert.equal(config.origin, 'https://studio-test-123-3000.app.github.dev');
  assert.equal(config.secureCookies, true);
  assert.ok(config.localProxyHosts.includes('localhost:3000'));
  assert.equal(runtimeConfig({ PORT: '4000' }).origin, 'http://localhost:4000');
  assert.throws(() => runtimeConfig({ CODESPACES: 'true' }), /incomplete/);
  assert.throws(() => runtimeConfig({ NODE_ENV: 'production' }), /HTTPS/);
  assert.throws(() => runtimeConfig({ PORT: 'NaN' }), /PORT/);
});

test('Codespaces loopback proxy preserves origin and owner-setup protections', async () => {
  const origin = 'https://studio-test-3000.app.github.dev';
  const app = createApplication({ dbPath: ':memory:', origin, secureCookies: true, localProxyHosts: ['localhost:3000'] });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const call = (path, method = 'GET', headers = {}, value = {}) => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: app.server.address().port, path, method, headers: { Host: 'localhost:3000', 'Content-Type': 'application/json', 'X-Studio-Request': '1', ...headers } }, res => {
      let body = ''; res.on('data', c => body += c); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on('error', reject); req.end(method === 'GET' ? undefined : JSON.stringify(value));
  });
  try {
    assert.equal((await call('/api/health')).status, 200);
    assert.equal((await call('/api/health', 'GET', { Host: 'evil.example' })).status, 403);
    assert.equal((await call('/api/auth/login', 'POST', { Origin: 'https://evil.example' })).status, 403);
    const credentials = { name: 'Preview Owner', email: 'preview@example.com', password: 'preview-test-password' };
    assert.equal((await call('/api/auth/setup', 'POST', { Origin: origin, 'X-Forwarded-For': '203.0.113.5' }, credentials)).status, 403);
    assert.equal((await call('/api/auth/setup', 'POST', { Origin: origin }, credentials)).status, 200);
    assert.equal((await call('/api/auth/login', 'POST', { Origin: origin, 'X-Forwarded-For': '203.0.113.5' }, credentials)).status, 200);
    const rewritten = { Origin: 'http://localhost:3000', 'Sec-Fetch-Site': 'same-origin', 'X-Studio-Origin': origin, 'X-Forwarded-For': '203.0.113.5' };
    assert.equal((await call('/api/auth/login', 'POST', rewritten, credentials)).status, 200);
    assert.equal((await call('/api/auth/login', 'POST', { ...rewritten, Origin: 'https://localhost' }, credentials)).status, 200);
    assert.equal((await call('/api/auth/login', 'POST', { ...rewritten, 'Sec-Fetch-Site': 'cross-site' }, credentials)).status, 403);
    assert.equal((await call('/api/auth/login', 'POST', { ...rewritten, 'X-Studio-Origin': 'https://other.app.github.dev' }, credentials)).status, 403);

  } finally { await new Promise(resolve => app.server.close(resolve)); }
});

// Regression: the forwarding layer changes Origin to its internal address,
// even though the browser is making a same-origin request to the preview URL.
test('forwarded origin validation is limited to the configured Codespace', () => {
  const expected = 'https://studio-preview-example-3000.app.github.dev';
  const hosts = ['localhost:3000', '127.0.0.1:3000', '[::1]:3000'];
  const req = { socket: { remoteAddress: '127.0.0.1' }, headers: { origin: 'http://localhost:3000', 'sec-fetch-site': 'same-origin', 'x-studio-origin': expected } };
  for (const origin of ['http://localhost:3000', 'https://localhost:3000', 'http://localhost', 'https://localhost', 'http://127.0.0.1:3000', 'http://[::1]:3000']) {
    assert.equal(isAllowedRequestOrigin({ ...req, headers: { ...req.headers, origin } }, expected, hosts), true, origin);
  }
  for (const origin of ['https://evil.example', 'https://other-3000.app.github.dev', 'http://localhost:9999', 'null', 'http://localhost:3000/path', 'http://user@localhost:3000']) {
    assert.equal(isAllowedRequestOrigin({ ...req, headers: { ...req.headers, origin } }, expected, hosts), false, origin);
  }
  assert.equal(isAllowedRequestOrigin(req, expected, []), false, 'No proxy exceptions outside Codespaces');
  assert.equal(isAllowedRequestOrigin({ ...req, socket: { remoteAddress: '203.0.113.5' } }, expected, hosts), false);
  for (const metadata of [undefined, 'cross-site', 'same-site', 'none']) {
    assert.equal(isAllowedRequestOrigin({ ...req, headers: { ...req.headers, 'sec-fetch-site': metadata } }, expected, hosts), false);
  }
  assert.equal(isAllowedRequestOrigin({ ...req, headers: { ...req.headers, 'x-studio-origin': 'https://other-3000.app.github.dev' } }, expected, hosts), false);
});
