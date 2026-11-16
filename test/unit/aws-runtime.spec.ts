import { WagerTransactionConsumer } from '../../src/infrastructure/workers/wager-transaction.consumer';
import { WagerProcessingService } from '../../src/application/wager-processing.service';
import { databaseTlsConfig } from '../../src/infrastructure/database/database-tls.config';
import { sqsClientConfig } from '../../src/infrastructure/workers/sqs-client.config';

describe('AWS runtime configuration', () => {
  it('does not force a LocalStack endpoint when ECS uses the AWS credential chain', () => {
    const endpoint = process.env.SQS_ENDPOINT;
    delete process.env.SQS_ENDPOINT;
    const consumer = new WagerTransactionConsumer({} as WagerProcessingService);
    try {
      const client = (
        consumer as unknown as { sqs: { config: { endpoint?: unknown }; destroy(): void } }
      ).sqs;
      expect(client.config.endpoint).toBeUndefined();
      client.destroy();
    } finally {
      if (endpoint === undefined) delete process.env.SQS_ENDPOINT;
      else process.env.SQS_ENDPOINT = endpoint;
    }
  });
  it('validates database TLS certificates and accepts an explicit trusted CA', () => {
    expect(databaseTlsConfig({ DB_SSL: 'true' })).toEqual({ rejectUnauthorized: true });
    expect(databaseTlsConfig({ DB_SSL: 'true', DB_SSL_CA: 'trusted-pem' })).toEqual({
      rejectUnauthorized: true,
      ca: 'trusted-pem',
    });
    expect(databaseTlsConfig({})).toBe(false);
  });
  it('uses the SDK credential chain on AWS and explicit dummy credentials only for local endpoints', () => {
    expect(sqsClientConfig({ AWS_REGION: 'sa-east-1' })).toEqual({ region: 'sa-east-1' });
    expect(sqsClientConfig({ SQS_ENDPOINT: 'http://localhost:4566' })).toEqual({
      region: 'us-east-1',
      endpoint: 'http://localhost:4566',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
  });
});
