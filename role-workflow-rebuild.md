# Anchor Role Workflow Rebuild

## Goal

Replace the shared 14-step presentation with genuinely different company and
freelancer workspaces while keeping one authoritative PostgreSQL/Fabric/
Algorand workflow.

## Product contract

- The company creates an empty job form, sees several independently submitted
  proposals, receives an advisory ranked shortlist, and explicitly selects one
  freelancer.
- The freelancer sees an opportunity feed, applies with proposed price,
  delivery estimate, availability, cover letter and approach, and never sees a
  company-only "post job" stage.
- After selection, the company supplies policies, legal clauses, acceptance
  criteria and commercial terms. The selected freelancer reviews the exact
  generated agreement and accepts the same hash.
- The agreement source document is private in MinIO. Its canonical hash and
  access grant are visible to only the two contract parties. The agreement
  hash is bound into the Algorand escrow commitment; Fabric remains limited to
  work evidence and buyer decisions. Neither ledger receives raw text or PII.
- Following bilateral agreement, the compliance/rule refresh, live FX quote,
  payment creation and Algorand escrow funding run as an observable server-side
  pipeline. They are not separate fake buttons.
- The settlement amount is fixed from the accepted, unexpired FX quote before
  funding; later rate movement cannot change the already funded USDC amount.
- The selected freelancer may upload any file type. Bytes go to MinIO, SHA-256
  goes to Fabric, and only the expected buyer may obtain access.
- AI ranking, agreement drafting, regulation-change explanation and work
  validation are advisory. Humans still select the freelancer, accept terms
  and approve work; an approved Fabric decision then authorizes automatic
  release.

## Workstreams

1. Backend/domain: richer applications, multiple demo freelancers, agreement
   terms/artifact/access, orchestration status, persistence and tests.
2. Regulation/RAG: official source corpus, version/hash metadata, safe refresh
   adapter, change detection, citations and deterministic fallback.
3. Product UI: separate company hiring workspace and freelancer opportunity /
   application / delivery workspace, non-clickable automated pipeline, smooth
   progress presentation and contextual errors.
4. Integration owner: reconcile interfaces, preserve Fabric/Algorand security,
   verify all packages, run real LocalNet acceptance and restore a fresh manual
   workspace.

## Acceptance criteria

- Freelancer UI contains no job-posting form or company-only stage rail.
- Company job fields start blank and require user input.
- At least three freelancer proposals with distinct price/time/skills are
  visible; the agent ranks all and a company human selects one.
- Proposal price and delivery estimate flow into negotiated terms.
- Company enters policies/legal/acceptance information; the generated agreement
  can be viewed by both selected parties and reports a stable SHA-256 hash.
- Unselected freelancers and unrelated company identities cannot access the
  agreement or deliverable.
- Bilateral approval automatically runs rule refresh, compliance, FX quote,
  payment creation and real Algorand LocalNet funding with visible progress.
- The funded USDC amount remains the stored quote amount.
- Deliverable upload accepts arbitrary MIME types, stores bytes in MinIO and
  records matching Fabric evidence.
- Existing Fabric authorization, Algorand permit, idempotency, privacy and
  double-entry invariants continue to pass.
- Browser acceptance covers both role views and ends with a completed real
  LocalNet payout.

## Non-goals

- Mainnet or real-money execution.
- Production legal advice or autonomous compliance approval.
- Automatically mutating approved rules based on unreviewed web content.
- Exposing blockchain keys, private object keys or PII in the browser/ledgers.
