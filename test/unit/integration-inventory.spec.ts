import { integrationInventoryProblems } from '../../scripts/test-suite-runner';

describe('integration test inventory', () => {
  it('rejects unregistered specs and duplicate registrations', () => {
    const discovered = [
      'test/integration/concurrency.spec.ts',
      'test/integration/new-required.spec.ts',
    ];
    const registered = [
      'test/integration/concurrency.spec.ts',
      'test/integration/concurrency.spec.ts',
    ];

    const problems = integrationInventoryProblems(discovered, registered);

    expect(problems).toContain(
      'Unregistered integration test files: test/integration/new-required.spec.ts',
    );
    expect(problems).toContain(
      'Duplicate registered integration test files: test/integration/concurrency.spec.ts',
    );
    expect(integrationInventoryProblems(discovered, discovered)).toEqual([]);
  });
});
