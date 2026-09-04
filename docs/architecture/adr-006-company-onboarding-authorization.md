# ADR-006: Separate company verification from representative authorization

## Status

Accepted for the local demonstration.

## Context

A public company register can establish that a legal entity exists, but it
cannot prove that the person holding the current web session is permitted to
bind that entity. Treating registry existence as login authorization would
collapse two different trust decisions and create a direct tenant takeover
risk.

## Decision

The Company login executes a bounded Authorization Agent before the workspace
opens:

1. Extract submitted onboarding fields as a reviewable draft. Extraction never
   submits, verifies or authorizes.
2. Match legal name, jurisdiction and registration number against a public
   registry record; match the supplied LEI through GLEIF when present.
3. Collect public officers and persons with significant control and screen the
   entity and related names against the UK, UN, EU and OFAC official sources.
4. Independently require an authenticated `company_member` membership for the
   exact tenant and a recorded representative mandate.
5. Persist the source snapshots, check results, expiry and canonical decision
   hash in PostgreSQL. Put no identity data on Fabric or Algorand.
6. Open the Company workspace only for an `AUTHORIZED` decision. In a
   non-demo profile, an unavailable sanctions source produces
   `REVIEW_REQUIRED`; it does not fail open.

The public sample is WISE PAYMENTS LIMITED (Companies House `07209813`, LEI
`213800U4GNTXRFYZKG18`). It demonstrates live public-data connectors only. The
project is not affiliated with the company and the displayed representative
mandate is fictional.

## Consequences

- Registry verification and user authorization remain independently testable.
- The Company policy vault stays a post-login, reusable business-policy step;
  it is not mixed into legal-entity identity.
- Public-source availability and ambiguous screening matches can stop access
  without letting an AI model grant authority.
- Real deployment still requires licensed KYC/KYB, authoritative mandate
  evidence, ongoing rescreening and human escalation procedures.
