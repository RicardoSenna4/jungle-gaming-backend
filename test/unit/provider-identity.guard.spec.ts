import { ExecutionContext } from '@nestjs/common';
import { ChallengeProviderIdentityGuard } from '../../src/interfaces/http/provider-identity.guard';

describe('ChallengeProviderIdentityGuard', () => {
  it('provides an explicit no-op OIDC extension without blocking challenge requests', () => {
    const guard = new ChallengeProviderIdentityGuard();
    expect(guard.canActivate({} as ExecutionContext)).toBe(true);
  });
});
