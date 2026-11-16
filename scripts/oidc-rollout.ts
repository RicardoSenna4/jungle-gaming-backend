import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../src/infrastructure/database/mikro-orm.config';
import {
  AdministrativeActor,
  AuthorizationStore,
} from '../src/application/authorization/authorization-store';
import {
  operatorCapabilities,
  OperatorCapability,
} from '../src/infrastructure/database/mikro-orm/authorization.entities';

export interface RolloutPlan {
  version: 1;
  environment: 'local' | 'production';
  issuer: string;
  audience: string;
  apiUrl: string;
  tokenUrl: string;
  metricsClientId: string;
  metricsClientSecretFile: string;
  database: { host: string; port: number; name: string };
  actor: AdministrativeActor;
  operators: Array<{ subject: string; actions: OperatorCapability[] }>;
}

export function validatePlan(value: unknown): RolloutPlan {
  const fail = (): never => {
    throw new Error('INVALID_ROLLOUT_PLAN');
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const plan = value as RolloutPlan;
  const text = (value: unknown): value is string =>
    typeof value === 'string' && value.trim().length > 0 && !/[\r\n\0]/.test(value);
  if (plan.version !== 1 || !['production', 'local'].includes(plan.environment)) fail();
  for (const key of [
    'issuer',
    'audience',
    'apiUrl',
    'tokenUrl',
    'metricsClientId',
    'metricsClientSecretFile',
  ] as const)
    if (!text(plan[key])) fail();
  // No inline credentials in a plan or generated configuration.
  const allowedKeys = [
    'version',
    'environment',
    'issuer',
    'audience',
    'apiUrl',
    'tokenUrl',
    'metricsClientId',
    'metricsClientSecretFile',
    'database',
    'actor',
    'operators',
  ];
  if (Object.keys(plan).some((key) => !allowedKeys.includes(key))) fail();
  for (const value of [plan.issuer, plan.apiUrl, plan.tokenUrl]) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return fail();
    }
    if (url.username || url.password || url.search || url.hash) fail();
    if (
      url.protocol !== 'https:' &&
      !(
        plan.environment === 'local' &&
        url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      )
    )
      fail();
  }
  if (new URL(plan.apiUrl).pathname !== '/' || !isAbsolute(plan.metricsClientSecretFile)) fail();
  if (
    !plan.actor ||
    !['issuer', 'subject', 'source'].every((key) =>
      text(plan.actor[key as keyof AdministrativeActor]),
    )
  )
    fail();
  if (Object.keys(plan.actor).some((key) => !['issuer', 'subject', 'source'].includes(key))) fail();
  if (
    !plan.database ||
    !text(plan.database.host) ||
    !text(plan.database.name) ||
    !Number.isInteger(plan.database.port) ||
    plan.database.port < 1 ||
    plan.database.port > 65535 ||
    Object.keys(plan.database).some((key) => !['host', 'port', 'name'].includes(key))
  )
    fail();
  if (!Array.isArray(plan.operators) || !plan.operators.length) fail();
  const subjects = new Set<string>();
  for (const operator of plan.operators) {
    if (
      !operator ||
      !text(operator.subject) ||
      subjects.has(operator.subject) ||
      Object.keys(operator).some((key) => !['subject', 'actions'].includes(key))
    )
      fail();
    if (
      !Array.isArray(operator.actions) ||
      !operator.actions.length ||
      new Set(operator.actions).size !== operator.actions.length ||
      operator.actions.some((action) => !operatorCapabilities.includes(action))
    )
      fail();
    subjects.add(operator.subject);
  }
  return plan;
}

export function rolloutFiles(plan: RolloutPlan) {
  const url = new URL(plan.apiUrl);
  const env = {
    AUTH_MODE: 'oidc',
    NODE_ENV: plan.environment === 'production' ? 'production' : 'development',
    OIDC_ISSUER_URL: plan.issuer.replace(/\/$/, ''),
    OIDC_AUDIENCE: plan.audience,
    OIDC_ROLES_CLAIM: 'roles',
    OIDC_PERMISSIONS_CLAIM: 'scope',
    OIDC_OPERATOR_ROLES: 'operator',
    OIDC_ADMIN_ROLES: 'admin',
    OIDC_QUARANTINE_READ_PERMISSION: 'quarantine:read',
    OIDC_QUARANTINE_RESOLVE_PERMISSION: 'quarantine:resolve',
    OIDC_METRICS_READ_PERMISSION: 'metrics:read',
    METRICS_ACCESS: 'authenticated',
  };
  const prometheus = {
    global: { scrape_interval: '30s' },
    scrape_configs: [
      {
        job_name: 'jungle-gaming',
        scheme: url.protocol.slice(0, -1),
        metrics_path: '/metrics',
        static_configs: [{ targets: [url.host] }],
        oauth2: {
          client_id: plan.metricsClientId,
          client_secret_file: plan.metricsClientSecretFile,
          token_url: plan.tokenUrl,
          scopes: ['metrics:read'],
        },
      },
    ],
  };
  // JSON is valid YAML and preserves exact strings without template interpolation.
  return {
    apiEnvironment: JSON.stringify(env, null, 2) + '\n',
    prometheus: JSON.stringify(prometheus, null, 2) + '\n',
  };
}

/** Apply only a previously approved explicit plan, through an authenticated administrative process. */
export async function applyOperatorPlan(orm: MikroORM, plan: RolloutPlan): Promise<void> {
  await orm.em.fork().transactional(async (tx) => {
    const store = new AuthorizationStore(tx);
    for (const operator of plan.operators) {
      for (const action of operator.actions)
        await store.grant(
          {
            kind: 'operator',
            issuer: plan.issuer.replace(/\/$/, ''),
            subject: operator.subject,
            action,
          },
          plan.actor,
        );
    }
  });
}

async function main() {
  const [file, output, flag, ...extra] = process.argv.slice(2);
  if (!file || !output || extra.length || (flag !== undefined && flag !== '--apply'))
    throw new Error('USAGE: bun run scripts/oidc-rollout.ts PLAN_JSON OUTPUT_DIRECTORY [--apply]');
  const raw = await readFile(file, 'utf8');
  const plan = validatePlan(JSON.parse(raw));
  const generated = rolloutFiles(plan);
  await mkdir(output, { recursive: true, mode: 0o700 });
  // Exclusive writes preserve existing review/configuration files.
  await writeFile(resolve(output, 'api-environment.json'), generated.apiEnvironment, {
    flag: 'wx',
    mode: 0o600,
  });
  await writeFile(resolve(output, 'prometheus.json'), generated.prometheus, {
    flag: 'wx',
    mode: 0o600,
  });
  if (flag === '--apply') {
    if (
      [plan.issuer, plan.apiUrl, plan.tokenUrl].some((value) =>
        new URL(value).hostname.endsWith('.invalid'),
      ) ||
      [
        plan.actor.subject,
        plan.actor.source,
        ...plan.operators.map((operator) => operator.subject),
      ].some((value) => value.includes('REPLACE_WITH_'))
    )
      throw new Error('UNRESOLVED_ROLLOUT_IDENTITIES');
    if (
      process.env.DB_HOST !== plan.database.host ||
      process.env.DB_NAME !== plan.database.name ||
      process.env.DB_PORT !== String(plan.database.port)
    )
      throw new Error('DATABASE_TARGET_MISMATCH');
    const orm = await MikroORM.init(
      plan.environment === 'production'
        ? {
            ...config,
            driverOptions: {
              connection: {
                ssl: {
                  rejectUnauthorized: true,
                  ...(process.env.DB_SSL_CA_FILE
                    ? { ca: await readFile(process.env.DB_SSL_CA_FILE, 'utf8') }
                    : {}),
                },
              },
            },
          }
        : config,
    );
    try {
      await applyOperatorPlan(orm, plan);
    } finally {
      await orm.close(true);
    }
  }
  console.log(
    JSON.stringify({
      status: flag === '--apply' ? 'grants-applied' : 'prepared-only',
      planSha256: createHash('sha256').update(raw).digest('hex'),
      subjects: plan.operators.length,
    }),
  );
}

if (import.meta.main)
  main().catch(() => {
    console.error(
      'ROLLOUT_FAILED: verify plan, explicit database target and administrative access; existing files are never overwritten.',
    );
    process.exitCode = 1;
  });
