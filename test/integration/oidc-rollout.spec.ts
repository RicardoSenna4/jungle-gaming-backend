import { oidcHttpFixture } from '../helpers/oidc-http-fixture';
import { applyOperatorPlan, validatePlan } from '../../scripts/oidc-rollout';
import example from '../../infra/rollout/plan.example.json';

const describeIntegration = process.env.RUN_INTEGRATION === '1' ? describe : describe.skip;

describeIntegration('Explicit rollout grants in PostgreSQL', () => {
  let fixture: Awaited<ReturnType<typeof oidcHttpFixture>>;
  beforeAll(async () => {
    fixture = await oidcHttpFixture();
  });
  afterEach(async () => {
    await fixture.clear();
  });
  afterAll(async () => {
    await fixture.close();
  });
  it('applies only named subjects, idempotently, with JWT claims still required', async () => {
    const plan = validatePlan({
      ...example,
      issuer: fixture.issuer,
      environment: 'local',
      operators: [{ subject: 'subject-operator', actions: ['quarantine.read'] }],
    });
    await applyOperatorPlan(fixture.orm, plan);
    await applyOperatorPlan(fixture.orm, plan);
    const rows = await fixture.orm.em
      .getConnection()
      .execute('select issuer, subject, action from operator_grants');
    expect(rows).toEqual([
      { issuer: fixture.issuer, subject: 'subject-operator', action: 'quarantine.read' },
    ]);
    expect((await fixture.http('/operations/quarantine', 'operator')).status).toBe(403);
    expect(
      (
        await fixture.http('/operations/quarantine', 'operator', 'GET', undefined, undefined, {
          roles: ['operator'],
          scope: 'quarantine:read',
        })
      ).status,
    ).toBe(200);
    const audit = await fixture.orm.em
      .getConnection()
      .execute("select id from authorization_audit where action = 'operator_grants'");
    expect(audit).toHaveLength(1);
    expect(
      await fixture.orm.em.getConnection().execute('select * from provider_wallet_grants'),
    ).toHaveLength(0);
  });
  it('rolls back the entire batch if any provision fails', async () => {
    const plan = validatePlan({
      ...example,
      operators: [{ subject: 'first', actions: ['quarantine.read'] }],
    });
    // A PostgreSQL trigger failure after the first insert proves batch atomicity.
    await fixture.orm.em
      .getConnection()
      .execute(
        "create function rollout_test_failure() returns trigger language plpgsql as $$ begin if NEW.action = 'quarantine.resolve' then raise exception 'test rejection'; end if; return NEW; end $$; create trigger rollout_test_failure before insert on operator_grants for each row execute function rollout_test_failure();",
      );
    try {
      plan.operators.push({ subject: 'second', actions: ['quarantine.resolve'] });
      await expect(applyOperatorPlan(fixture.orm, plan)).rejects.toThrow('test rejection');
      expect(
        await fixture.orm.em.getConnection().execute('select * from operator_grants'),
      ).toHaveLength(0);
      expect(
        await fixture.orm.em
          .getConnection()
          .execute("select * from authorization_audit where action = 'operator_grants'"),
      ).toHaveLength(0);
    } finally {
      await fixture.orm.em
        .getConnection()
        .execute(
          'drop trigger rollout_test_failure on operator_grants; drop function rollout_test_failure();',
        );
    }
  });
});
