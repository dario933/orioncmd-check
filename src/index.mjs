import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { readConfig, runCheck } from './check.mjs';

const INPUT_NAMES = [
  'url', 'minimum-days', 'expected-status', 'attempts',
  'retry-delay-seconds', 'timeout-seconds', 'fail-on-error',
];

function escapeAnnotation(value) {
  return String(value).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

function escapeSummary(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('|', '&#124;')
    .replace(/[\r\n]/g, ' ');
}

export function renderSummary(report) {
  const rows = report.certificates.map((certificate) =>
    `| ${escapeSummary(certificate.hostname)} | ${certificate.daysRemaining} | ${certificate.expiresAt} |`);
  return [
    '## OrionCmd post-deploy check',
    '',
    `**Result: ${report.status === 'passed' ? 'Passed' : 'Failed'}**`,
    '',
    `HTTP status: ${report.httpStatus ?? 'Not observed'}. Attempts: ${report.attemptsUsed}.`,
    '',
    ...(report.error ? [`Reason: ${escapeSummary(report.error)}`, ''] : []),
    ...(rows.length ? [
      '| HTTPS host | Whole days remaining | Certificate expiry (UTC) |',
      '| --- | ---: | --- |', ...rows, '',
    ] : ['No validated certificate metadata was observed.', '']),
    'This is a single HTTP/HTTPS observation, not uptime history or a vulnerability scan.',
    'No OrionCmd account, API key, or dashboard reporting is used. Page content is not retained.',
    '',
  ].join('\n');
}

export async function main(env = process.env, dependencies = {}) {
  let config;
  let report;
  try {
    const inputs = Object.fromEntries(INPUT_NAMES.map((name) => [name, env[`INPUT_${name.toUpperCase()}`]]));
    config = readConfig(inputs);
    report = await runCheck(config, dependencies);
  } catch (error) {
    report = {
      status: 'failed', httpStatus: null, certificates: [], attemptsUsed: 0,
      daysRemaining: null, certificateExpiresAt: null,
      error: error.name === 'CheckError' ? error.message : 'The post-deploy check could not be completed.',
    };
  }
  const outputs = {
    status: report.status,
    'http-status': report.httpStatus ?? '',
    'days-remaining': report.daysRemaining ?? '',
    'certificate-expires-at': report.certificateExpiresAt ?? '',
    'attempts-used': report.attemptsUsed,
    report: JSON.stringify(report),
  };
  if (env.GITHUB_OUTPUT) {
    await appendFile(env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''));
  }
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, renderSummary(report));
  if (report.status === 'failed') {
    const shouldFail = !config || config.failOnError;
    console.log(`::${shouldFail ? 'error' : 'warning'} title=OrionCmd post-deploy check::${escapeAnnotation(report.error)}`);
    return shouldFail ? 1 : 0;
  }
  console.log(`OrionCmd: passed (HTTP ${report.httpStatus}; earliest certificate expiry in ${report.daysRemaining} whole days).`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; }).catch(() => {
    console.log('::error title=OrionCmd post-deploy check::Could not write GitHub outputs or finish the check.');
    process.exitCode = 1;
  });
}
