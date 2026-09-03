import { chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const stateDirectory = resolve(root, process.env.OPTIWORK_LOCAL_STATE_DIR ?? '.optiwork/localnet');

const readJson = async (name) => JSON.parse(await readFile(resolve(stateDirectory, name), 'utf8'));
const privateJwk = await readJson('fabric-permit-private.jwk.json');
const publicJwk = await readJson('fabric-permit-public.jwk.json');
const deployment = await readJson('algorand-deployment.json');
const accounts = await readJson('algorand-accounts.json');
const executorToken = (await readFile(resolve(stateDirectory, 'executor-token.txt'), 'utf8')).trim();

if (privateJwk.kty !== 'OKP' || privateJwk.crv !== 'Ed25519' || typeof privateJwk.d !== 'string') {
  throw new Error('The local Fabric permit private JWK is invalid.');
}
if (publicJwk.kty !== 'OKP' || publicJwk.crv !== 'Ed25519' || typeof publicJwk.x !== 'string') {
  throw new Error('The local Fabric permit public JWK is invalid.');
}
if (privateJwk.kid !== publicJwk.kid || privateJwk.x !== publicJwk.x) {
  throw new Error('The local Fabric permit JWK pair does not match.');
}
if (deployment.network !== 'localnet' || typeof deployment.genesisHash !== 'string') {
  throw new Error('The Algorand deployment manifest is not a LocalNet deployment.');
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

const treasury = (name) => {
  const account = accounts[name];
  if (typeof account?.address !== 'string' || typeof account?.privateKeyBase64 !== 'string') {
    throw new Error(`Missing generated Algorand account ${name}.`);
  }
  return { address: account.address, privateKeyBase64: account.privateKeyBase64 };
};

const permitMetadata = {
  FABRIC_PERMIT_ISSUER: 'optiwork-fabric-gateway',
  FABRIC_PERMIT_AUDIENCE: 'optiwork-algorand-executor',
};

const gatewayValues = {
  FABRIC_IDENTITIES_JSON: JSON.stringify(fabricIdentities),
  FABRIC_PERMIT_PRIVATE_JWK_JSON: JSON.stringify(privateJwk),
  ...permitMetadata,
  FABRIC_PERMIT_KEY_ID: privateJwk.kid,
  FABRIC_PERMIT_TTL_SECONDS: '60',
};

const executorValues = {
  FABRIC_PERMIT_PUBLIC_JWK_JSON: JSON.stringify(publicJwk),
  ...permitMetadata,
  FABRIC_PERMIT_MAX_AGE_SECONDS: '60',
  EXECUTOR_BEARER_TOKEN: executorToken,
  ALGORAND_GENESIS_HASH: deployment.genesisHash,
  ALGORAND_APPLICATION_ID: deployment.applicationId,
  ALGORAND_ASSET_ID: String(deployment.assetId),
  ALGORAND_SIGNER_ADDRESS: accounts.executor.address,
  ALGORAND_SIGNER_PRIVATE_KEY_BASE64: accounts.executor.privateKeyBase64,
  ALGORAND_ORIGIN_PROVIDER_TREASURIES_JSON: JSON.stringify([
    treasury('inwardOrigin'),
    treasury('outwardOrigin'),
  ]),
  ALGORAND_MAX_VALIDITY_ROUNDS: '100',
  ALGORAND_MAX_TRANSACTION_FEE_MICROALGOS: '10000',
  ALGORAND_MAX_GROUP_FEE_MICROALGOS: '20000',
};

const apiValues = {
  ALGORAND_EXECUTOR_TOKEN: executorToken,
};

const runtimeFiles = [
  ['fabric-gateway.env', gatewayValues],
  ['algorand-executor.env', executorValues],
  ['api.env', apiValues],
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

// Remove the legacy all-services file so a stale copy cannot silently erode
// the workload boundary after upgrading an existing local checkout.
await rm(resolve(stateDirectory, 'runtime.env'), { force: true });
process.stdout.write(`${runtimeFiles.map(([name]) => resolve(stateDirectory, name)).join('\n')}\n`);
