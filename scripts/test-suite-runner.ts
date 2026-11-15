import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type JUnitSummary = {
  tests: number;
  failures: number;
  errors: number;
  skipped: number;
};

export type RequiredSuiteName = 'unit' | 'postgres' | 'sqs' | 'concurrency' | 'recovery' | 'all';

type TestTarget = {
  id: string;
  path: string;
  integration?: boolean;
  sqsReal?: boolean;
};

const unitTarget: TestTarget = { id: 'unit', path: 'test/unit' };
const postgresTargets: TestTarget[] = [
  { id: 'concurrency', path: 'test/integration/concurrency.spec.ts', integration: true },
  { id: 'http-api', path: 'test/integration/http-api.spec.ts', integration: true },
  { id: 'outbox-publisher', path: 'test/integration/outbox-publisher.spec.ts', integration: true },
  { id: 'pending-worker', path: 'test/integration/pending-worker.spec.ts', integration: true },
  {
    id: 'reversal-processing',
    path: 'test/integration/reversal-processing.spec.ts',
    integration: true,
  },
  { id: 'sqs-consumer', path: 'test/integration/sqs-consumer.spec.ts', integration: true },
  { id: 'wager-processing', path: 'test/integration/wager-processing.spec.ts', integration: true },
  {
    id: 'wallet-persistence',
    path: 'test/integration/wallet-persistence.spec.ts',
    integration: true,
  },
];
const sqsTarget: TestTarget = {
  id: 'sqs-localstack',
  path: 'test/integration/sqs-localstack.spec.ts',
  integration: true,
  sqsReal: true,
};

const suiteTargets: Record<RequiredSuiteName, TestTarget[]> = {
  unit: [unitTarget],
  postgres: postgresTargets,
  sqs: [sqsTarget],
  concurrency: [postgresTargets[0]!],
  recovery: [postgresTargets[2]!, postgresTargets[3]!, postgresTargets[4]!, sqsTarget],
  all: [unitTarget, ...postgresTargets, sqsTarget],
};

const registeredIntegrationPaths = [...postgresTargets, sqsTarget].map((target) => target.path);

const emptySummary: JUnitSummary = { tests: 0, failures: 0, errors: 0, skipped: 0 };

function discoverIntegrationSpecs(directory: string, relativeDirectory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const fullPath = join(directory, entry.name);
      const relativePath = `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) return discoverIntegrationSpecs(fullPath, relativePath);
      return entry.isFile() && entry.name.endsWith('.spec.ts') ? [relativePath] : [];
    })
    .sort();
}

export function integrationInventoryProblems(discovered: string[], registered: string[]): string[] {
  const discoveredSet = new Set(discovered);
  const registeredSet = new Set(registered);
  const unregistered = discovered.filter((path) => !registeredSet.has(path));
  const obsolete = registered.filter((path) => !discoveredSet.has(path));
  const duplicates = [
    ...new Set(registered.filter((path, index) => registered.indexOf(path) !== index)),
  ];
  const problems: string[] = [];

  if (unregistered.length > 0) {
    problems.push(`Unregistered integration test files: ${unregistered.sort().join(', ')}`);
  }
  if (obsolete.length > 0) {
    problems.push(
      `Registered integration test files no longer exist: ${obsolete.sort().join(', ')}`,
    );
  }
  if (duplicates.length > 0) {
    problems.push(`Duplicate registered integration test files: ${duplicates.sort().join(', ')}`);
  }
  return problems;
}

function readCount(attributes: string, name: keyof JUnitSummary): number {
  const match = new RegExp(`(?:^|\\s)${name}="(\\d+)"`).exec(attributes);
  return match ? Number.parseInt(match[1]!, 10) : 0;
}

export function summarizeJUnit(xml: string): JUnitSummary {
  const suiteAttributes = [...xml.matchAll(/<testsuite\b([^>]*)>/g)].map((match) => match[1]!);
  if (suiteAttributes.length === 0) {
    throw new Error('JUnit report contains no <testsuite> entries');
  }

  return suiteAttributes.reduce<JUnitSummary>(
    (summary, attributes) => ({
      tests: summary.tests + readCount(attributes, 'tests'),
      failures: summary.failures + readCount(attributes, 'failures'),
      errors: summary.errors + readCount(attributes, 'errors'),
      skipped: summary.skipped + readCount(attributes, 'skipped'),
    }),
    { ...emptySummary },
  );
}

export function junitGateProblems(summary: JUnitSummary, exitCode: number): string[] {
  const problems: string[] = [];
  if (exitCode !== 0) problems.push(`Bun exited with code ${exitCode}`);
  if (summary.tests === 0) problems.push('JUnit reported zero executed tests');
  if (summary.failures > 0) problems.push(`JUnit reported ${summary.failures} failure(s)`);
  if (summary.errors > 0) problems.push(`JUnit reported ${summary.errors} error(s)`);
  if (summary.skipped > 0) problems.push(`JUnit reported ${summary.skipped} skipped test(s)`);
  return problems;
}

function isRequiredSuiteName(value: string | undefined): value is RequiredSuiteName {
  return value !== undefined && Object.hasOwn(suiteTargets, value);
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-');
}

function runTarget(
  suiteName: RequiredSuiteName,
  target: TestTarget,
  resultsDirectory: string,
): { summary: JUnitSummary; problems: string[] } {
  const label = `${suiteName}-${target.id}`;
  const artifactBase = resolve(resultsDirectory, safeName(label));
  const junitPath = `${artifactBase}.xml`;
  const logPath = `${artifactBase}.log`;
  mkdirSync(resolve(resultsDirectory), { recursive: true });

  console.log(`\n[required-tests] Running ${target.path} (serial)`);
  if (!existsSync(resolve(target.path))) {
    const message = `Required test path does not exist: ${target.path}`;
    writeFileSync(logPath, `${message}\n`, 'utf8');
    console.error(`[required-tests] FAIL ${message}`);
    return { summary: { ...emptySummary }, problems: [message] };
  }

  const env = { ...process.env };
  delete env.RUN_INTEGRATION;
  delete env.RUN_SQS_REAL;
  if (target.integration) env.RUN_INTEGRATION = '1';
  if (target.sqsReal) env.RUN_SQS_REAL = '1';

  const result = spawnSync(
    process.execPath,
    ['test', target.path, '--timeout=30000', '--reporter=junit', `--reporter-outfile=${junitPath}`],
    {
      cwd: process.cwd(),
      env,
      encoding: 'utf8',
      timeout: 10 * 60 * 1000,
      maxBuffer: 32 * 1024 * 1024,
    },
  );

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  writeFileSync(logPath, output, 'utf8');
  if (output.length > 0) process.stdout.write(output);

  let summary = { ...emptySummary };
  const problems: string[] = [];
  try {
    summary = summarizeJUnit(readFileSync(junitPath, 'utf8'));
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  if (result.error && result.status === null) {
    problems.push(`Unable to run Bun: ${result.error.message || 'process spawn failed'}`);
  }
  problems.push(...junitGateProblems(summary, result.status ?? 1));

  const status = problems.length === 0 ? 'PASS' : 'FAIL';
  console.log(
    `[required-tests] ${status} ${target.path}: tests=${summary.tests}, failures=${summary.failures}, errors=${summary.errors}, skipped=${summary.skipped}, exit=${result.status ?? 'null'}`,
  );
  for (const problem of problems) console.error(`[required-tests] ${target.path}: ${problem}`);

  return { summary, problems };
}

export function runRequiredSuite(requestedSuite: string | undefined): void {
  if (!isRequiredSuiteName(requestedSuite)) {
    console.error(
      `Usage: bun run scripts/run-required-tests.ts <${Object.keys(suiteTargets).join('|')}>`,
    );
    process.exitCode = 2;
    return;
  }

  if (requestedSuite !== 'unit') {
    let discovered: string[];
    try {
      discovered = discoverIntegrationSpecs(resolve('test/integration'), 'test/integration');
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[required-tests] Unable to discover integration test files: ${detail}`);
      process.exitCode = 1;
      return;
    }

    const inventoryProblems = integrationInventoryProblems(discovered, registeredIntegrationPaths);
    if (inventoryProblems.length > 0) {
      for (const problem of inventoryProblems) console.error(`[required-tests] ${problem}`);
      console.error('[required-tests] Gate failed: integration test inventory is incomplete.');
      process.exitCode = 1;
      return;
    }
  }

  const resultsDirectory = resolve(process.env.TEST_RESULTS_DIR ?? '.test-results');
  const totals = { ...emptySummary };
  const failedTargets: string[] = [];

  for (const target of suiteTargets[requestedSuite]) {
    const result = runTarget(requestedSuite, target, resultsDirectory);
    totals.tests += result.summary.tests;
    totals.failures += result.summary.failures;
    totals.errors += result.summary.errors;
    totals.skipped += result.summary.skipped;
    if (result.problems.length > 0) failedTargets.push(target.path);
  }

  console.log(
    `\n[required-tests] ${requestedSuite}: tests=${totals.tests}, failures=${totals.failures}, errors=${totals.errors}, skipped=${totals.skipped}, targets=${suiteTargets[requestedSuite].length}`,
  );
  if (failedTargets.length > 0) {
    console.error(`[required-tests] Gate failed: ${failedTargets.join(', ')}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[required-tests] Gate passed: every required test ran with zero skips.`);
}
