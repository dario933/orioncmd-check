import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

const DAY_MS = 86_400_000;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class CheckError extends Error {
  constructor(message, retryable = false) {
    super(message);
    this.name = 'CheckError';
    this.retryable = retryable;
  }
}

function integer(value, fallback, name, min, max) {
  const text = value === undefined || value === '' ? String(fallback) : String(value);
  if (!/^\d+$/.test(text)) throw new CheckError(`${name} must be an integer.`);
  const result = Number(text);
  if (!Number.isSafeInteger(result) || result < min || result > max) {
    throw new CheckError(`${name} must be between ${min} and ${max}.`);
  }
  return result;
}

export function validateUrl(raw) {
  let url;
  try {
    if (typeof raw !== 'string' || raw.length > 2048) throw new Error();
    url = new URL(raw);
  } catch {
    throw new CheckError('url must be a valid public HTTPS URL.');
  }
  if (url.protocol !== 'https:' || (url.port && url.port !== '443')) {
    throw new CheckError('Only HTTPS URLs on port 443 are supported.');
  }
  if (url.username || url.password) throw new CheckError('URL credentials are not supported.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!hostname || hostname.length > 253 ||
      /(^|\.)(localhost|local|internal|invalid|test|example)$/.test(hostname) ||
      /(^|\.)home\.arpa$/.test(hostname)) {
    throw new CheckError('Local and reserved hostnames are not supported.');
  }
  if (isIP(hostname) && !isPublicAddress(hostname)) {
    throw new CheckError('Private and reserved IP addresses are not supported.');
  }
  url.hash = '';
  return url;
}

// Conservative public-address allowlist: unknown/special-use space is refused.
export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (family === 6) {
    const parts = address.toLowerCase().split(':');
    const first = Number.parseInt(parts[0] || '0', 16);
    const second = Number.parseInt(parts[1] || '0', 16);
    return first >= 0x2000 && first <= 0x3fff &&
      !(first === 0x2001 && (second <= 0x01ff || second === 0x0db8)) &&
      first !== 0x2002 && !(first === 0x3fff && second <= 0x0fff);
  }
  return false;
}

export function readConfig(inputs) {
  const url = validateUrl(inputs.url);
  const expectedText = inputs['expected-status'] || '200-299';
  if (expectedText.length > 128) throw new CheckError('expected-status is too long.');
  const expectedRanges = expectedText.split(',').map((part) => {
    const match = part.trim().match(/^([1-5]\d{2})(?:-([1-5]\d{2}))?$/);
    if (!match) throw new CheckError('expected-status must contain HTTP codes or ranges, such as 200-299,304.');
    const start = Number(match[1]);
    const end = Number(match[2] ?? match[1]);
    if (start > end) throw new CheckError('expected-status ranges must be ascending.');
    return [start, end];
  });
  const failOnError = inputs['fail-on-error'] || 'true';
  if (!['true', 'false'].includes(failOnError)) throw new CheckError('fail-on-error must be true or false.');
  return {
    url: url.href,
    minimumDays: integer(inputs['minimum-days'], 21, 'minimum-days', 0, 3650),
    expectedRanges,
    attempts: integer(inputs.attempts, 3, 'attempts', 1, 5),
    retryDelayMs: integer(inputs['retry-delay-seconds'], 5, 'retry-delay-seconds', 0, 30) * 1000,
    timeoutMs: integer(inputs['timeout-seconds'], 10, 'timeout-seconds', 1, 30) * 1000,
    failOnError: failOnError === 'true',
  };
}

async function abortable(promise, signal) {
  signal.throwIfAborted();
  let onAbort;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        onAbort = () => reject(new CheckError('The request deadline was exceeded.', true));
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function networkError(error) {
  if (error instanceof CheckError) return error;
  const code = String(error?.code ?? '');
  if (/CERT|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|INVALID_CA/.test(code)) {
    return new CheckError('HTTPS certificate validation failed (trust, expiry, or hostname).');
  }
  return new CheckError('The HTTPS endpoint could not be reached within the request deadline.', true);
}

/** Validates and pins DNS for EACH redirect hop; never disables TLS validation. */
export async function fetchHop(rawUrl, { signal, timeoutMs }, dependencies = {}) {
  const url = validateUrl(rawUrl);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const controller = new AbortController();
  const requestSignal = AbortSignal.any([signal, controller.signal]);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resolver = dependencies.lookup ?? lookup;
    const addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await abortable(resolver(hostname, { all: true, verbatim: true }), requestSignal);
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
      throw new CheckError('DNS returned a private, reserved, or unusable address; no request was sent.');
    }
    requestSignal.throwIfAborted();
    const pinned = addresses.find(({ family }) => family === 4) ?? addresses[0];
    const request = dependencies.request ?? httpsRequest;
    return await new Promise((resolve, reject) => {
      const req = request(url, {
        method: 'GET',
        agent: false,
        rejectUnauthorized: true,
        autoSelectFamily: false,
        signal: requestSignal,
        lookup: (_host, options, callback) => {
          if (options?.all) callback(null, [pinned]);
          else callback(null, pinned.address, pinned.family);
        },
        headers: {
          'user-agent': 'OrionCmd-PostDeploy/1.0',
          accept: '*/*',
          'accept-encoding': 'identity',
        },
      }, (response) => {
        const socket = response.socket;
        const certificate = socket?.getPeerCertificate?.();
        if (!socket?.authorized || !certificate?.valid_to || !certificate?.valid_from) {
          response.destroy();
          reject(new CheckError('No validated HTTPS certificate was observed.'));
          return;
        }
        const observed = {
          hostname,
          validFrom: certificate.valid_from,
          validTo: certificate.valid_to,
        };
        // Only response headers and certificate metadata are retained.
        // Do not collect, store, or print the page body.
        const hop = { status: response.statusCode, location: response.headers.location, certificate: observed };
        response.destroy();
        resolve(hop);
      });
      req.on('error', (error) => reject(networkError(error)));
      req.end();
    });
  } catch (error) {
    throw networkError(error);
  } finally {
    clearTimeout(timer);
  }
}

async function checkAttempt(config, dependencies, signal) {
  const certificates = [];
  let httpStatus = null;
  try {
    let url = validateUrl(config.url);
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
      signal.throwIfAborted();
      const hop = await (dependencies.fetchHop ?? fetchHop)(url.href, {
        signal, timeoutMs: config.timeoutMs,
      });
      const expires = new Date(hop.certificate.validTo);
      const starts = new Date(hop.certificate.validFrom);
      const now = (dependencies.now ?? Date.now)();
      if (!Number.isFinite(expires.getTime()) || !Number.isFinite(starts.getTime())) {
        throw new CheckError('Certificate dates were unavailable or invalid.');
      }
      const remainingMs = expires.getTime() - now;
      certificates.push({
        hostname: hop.certificate.hostname,
        expiresAt: expires.toISOString(),
        daysRemaining: Math.floor(remainingMs / DAY_MS),
      });
      httpStatus = hop.status;
      if (starts.getTime() > now || remainingMs <= 0) {
        throw new CheckError('An HTTPS certificate is expired or not yet valid.');
      }
      if (remainingMs <= config.minimumDays * DAY_MS) {
        throw new CheckError(`A certificate has ${config.minimumDays} days or fewer remaining.`);
      }
      if (REDIRECT_STATUSES.has(hop.status)) {
        if (!hop.location) throw new CheckError('A redirect did not provide a Location header.');
        if (redirect === MAX_REDIRECTS) throw new CheckError('The maximum of five redirects was exceeded.');
        // Revalidate before fetching: no HTTP downgrade or private destination.
        url = validateUrl(new URL(hop.location, url).href);
        continue;
      }
      if (!config.expectedRanges.some(([start, end]) => hop.status >= start && hop.status <= end)) {
        throw new CheckError(`Unexpected HTTP status ${hop.status}.`, true);
      }
      return { status: 'passed', httpStatus, certificates, error: null, retryable: false };
    }
    throw new CheckError('The redirect chain could not be completed.');
  } catch (error) {
    const failure = networkError(error);
    return { status: 'failed', httpStatus, certificates, error: failure.message, retryable: failure.retryable };
  }
}

export async function runCheck(config, dependencies = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), dependencies.deadlineMs ?? 120_000);
  let result;
  try {
    for (let attempt = 1; attempt <= config.attempts; attempt++) {
      result = { ...await checkAttempt(config, dependencies, controller.signal), attemptsUsed: attempt };
      if (result.status === 'passed' || !result.retryable || attempt === config.attempts || controller.signal.aborted) break;
      try {
        await sleep(config.retryDelayMs, undefined, { signal: controller.signal });
      } catch {
        break;
      }
    }
    if (controller.signal.aborted) {
      result = { ...result, status: 'failed', error: 'The overall two-minute check deadline was exceeded.' };
    }
    const earliest = [...result.certificates].sort((a, b) => a.expiresAt.localeCompare(b.expiresAt))[0];
    const { retryable: _retryable, ...report } = result;
    return {
      ...report,
      daysRemaining: earliest?.daysRemaining ?? null,
      certificateExpiresAt: earliest?.expiresAt ?? null,
    };
  } finally {
    clearTimeout(timer);
  }
}
