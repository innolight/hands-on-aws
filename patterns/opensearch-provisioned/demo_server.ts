import { Client } from '@opensearch-project/opensearch';
import { AwsSigv4Signer } from '@opensearch-project/opensearch/aws-v3';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { getStackOutputs } from '../../utils';
import { opensearchProvisionedStackName } from './stack';
import { createApp } from './app';

// Demo server for OpenSearch Provisioned pattern.
// Runs locally — connects via SSM port-forward tunnel to the domain inside the VPC.
//
// Start the SSM tunnel before running this server:
//   aws ssm start-session --target <BastionInstanceId> \
//     --document-name AWS-StartPortForwardingSessionToRemoteHost \
//     --parameters '{"host":["<DomainEndpointHostname>"],"portNumber":["443"],"localPortNumber":["8443"]}'
//
// Then start this server:
//   AWS_REGION=eu-central-1 npx ts-node patterns/opensearch-provisioned/demo_server.ts

const PORT = process.env.PORT || 3000;
// TUNNEL_PORT must match the --parameters localPortNumber in the SSM port-forward command above.
const TUNNEL_PORT = Number(process.env.TUNNEL_PORT || 8443);
const REGION = process.env.AWS_REGION || 'eu-central-1';

(async () => {
  const outputs = await getStackOutputs(opensearchProvisionedStackName);
  console.log(`StackOutputs for ${opensearchProvisionedStackName}:`, outputs);

  // domainHostname is used in the Host header override so SigV4 signs against
  // the real endpoint, not localhost. The tunnel only changes the TCP destination.
  const domainHostname = new URL(outputs['DomainEndpoint']).hostname;

  // Reuse CloudFormationClient's credential provider — already a direct dependency.
  // It resolves the full chain: env vars → ~/.aws/credentials → SSO → instance metadata.
  const cfnClient = new CloudFormationClient({ region: REGION });
  const credentialsProvider = cfnClient.config.credentials;

  const client = new Client({
    ...AwsSigv4Signer({
      region: REGION,
      // service: 'es' — provisioned OpenSearch domains use 'es', NOT 'aoss' (which is for Serverless).
      // Using 'aoss' on a provisioned domain produces 403 with no descriptive error.
      service: 'es',
      getCredentials: () => credentialsProvider(),
      // Called per-request so expiry is checked each time. The SDK's default provider
      // caches credentials internally and refreshes before expiry.
    }),
    node: `https://localhost:${TUNNEL_PORT}`,
    // Override Host so SigV4 signature matches the real endpoint, not 'localhost'.
    // The signature includes the Host header; a mismatch causes 403 SignatureDoesNotMatch.
    headers: { Host: domainHostname },
    ssl: {
      // !! Required when tunneling — in production (direct VPC access), remove this.
      // The domain TLS cert is issued for the real endpoint hostname, not 'localhost'.
      rejectUnauthorized: false,
    },
    // Domain may be slow right after creation while the cluster initializes (~15-20 min deploy).
    requestTimeout: 60_000,
    // Compresses request bodies — meaningful savings for bulk indexing.
    compression: 'gzip',
    // Retries on 502/503/504 only. 429 (thread pool rejection) is handled by withRetry in app.ts.
    maxRetries: 3,
  });

  const app = createApp(client);
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Tunneling to ${domainHostname} via localhost:${TUNNEL_PORT}`);
  });
})();
