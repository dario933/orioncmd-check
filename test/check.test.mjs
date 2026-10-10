import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer, request as httpsRequest } from 'node:https';
import { CheckError, fetchHop, isPublicAddress, readConfig, runCheck, validateUrl } from '../src/check.mjs';
import { main, renderSummary } from '../src/index.mjs';

const NOW = Date.parse('2026-10-10T12:00:00Z');
const DAY = 86_400_000;
const publicLookup = async () => [{ address: '93.184.215.14', family: 4 }];
const config = (overrides = {}) => readConfig({ url: 'https://example.com', 'retry-delay-seconds': '0', ...overrides });
const hop = (overrides = {}) => ({
  status: 200,
  certificate: {
    hostname: 'example.com',
    validFrom: new Date(NOW - DAY).toISOString(),
    validTo: new Date(NOW + 60 * DAY).toISOString(),
  },
  ...overrides,
});
const run = (settings = {}, dependencies = {}) =>
  runCheck(config(settings), { now: () => NOW, fetchHop: async () => hop(), ...dependencies });

test('safe defaults and accepted status ranges', () => {
  const settings = config({ 'expected-status': '200-299,304' });
  assert.equal(settings.minimumDays, 21);
  assert.equal(settings.attempts, 3);
  assert.equal(settings.timeoutMs, 10_000);
  assert.equal(settings.failOnError, true);
  assert.deepEqual(settings.expectedRanges, [[200, 299], [304, 304]]);
});

for (const [input, value] of [
  ['minimum-days', '-1'], ['minimum-days', '21.5'], ['minimum-days', '3651'],
  ['attempts', '0'], ['attempts', '6'], ['timeout-seconds', '31'],
  ['retry-delay-seconds', '31'], ['fail-on-error', 'yes'],
  ['expected-status', 'abc'], ['expected-status', '299-200'],
]) {
  test(`rejects invalid ${input}=${value}`, () => {
    assert.throws(() => config({ [input]: value }), CheckError);
  });
}

for (const url of [
  'http://example.com', 'https://example.com:8443', 'https://user:password@example.com',
  'https://localhost', 'https://app.localhost.', 'https://server.local',
  'https://127.0.0.1', 'https://169.254.169.254', 'https://10.0.0.1',
  'https://[::1]', 'https://[::ffff:127.0.0.1]', 'https://192.0.2.1',
]) {
  test(`rejects unsafe URL ${url}`, () => assert.throws(() => validateUrl(url), CheckError));
}

test('address guards cover IPv4 and IPv6 special-use space', () => {
  for (const address of [
    '0.0.0.0', '100.64.0.1', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '192.0.0.1', '192.88.99.1', '198.18.0.1',
    '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255',
    'fe80::1', 'fc00::1', 'ff02::1', '2001:db8::1', '2001::1',
    '2002:0808:0808::1', '3fff::1', 'not-an-ip',
  ]) assert.equal(isPublicAddress(address), false, address);
  for (const address of ['1.1.1.1', '8.8.8.8', '93.184.215.14', '2606:4700::1111', '2001:4860:4860::8888']) {
    assert.equal(isPublicAddress(address), true, address);
  }
});

test('a valid response reports HTTP and certificate observations', async () => {
  const result = await run();
  assert.equal(result.status, 'passed');
  assert.equal(result.httpStatus, 200);
  assert.equal(result.daysRemaining, 60);
  assert.equal(result.attemptsUsed, 1);
});

test('threshold is inclusive and exact, not rounded-down days', async () => {
  const certificateAt = (remaining) => hop({
    certificate: { ...hop().certificate, validTo: new Date(NOW + remaining).toISOString() },
  });
  const exact = await run({}, { fetchHop: async () => certificateAt(21 * DAY) });
  assert.equal(exact.status, 'failed');
  assert.equal(exact.attemptsUsed, 1);
  const slightlyAbove = await run({}, { fetchHop: async () => certificateAt(21 * DAY + 1000) });
  assert.equal(slightlyAbove.status, 'passed');
  assert.equal(slightlyAbove.daysRemaining, 21);
});

test('expired, future, and invalid certificate dates never pass', async () => {
  for (const certificate of [
    { ...hop().certificate, validTo: new Date(NOW - 1).toISOString() },
    { ...hop().certificate, validFrom: new Date(NOW + DAY).toISOString() },
    { ...hop().certificate, validTo: 'not-a-date' },
  ]) {
    const result = await run({ 'minimum-days': '0' }, { fetchHop: async () => hop({ certificate }) });
    assert.equal(result.status, 'failed');
    assert.equal(result.attemptsUsed, 1);
  }
});

test('redirects check each certificate and report the earliest expiry', async () => {
  const urls = [];
  const result = await run({}, {
    fetchHop: async (url) => {
      urls.push(url);
      return urls.length === 1 ? hop({ status: 302, location: 'https://www.example.com/ready' })
        : hop({ certificate: {
          ...hop().certificate, hostname: 'www.example.com',
          validTo: new Date(NOW + 40 * DAY).toISOString(),
        } });
    },
  });
  assert.equal(result.status, 'passed');
  assert.equal(result.daysRemaining, 40);
  assert.equal(result.certificates.length, 2);
  assert.equal(urls[1], 'https://www.example.com/ready');
});

test('an expiring initial certificate fails even if a redirect leads elsewhere', async () => {
  let requests = 0;
  const result = await run({}, { fetchHop: async () => {
    requests++;
    return hop({ status: 302, location: 'https://www.example.com', certificate: {
      ...hop().certificate, validTo: new Date(NOW + DAY).toISOString(),
    } });
  } });
  assert.equal(result.status, 'failed');
  assert.equal(requests, 1);
});

for (const location of ['http://example.com', 'https://127.0.0.1', 'https://user:secret@example.com']) {
  test(`refuses unsafe redirects to ${location}`, async () => {
    let requests = 0;
    const result = await run({}, { fetchHop: async () => {
      requests++;
      return hop({ status: 302, location });
    } });
    assert.equal(result.status, 'failed');
    assert.equal(requests, 1);
  });
}

test('limits redirect loops and refuses missing Location', async () => {
  let requests = 0;
  const loop = await run({}, { fetchHop: async () => {
    requests++;
    return hop({ status: 302, location: '/loop' });
  } });
  assert.equal(loop.status, 'failed');
  assert.equal(requests, 6);
  const missing = await run({}, { fetchHop: async () => hop({ status: 301 }) });
  assert.equal(missing.status, 'failed');
});

test('retries temporary HTTP errors, retaining only final-attempt evidence', async () => {
  let requests = 0;
  const recovered = await run({}, { fetchHop: async () => hop({ status: ++requests === 1 ? 503 : 204 }) });
  assert.equal(recovered.status, 'passed');
  assert.equal(recovered.httpStatus, 204);
  assert.equal(recovered.attemptsUsed, 2);
  const exhausted = await run({}, { fetchHop: async () => hop({ status: 500 }) });
  assert.equal(exhausted.status, 'failed');
  assert.equal(exhausted.attemptsUsed, 3);
});

test('network failures are explicit and bounded', async () => {
  const result = await run({ attempts: '2' }, { fetchHop: async () => {
    throw new CheckError('Connection unavailable.', true);
  } });
  assert.equal(result.status, 'failed');
  assert.equal(result.httpStatus, null);
  assert.equal(result.daysRemaining, null);
  assert.equal(result.attemptsUsed, 2);
});

test('the overall deadline aborts a pending check', async () => {
  const result = await run({}, {
    deadlineMs: 15,
    fetchHop: async (_url, { signal }) => {
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error()), { once: true }));
    },
  });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /overall/);
  assert.equal(result.attemptsUsed, 1);
});

test('rejects mixed public/private DNS before making a request', async () => {
  let sent = false;
  await assert.rejects(fetchHop('https://example.com', {
    signal: new AbortController().signal, timeoutMs: 1000,
  }, {
    lookup: async () => [
      { address: '93.184.215.14', family: 4 }, { address: '10.0.0.1', family: 4 },
    ],
    request: () => { sent = true; },
  }), /private/);
  assert.equal(sent, false);
});

test('pins validated DNS and keeps TLS verification enabled', async () => {
  let options;
  const response = Object.assign(new EventEmitter(), {
    statusCode: 200, headers: {},
    socket: { authorized: true, getPeerCertificate: () => ({ valid_from: 'Oct 1 2026 GMT', valid_to: 'Dec 1 2026 GMT' }) },
    destroy() { this.destroyed = true; },
  });
  const result = await fetchHop('https://example.com/?secret=not-logged', {
    signal: new AbortController().signal, timeoutMs: 1000,
  }, {
    lookup: publicLookup,
    request: (_url, opts, callback) => {
      options = opts;
      const req = new EventEmitter();
      req.end = () => callback(response);
      return req;
    },
  });
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.agent, false);
  await new Promise((resolve) => options.lookup('example.com', {}, (error, address, family) => {
    assert.equal(error, null);
    assert.equal(address, '93.184.215.14');
    assert.equal(family, 4);
    resolve();
  }));
  assert.equal(response.destroyed, true);
  assert.equal(result.status, 200);
  assert.equal(JSON.stringify(result).includes('not-logged'), false);
});

test('DNS lookup is included in the per-request timeout', async () => {
  await assert.rejects(fetchHop('https://example.com', {
    signal: new AbortController().signal, timeoutMs: 15,
  }, { lookup: () => new Promise(() => {}) }), /deadline/);
});

let fixtureDir;
let server;
let fixtureCa;
let port;
before(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), 'orioncmd-action-tls-'));
  const keyFile = join(fixtureDir, 'key.pem');
  const certFile = join(fixtureDir, 'cert.pem');
  const generated = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '60',
    '-keyout', keyFile, '-out', certFile, '-subj', '/CN=example.com',
    '-addext', 'subjectAltName=DNS:example.com',
  ], { stdio: 'pipe' });
  assert.equal(generated.status, 0, 'OpenSSL must generate the temporary local TLS fixture');
  fixtureCa = await readFile(certFile);
  server = createServer({ key: await readFile(keyFile), cert: fixtureCa }, (_request, response) => {
    response.writeHead(204);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});
after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
});

function localTransport({ trusted = true, servername = 'example.com' } = {}) {
  // Test transport redirects the socket to a local fixture. Production code has
  // no env flag or option to bypass public-address checks or TLS validation.
  return {
    lookup: publicLookup,
    request: (_url, options, callback) => httpsRequest({
      ...options, hostname: '127.0.0.1', port, path: '/', servername,
      ...(trusted ? { ca: fixtureCa } : {}),
    }, callback),
  };
}

test('real HTTPS transport observes a trusted certificate and HTTP response', async () => {
  const result = await fetchHop('https://example.com', {
    signal: new AbortController().signal, timeoutMs: 1000,
  }, localTransport());
  assert.equal(result.status, 204);
  assert.ok(result.certificate.validTo);
});

test('real HTTPS transport refuses a wrong certificate hostname', async () => {
  await assert.rejects(fetchHop('https://example.com', {
    signal: new AbortController().signal, timeoutMs: 1000,
  }, localTransport({ servername: 'wrong.example.com' })), /certificate validation failed/);
});

test('real HTTPS transport refuses an untrusted self-signed certificate', async () => {
  await assert.rejects(fetchHop('https://example.com', {
    signal: new AbortController().signal, timeoutMs: 1000,
  }, localTransport({ trusted: false })), /certificate validation failed/);
});

test('GitHub outputs and summaries are accurate, including warning-only mode', async (t) => {
  const annotations = [];
  t.mock.method(console, 'log', (line) => annotations.push(line));
  const dir = await mkdtemp(join(tmpdir(), 'orioncmd-action-output-'));
  try {
    for (const warningOnly of [false, true]) {
      const output = join(dir, `output-${warningOnly}`);
      const summary = join(dir, `summary-${warningOnly}`);
      const code = await main({
        INPUT_URL: 'https://example.com/?token=never-log-this',
        'INPUT_RETRY-DELAY-SECONDS': '0',
        'INPUT_FAIL-ON-ERROR': warningOnly ? 'false' : 'true',
        GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary,
      }, { now: () => NOW, fetchHop: async () => hop({ status: 503 }) });
      assert.equal(code, warningOnly ? 0 : 1);
      const outputs = await readFile(output, 'utf8');
      const writtenSummary = await readFile(summary, 'utf8');
      assert.match(outputs, /^status=failed$/m);
      assert.match(outputs, /^attempts-used=3$/m);
      assert.match(writtenSummary, /Result: Failed/);
      assert.equal(outputs.includes('never-log-this'), false);
      assert.equal(writtenSummary.includes('never-log-this'), false);
      const parsed = JSON.parse(outputs.split('\n').find((line) => line.startsWith('report=')).slice(7));
      assert.equal(parsed.status, 'failed');
      assert.equal(parsed.httpStatus, 503);
    }
    const invalid = await main({ INPUT_URL: 'http://example.com', 'INPUT_FAIL-ON-ERROR': 'false' });
    assert.equal(invalid, 1);
    assert.ok(annotations.some((line) => line.startsWith('::error')));
    assert.ok(annotations.some((line) => line.startsWith('::warning')));
    assert.equal(annotations.some((line) => line.includes('never-log-this')), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('summary escapes untrusted HTML, pipes, and line breaks', () => {
  const summary = renderSummary({
    status: 'failed', httpStatus: null, attemptsUsed: 1,
    error: '<script>evil</script>\n| injected',
    certificates: [],
  });
  assert.equal(summary.includes('<script>'), false);
  assert.equal(summary.includes('\n| injected'), false);
  assert.match(summary, /&lt;script&gt;/);
  assert.match(summary, /&#124;/);
});

test('Action metadata points at the entrypoint and declares the implemented inputs', async () => {
  const manifest = await readFile(new URL('../action.yml', import.meta.url), 'utf8');
  assert.match(manifest, /using: node24/);
  assert.match(manifest, /main: src\/index\.mjs/);
  for (const name of ['url', 'minimum-days', 'expected-status', 'attempts', 'fail-on-error', 'report']) {
    assert.match(manifest, new RegExp(`^  ${name}:`, 'm'));
  }
});
