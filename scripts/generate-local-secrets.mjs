import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

const stateDirectory = resolve(process.env.OPTIWORK_LOCAL_STATE_DIR ?? '.optiwork/localnet');
const privatePath = resolve(stateDirectory, 'fabric-permit-private.jwk.json');
const publicPath = resolve(stateDirectory, 'fabric-permit-public.jwk.json');
const tokenPath = resolve(stateDirectory, 'executor-token.txt');
await mkdir(stateDirectory, { recursive: true, mode: 0o700 });

try {
  await readFile(privatePath, 'utf8');
} catch {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const kid = 'optiwork-local-permit-1';
  const privateJwk = { ...privateKey.export({ format: 'jwk' }), kid, alg: 'EdDSA', use: 'sig' };
  const publicJwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'EdDSA', use: 'sig' };
  await writeFile(privatePath, `${JSON.stringify(privateJwk)}\n`, { mode: 0o600 });
  await writeFile(publicPath, `${JSON.stringify(publicJwk)}\n`, { mode: 0o600 });
}
try {
  await readFile(tokenPath, 'utf8');
} catch {
  await writeFile(tokenPath, `${randomBytes(32).toString('base64url')}\n`, { mode: 0o600 });
}
await Promise.all([privatePath, publicPath, tokenPath].map((path) => chmod(path, 0o600)));
process.stdout.write(`${stateDirectory}\n`);
