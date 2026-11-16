import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';

export function publicOidcAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number) as [number, number, number];
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  const lower = address.toLowerCase();
  return (
    isIP(address) === 6 &&
    /^[23]/.test(lower) &&
    !lower.startsWith('2002:') &&
    !/^2001:(?:0:|0000:|db8:|0db8:)/.test(lower)
  );
}

export function trustedOidcUrl(value: string, allowLoopback: boolean): URL {
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' && !(allowLoopback && loopback && url.protocol === 'http:')) ||
    (isIP(hostname) && !publicOidcAddress(hostname) && !(allowLoopback && loopback))
  )
    throw new Error('OIDC_URL_BLOCKED');
  return url;
}

/** Resolve once, validate every answer and connect to the pinned IP with original TLS SNI. */
export async function oidcJson(
  url: URL,
  timeoutMs: number,
  allowLoopback: boolean,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_resolve, reject) =>
        controller.signal.addEventListener('abort', () => reject(new Error('OIDC_TIMEOUT')), {
          once: true,
        }),
      ),
    ]);
    if (
      !addresses.length ||
      addresses.some(
        ({ address }) =>
          !publicOidcAddress(address) &&
          !(
            allowLoopback &&
            ['localhost', '127.0.0.1', '::1'].includes(hostname) &&
            ['127.0.0.1', '::1'].includes(address)
          ),
      )
    )
      throw new Error('OIDC_ADDRESS_BLOCKED');
    controller.signal.throwIfAborted();
    const pinned = addresses[0]!;
    return await new Promise((resolve, reject) => {
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
        {
          hostname: pinned.address,
          family: pinned.family,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          servername: hostname,
          path: url.pathname,
          method: 'GET',
          signal: controller.signal,
          headers: { host: url.host, accept: 'application/json' },
          rejectUnauthorized: true,
        },
        (response) => {
          if (response.statusCode !== 200) {
            response.resume();
            reject(new Error('OIDC_HTTP_ERROR'));
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 262144) {
              response.destroy();
              reject(new Error('OIDC_BODY_TOO_LARGE'));
            } else chunks.push(chunk);
          });
          response.on('error', reject);
          response.on('end', () => {
            try {
              const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if (!body || typeof body !== 'object' || Array.isArray(body))
                throw new Error('OIDC_INVALID_JSON');
              resolve(body as Record<string, unknown>);
            } catch {
              reject(new Error('OIDC_INVALID_JSON'));
            }
          });
        },
      );
      const abort = () => {
        request.destroy();
        reject(new Error('OIDC_TIMEOUT'));
      };
      controller.signal.addEventListener('abort', abort, { once: true });
      request.once('close', () => controller.signal.removeEventListener('abort', abort));
      if (controller.signal.aborted) abort();
      request.on('error', reject);
      request.end();
    });
  } finally {
    clearTimeout(timeout);
  }
}
