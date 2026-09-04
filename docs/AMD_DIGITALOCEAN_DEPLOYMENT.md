# Anchor hosted demo on an AMD DigitalOcean Droplet

This runbook deploys the existing Anchor demonstration without changing its
business workflow:

- the public edge is Caddy with automatic HTTPS and HTTP basic authentication;
- only ports 80 and 443 are published by the application stack;
- the canonical product experience is served by `apps/marketing`;
- the API, Fabric Gateway, Algorand executor and MinIO remain private;
- application and command-journal records use Supabase PostgreSQL with
  `verify-full` TLS;
- work evidence uses the private BuyerOrg/SellerOrg Fabric network;
- settlement uses the pinned Algorand TestNet ARC-4 application and Circle
  TestNet USDC ASA `10458941`.

This is a protected hackathon deployment, not a production payment service.
The application still uses guarded demo principals. A generally available
deployment requires production OIDC, licensed payment providers, a security
assessment and a resilient multi-node Fabric ordering service.

## 1. Create the Droplet

Use Ubuntu 24.04 LTS on AMD/x86-64. Do not select an ARM image for this
deployment.

Recommended evaluation size:

- 8 vCPU and 16 GiB RAM;
- 80–100 GiB NVMe boot disk;
- a region close to the Supabase project;
- monitoring, backups, IPv6 and VPC enabled.

Upload an SSH public key during creation. In the DigitalOcean Cloud Firewall,
allow TCP 22 only from the operator's IP and allow TCP 80/443 from all IPv4 and
IPv6 sources. Do not expose 3000, 4000, 4175, 4200, 4301, 5432, 7050–7054,
9000, 9001 or 9443.

## 2. Prepare Ubuntu

Create a non-root sudo user and follow Docker's official Ubuntu installation
instructions to install Docker Engine and the Compose v2 plugin. Add the user
to the `docker` group, log out and back in, then verify:

```bash
uname -m                       # x86_64
docker version
docker compose version
```

Install the remaining host tools and Node.js 24:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git jq openssl tar
node --version                 # v24.x
```

Create a deployment directory owned by the non-root user:

```bash
sudo mkdir -p /opt/anchor
sudo chown "$USER":"$USER" /opt/anchor
git clone git@github.com:Preethesh16/HardCoders_.git /opt/anchor
cd /opt/anchor
corepack enable
corepack pnpm install --frozen-lockfile
```

Use a read-only GitHub deploy key on the server. Do not copy a personal GitHub
private key.

## 3. Rotate and configure credentials

Rotate the Supabase password that appeared in development communication before
putting the server online. Create fresh restricted OpenAI and MinIO credentials.

```bash
cd /opt/anchor
cp infra/hosted.env.example .env.hosted
chmod 600 .env.hosted
```

Generate a password and its Caddy bcrypt hash:

```bash
openssl rand -base64 32
docker run --rm caddy:2.10.2-alpine \
  caddy hash-password --plaintext 'PASTE_THE_NEW_PASSWORD'
```

Populate `.env.hosted`. Keep the bcrypt hash single-quoted because it contains
`$` characters. `SUPABASE_DATABASE_URL` must be the session-pooler URI on port
5432 without `sslmode` or any other query parameter.

## 4. Transfer the pinned TestNet signer safely

The deployed ARC-4 application is bound to the existing disposable TestNet
executor and provider accounts. Transfer only these two ignored files over SSH:

```bash
ssh DEPLOY_USER@DROPLET_IP 'mkdir -p /opt/anchor/.optiwork/testnet /opt/anchor/services/algorand-executor/generated-credentials && chmod 700 /opt/anchor/.optiwork /opt/anchor/.optiwork/testnet /opt/anchor/services/algorand-executor/generated-credentials'

scp .optiwork/testnet/algorand-deployment.json \
  DEPLOY_USER@DROPLET_IP:/opt/anchor/.optiwork/testnet/algorand-deployment.json

scp services/algorand-executor/generated-credentials/testnet-accounts.json \
  DEPLOY_USER@DROPLET_IP:/opt/anchor/services/algorand-executor/generated-credentials/testnet-accounts.json

ssh DEPLOY_USER@DROPLET_IP 'chmod 600 /opt/anchor/.optiwork/testnet/algorand-deployment.json /opt/anchor/services/algorand-executor/generated-credentials/testnet-accounts.json'
```

Do not transfer generated environment files or Fabric identities. The hosted
script creates a new permit keypair, executor bearer token, Fabric CA secrets,
MSPs and TLS identities on the Droplet.

## 5. Configure DNS

Create an `A` record from the hostname in `ANCHOR_DOMAIN` to the Droplet's
public IPv4 address. Add an `AAAA` record only after verifying IPv6 routing.
Wait until the record resolves from a public resolver:

```bash
getent ahosts demo.example.com
```

Caddy obtains and renews the public certificate automatically after DNS and
ports 80/443 are working.

## 6. Validate and start

Run preflight first. It validates architecture, Node/Docker versions, file
permissions, required secrets, the pinned application/asset and Compose
configuration without printing secret values.

```bash
cd /opt/anchor
corepack pnpm hosted:preflight
corepack pnpm hosted:up
corepack pnpm hosted:status
```

Open `https://YOUR_DOMAIN`, enter the Caddy demo credentials, and execute one
small complete milestone journey. Use faucet-sized amounts only.

Useful operations:

```bash
corepack pnpm hosted:logs
bash scripts/hosted.sh logs api
bash scripts/hosted.sh logs algorand-executor
corepack pnpm hosted:backup
corepack pnpm hosted:down
```

`hosted:down` retains MinIO, Caddy and Fabric data. There is intentionally no
hosted reset command.

## 7. Acceptance gate

Before sharing the URL with judges, verify all of the following:

1. `hosted:status` reports healthy application services and committed Fabric
   chaincode.
2. `https://DOMAIN/healthz` returns `healthy` over a valid certificate.
3. The site requires the Caddy demo credentials.
4. Ports other than 22, 80 and 443 are unreachable from another machine.
5. Company onboarding, job creation, proposal, selection and bilateral terms
   work.
6. Compliance and FX records include source and observation timestamps.
7. Each selected milestone creates an independently bound escrow allocation.
8. MinIO retains the deliverable while Fabric stores only its evidence hash.
9. Approval produces a confirmed TestNet transaction and settlement analytics.
10. No private key, bearer token, database URI or raw identity document appears
    in browser responses, container logs or the Git worktree.

## 8. Backups and monitoring

Enable DigitalOcean Droplet backups and alerts for CPU, memory and disk usage.
Run `hosted:backup` before updates. It creates owner-only archives of MinIO,
Fabric state and the workflow projection under `.optiwork/backups` with SHA-256
checksums. Copy those archives to encrypted off-host storage; a backup left only
on the same Droplet is not disaster recovery.

Supabase backups remain separate from the Droplet backup. Confirm the database
project's backup and point-in-time-recovery policy in the Supabase dashboard.

## Deployment boundary

The hosted profile deliberately places basic authentication in front of the
entire experience because the current workflow uses demo principals internally.
Do not remove that gate until Keycloak/OIDC is configured and the Gateway and
executor use hosted service credentials rather than demo authentication.
