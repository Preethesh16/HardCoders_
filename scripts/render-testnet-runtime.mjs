import { chmod, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const stateDirectory = resolve(root, '.optiwork/testnet');
const accountsPath = resolve(root, 'services/algorand-executor/generated-credentials/testnet-accounts.json');

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const privateJwk = await readJson(resolve(stateDirectory, 'fabric-permit-private.jwk.json'));
const publicJwk = await readJson(resolve(stateDirectory, 'fabric-permit-public.jwk.json'));
const deployment = await readJson(resolve(stateDirectory, 'algorand-deployment.json'));
const accounts = await readJson(accountsPath);
const executorToken = (await readFile(resolve(stateDirectory, 'executor-token.txt'), 'utf8')).trim();

const accountMode = (await stat(accountsPath)).mode & 0o777;
if ((accountMode & 0o077) !== 0) throw new Error('The TestNet account file must be owner-only (chmod 600).');
if (privateJwk.kty !== 'OKP' || privateJwk.crv !== 'Ed25519' || typeof privateJwk.d !== 'string') {
  throw new Error('The TestNet Fabric permit private JWK is invalid.');
}
if (publicJwk.kty !== 'OKP' || publicJwk.crv !== 'Ed25519' || typeof publicJwk.x !== 'string') {
  throw new Error('The TestNet Fabric permit public JWK is invalid.');
}
if (privateJwk.kid !== publicJwk.kid || privateJwk.x !== publicJwk.x) {
  throw new Error('The TestNet Fabric permit JWK pair does not match.');
}
if (deployment.network !== 'testnet' || deployment.assetId !== 10458941 || deployment.applicationId !== '770960502') {
  throw new Error('The runtime manifest is not the pinned Anchor public TestNet deployment.');
}
if (accounts.network !== 'testnet' || accounts.genesisId !== 'testnet-v1.0') {
  throw new Error('The account file is not an Algorand TestNet account set.');
}
if (deployment.executorAddress !== accounts.deployer?.address) {
  throw new Error('The TestNet executor address does not match the guarded account file.');
}

const destinations = new Set(Object.values(accounts.destinationProviders ?? {}).map((entry) => entry.address));
for (const [bookId, provider] of Object.entries(deployment.providers ?? {})) {
  if (provider.originAddress !== accounts.originProviderTreasury?.address || !destinations.has(provider.destinationAddress)) {
    throw new Error(`The TestNet provider mapping for ${bookId} does not match the guarded account file.`);
  }
}

const identity = (role, mspId, organization, user, peer) => ({
  role,
  mspId,
  certificatePath: `/fabric/peerOrganizations/${organization}/users/${user}@${organization}/msp/signcerts/cert.pem`,
  privateKeyPath: `/fabric/peerOrganizations/${organization}/users/${user}@${organization}/msp/keystore/key.pem`,
  tlsRootCertificatePath: `/fabric/peerOrganizations/${organization}/peers/${peer}/tls/ca.crt`,
  peerEndpoint: `${peer}:7051`,
  tlsServerName: peer,
});

const fabricIdentities = [
  identity('seller', 'SellerOrgMSP', 'seller.optiwork.local', 'seller-app', 'peer0.seller.optiwork.local'),
  identity('buyer', 'BuyerOrgMSP', 'buyer.optiwork.local', 'buyer-app', 'peer0.buyer.optiwork.local'),
  identity('reader', 'BuyerOrgMSP', 'buyer.optiwork.local', 'reader-app', 'peer0.buyer.optiwork.local'),
];

const permitMetadata = {
  FABRIC_PERMIT_ISSUER: 'optiwork-fabric-gateway',
  FABRIC_PERMIT_AUDIENCE: 'optiwork-algorand-executor',
};

const gatewayValues = {
  FABRIC_IDENTITIES_JSON: JSON.stringify(fabricIdentities),
  FABRIC_PERMIT_PRIVATE_JWK_JSON: JSON.stringify(privateJwk),
  ...permitMetadata,
  FABRIC_PERMIT_KEY_ID: privateJwk.kid,
  FABRIC_PERMIT_TTL_SECONDS: '120',
};

const executorValues = {
  FABRIC_PERMIT_PUBLIC_JWK_JSON: JSON.stringify(publicJwk),
  ...permitMetadata,
  FABRIC_PERMIT_MAX_AGE_SECONDS: '120',
  EXECUTOR_BEARER_TOKEN: executorToken,
  PUBLIC_TESTNET_DEMO: 'true',
  FABRIC_GATEWAY_DEMO_AUTH: 'true',
  ALGORAND_GENESIS_HASH: deployment.genesisHash,
  ALGORAND_APPLICATION_ID: deployment.applicationId,
  ALGORAND_ASSET_ID: String(deployment.assetId),
  ALGORAND_SIGNER_ADDRESS: accounts.deployer.address,
  ALGORAND_SIGNER_PRIVATE_KEY_BASE64: accounts.deployer.privateKeyBase64,
  ALGORAND_ORIGIN_PROVIDER_TREASURIES_JSON: JSON.stringify([accounts.originProviderTreasury]),
  ALGORAND_MAX_VALIDITY_ROUNDS: '100',
  ALGORAND_MAX_TRANSACTION_FEE_MICROALGOS: '10000',
  ALGORAND_MAX_GROUP_FEE_MICROALGOS: '20000',
};

const runtimeFiles = [
  ['fabric-gateway.env', gatewayValues],
  ['algorand-executor.env', executorValues],
  ['api.env', { ALGORAND_EXECUTOR_TOKEN: executorToken }],
];

for (const [fileName, values] of runtimeFiles) {
  for (const [name, value] of Object.entries(values)) {
    if (typeof value !== 'string' || value.length === 0 || value.includes('\n')) {
      throw new Error(`Runtime value ${name} in ${fileName} is invalid.`);
    }
  }
  const path = resolve(stateDirectory, fileName);
  await writeFile(path, `${Object.entries(values).map(([name, value]) => `${name}=${value}`).join('\n')}\n`, {
    mode: 0o600,
  });
  await chmod(path, 0o600);
}

process.stdout.write('Rendered three owner-only TestNet workload environment files.\n');
