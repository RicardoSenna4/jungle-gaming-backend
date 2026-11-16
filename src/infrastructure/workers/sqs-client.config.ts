import { SQSClientConfig } from '@aws-sdk/client-sqs';

export function sqsClientConfig(env: NodeJS.ProcessEnv = process.env): SQSClientConfig {
  return {
    region: env.AWS_REGION ?? 'us-east-1',
    ...(env.SQS_ENDPOINT
      ? {
          endpoint: env.SQS_ENDPOINT,
          credentials: {
            accessKeyId: env.AWS_ACCESS_KEY_ID ?? 'test',
            secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? 'test',
          },
        }
      : {}),
  };
}
