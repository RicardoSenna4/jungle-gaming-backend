import { junitGateProblems, summarizeJUnit } from '../../scripts/test-suite-runner';

describe('required test suite gate', () => {
  it('summarizes the executed tests from Bun JUnit output', () => {
    const xml =
      '<testsuites><testsuite name="unit" tests="2" failures="0" errors="0" skipped="0" /></testsuites>';

    expect(summarizeJUnit(xml)).toEqual({ tests: 2, failures: 0, errors: 0, skipped: 0 });
    expect(junitGateProblems(summarizeJUnit(xml), 0)).toEqual([]);
  });

  it('rejects a suite that reports skipped tests even when Bun exits successfully', () => {
    const xml =
      '<testsuites><testsuite name="integration" tests="3" failures="0" errors="0" skipped="1" /></testsuites>';

    expect(junitGateProblems(summarizeJUnit(xml), 0)).toContain('JUnit reported 1 skipped test(s)');
  });

  it('rejects test failures and reports with no executed tests', () => {
    const failing =
      '<testsuites><testsuite name="unit" tests="2" failures="1" errors="0" skipped="0" /></testsuites>';
    const empty =
      '<testsuites><testsuite name="empty" tests="0" failures="0" errors="0" skipped="0" /></testsuites>';

    expect(junitGateProblems(summarizeJUnit(failing), 1)).toContain('JUnit reported 1 failure(s)');
    expect(junitGateProblems(summarizeJUnit(empty), 0)).toContain(
      'JUnit reported zero executed tests',
    );
  });
});
