# OptiWork

A cross-border marketplace where the financial logic is visible. A Polish
company pays an Indian freelancer, and an Indian company pays a United Kingdom
supplier from a completely separate set of books. Both journeys run across three
ledgers, and every decision along the way is recorded with the rule, the rate
and the hash that produced it.

**This is a demonstration.** It is not a licensed remittance, payment, KYC, tax
or legal service. Every settlement asset is a zero-value test token, every fiat
balance is simulated, and no end user ever receives cryptocurrency or manages a
blockchain wallet.

Start with [the architecture plan](docs/ARCHITECTURE_PLAN.md).

## Three ledgers, one workflow

| Ledger | Holds | Never holds |
|---|---|---|
| Hyperledger Fabric | Work-evidence commitments, versions, buyer decisions | Names, files, contract text, payment state, wallet addresses |
| Algorand | Provider-to-provider escrow in zero-value test USDC | End-user identity, invoices, work files, regulatory text |
| PostgreSQL 17 | Marketplace, corridor policy, FX quotes, compliance decisions, double-entry books, reconciliation, audit | Raw signing keys |

## Run the demonstration

Node.js 24 and pnpm. Nothing else — no database, no object store, no identity
provider, no paid API key.

```sh
corepack pnpm install
corepack pnpm demo
```

Then open <http://127.0.0.1:3000> and press **Run the demonstration**. The API
executes both journeys through the same services the HTTP routes use, and the
five dashboards render the real result:

- **Polish company** — job, applications, bilateral contract approval, corridor
  decision, FX quote and fees, escrow state, remittance advice.
- **Indian freelancer** — contract terms, submitted versions, buyer decisions,
  simulated INR wallet credit.
- **India → UK supplier** — the outward book, Form A2 and import-document
  commitments, and the proof that the two books never net.
- **Provider operations** — escrow state per deal, treasury balances, confirmed
  settlement transactions with explorer links, reconciliation.
- **Administrator & audit** — every book, every compliance decision with its
  version, and the complete ordered event record per payment.

### With real infrastructure

```sh
cp infra/.env.example infra/.env
corepack pnpm infra:up          # PostgreSQL 17 + pgvector, MinIO, Keycloak, API, web
```

Profiles let you start a subset: `--profile data`, `--profile app`,
`--profile settlement`. This Compose profile uses the evidence mock by default.
The Fabric Gateway and Go chaincode are implemented and tested in this repo,
but a CA/peer/orderer test network must be started separately before selecting
`FABRIC_MODE=gateway`; it is not hidden behind the default demo command.

## Current implementation status

The API exposes the marketplace, credentials, corridor/FX/compliance,
submission, payment, supplier-payment, timeline and reconciliation routes. The
web app renders company, freelancer, supplier, provider and audit dashboards.
The offline demo runs both corridors end to end. The Fabric Gateway and
Algorand executor now share one release contract, covered by a live
cross-service integration test. Public TestNet and a real Fabric deployment are
opt-in environment profiles, not prerequisites for the offline demonstration.

## Layout

```
apps/api                  Fastify 5 + TypeBox API, Drizzle schema and migrations
apps/web                  Next.js 16 / React 19 dashboards
packages/contracts        Shared TypeBox schemas
packages/domain           Shared money, corridor, state-machine and ledger rules
services/algorand-executor  Isolated signing boundary and ARC-4 escrow
blockchain/fabric         Evidence-only Go chaincode
infra                     Docker Compose profiles, Keycloak realm, Dockerfiles
docs                      Architecture, ADRs, provenance, integration notes
```

## Guarantees the tests hold

- **Money is never a float.** Every amount is an exact integer of minor units
  carried as a string, with its currency and scale. Rounding is half-up and
  stated.
- **Inward and outward never net.** A journal line cannot reference an account
  in another book or direction — enforced in code and again by composite
  foreign keys in SQL.
- **Every mutation is idempotent.** An `Idempotency-Key` is mandatory, an exact
  replay returns the recorded response, and a reused key with a different
  request is a conflict.
- **Compliance is versioned configuration**, not conditionals in a handler. The
  RBI per-unit cap applies to both Indian directions; the import buyer
  due-diligence threshold applies only to outward payments.
- **A release is bound to everything it depends on** — the escrow, the exact
  approved Fabric work version, the Fabric approval transaction, the compliance
  decision, the FX quote, a one-time generation, the idempotency key and an
  expiry — and the executor re-reads Fabric itself before it signs.
- **No personal data reaches a ledger, a log or an AI trace.** The timeline and
  the AI adapter refuse a prohibited field rather than redacting it.

## Verification

```sh
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

The Algorand executor also has network-dependent suites that are excluded from
the default run: `pnpm --filter @optiwork/algorand-executor test:localnet`
(AlgoKit LocalNet) and `test:testnet` (public TestNet, opt-in).

## Secrets

No key, token, mnemonic or password is committed. `.env` files are ignored;
`.env.example` files document every variable by name. The demonstration works
with none of them set.
