import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readConfig } from '../src/check.mjs';
import { main } from '../src/index.mjs';

const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
const section = readme.split('## Opt in to daily checks, even without a deployment\n')[1]?.split('\n## Inputs')[0];
assert.ok(section, 'README must contain the opt-in scheduled example');
const workflow = section.match(/```yaml\n([\s\S]*?)\n```/)?.[1];
assert.ok(workflow, 'scheduled section must contain a YAML workflow');

// Source-contract checks keep the documented hierarchy/wiring testable with
// Node alone, like the Action itself. These do not execute GitHub's scheduler.
test('documented schedule and manual trigger are independent of deployment', () => {
  assert.match(workflow, /^on:\n  schedule:\n    - cron: '17 8 \* \* \*'\n  workflow_dispatch:\npermissions:\n  contents: read\njobs:\n/m);
  assert.match(workflow, /^  scheduled-check:\n    name: Check \$\{\{ matrix\.url \}\}\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    strategy:\n      fail-fast: false\n      matrix:\n        url:\n(?:          - https:\/\/\S+\n)+    steps:\n/m);
  assert.doesNotMatch(workflow, /\b(needs|continue-on-error|secrets|env):|GITHUB_TOKEN|\/api\//);
});

const urls = [...workflow.matchAll(/^          - (https:\/\/\S+)$/gm)].map((match) => match[1]);
const withBlock = workflow.match(/^        with:\n((?:          .+\n?)+)/m)?.[1];
assert.ok(withBlock, 'scheduled Action must have inputs');
assert.match(withBlock, /^          url: \$\{\{ matrix\.url \}\}$/m);
const inputs = Object.fromEntries([...withBlock.matchAll(/^          ([a-z-]+): '([^']+)'$/gm)]
  .map((match) => [match[1], match[2]]));
const envFor = (url) => Object.fromEntries(Object.entries({ ...inputs, url })
  .map(([name, value]) => [`INPUT_${name.toUpperCase()}`, value]));

test('every matrix site reaches the existing keyless Action with valid inputs', () => {
  assert.equal(urls.length, 2);
  assert.match(workflow, /^      - name: Check public site\n        id: orioncmd\n        uses: dario933\/orioncmd-check@v1\n        with:/m);
  assert.deepEqual(inputs, {
    'minimum-days': '21', 'expected-status': '200-299', attempts: '3',
    'retry-delay-seconds': '5', 'timeout-seconds': '10', 'fail-on-error': 'true',
  });
  for (const url of urls) {
    const config = readConfig({ ...inputs, url });
    assert.equal(config.url, new URL(url).href);
    assert.equal(config.minimumDays, 21);
    assert.equal(config.failOnError, true);
    assert.equal(config.attempts, 3);
    assert.equal(config.timeoutMs, 10_000);
  }
});

test('scheduled inputs produce failed steps at later expiry without a deployment', async (t) => {
  t.mock.method(console, 'log', () => {});
  const day = 86_400_000;
  const initialTime = Date.parse('2026-10-10T08:17:00Z');
  const validTo = new Date(initialTime + 22 * day).toISOString();
  // Same deployed certificate, observed on successive days. No deploy or API
  // dependency is supplied; only the observation clock changes.
  for (const url of urls) {
    for (const [elapsedDays, expectedExit] of [[0, 0], [1, 1], [23, 1]]) {
      const code = await main(envFor(url), {
        now: () => initialTime + elapsedDays * day,
        fetchHop: async (observedUrl) => {
          assert.equal(observedUrl, new URL(url).href);
          return {
            status: 200,
            certificate: {
              hostname: new URL(url).hostname,
              validFrom: new Date(initialTime - day).toISOString(), validTo,
            },
          };
        },
      });
      assert.equal(code, expectedExit);
    }
  }
});

test('documentation explains opt-in, notification routing, and schedule/usage limits', () => {
  for (const required of [
    /Post-deploy-only checks cannot detect later certificate expiry if no new\s+deployment happens/,
    /default branch/, /08:17 UTC/, /Only notify for failed workflows/,
    /not enabled automatically/, /most recently changed its cron/,
    /60 days without repository activity/, /may be dropped/,
    /private repositories consume the repository owner's included/,
    /60 jobs per 30-day month/, /not a guaranteed, always-on monitoring/,
  ]) assert.match(section, required);
});
