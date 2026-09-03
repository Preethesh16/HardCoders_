// Server-side driver for the real OptiWork workflow.
//
// This runs the same HTTP routes apps/api exposes, in the same order and as
// the same principals as apps/api/src/demo/walkthrough.ts does internally —
// but one step at a time, so the pixel-art portal can execute a stage, show
// the real response, and move on. Every step is a live call that writes to the
// business ledger, Fabric evidence and Algorand escrow; the surrounding fiat,
// AI and FX demo adapters remain deterministic fixtures by design.
//
// Party tokens stay in this process. The browser addresses steps by index and
// never sees a bearer token, matching the boundary apps/web/lib/api.ts keeps.

const API_BASE_URL = process.env.OPTIWORK_API_BASE_URL ?? "http://127.0.0.1:4000";

const OPERATOR = Buffer.from(JSON.stringify({
  subject: "USER-PLATFORM-ADMIN",
  organizationId: "ORG-OPTIWORK-ADMIN",
  roles: ["platform_admin", "audit_service", "compliance_service"],
  displayName: "Platform administrator"
}), "utf8").toString("base64url");

const PLN = { amountMinor: "1200000", currency: "PLN", scale: 2 };

// One run's accumulated identifiers. Steps read what earlier steps produced,
// exactly as the scripted walkthrough does.
let run = null;
let parties = null;

function freshRun() {
  return { startedAt: new Date().toISOString(), nonce: Date.now().toString(36), results: {} };
}

function usdc(minor, scale) {
  const value = Number(minor) / 10 ** Number(scale ?? 6);
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC`;
}

async function loadParties() {
  if (parties) return parties;
  const res = await fetch(new URL("/v1/demo/principals", API_BASE_URL), {
    headers: { accept: "application/json", authorization: `Bearer ${OPERATOR}` }
  });
  if (!res.ok) throw new Error(`Could not load demo principals (HTTP ${res.status}).`);
  const body = await res.json();
  parties = Object.fromEntries(body.parties.map(p => [p.key, p]));
  return parties;
}

async function call(partyKey, method, path, body, idempotencySuffix) {
  const all = await loadParties();
  const party = all[partyKey];
  if (!party) throw new Error(`Unknown demo party "${partyKey}".`);
  const headers = {
    accept: "application/json",
    authorization: `Bearer ${party.token}`
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  // Every mutation route requires an Idempotency-Key. Scoping it to this run's
  // nonce means a fresh run re-executes rather than replaying a cached result.
  if (method !== "GET") headers["idempotency-key"] = `ui-${run.nonce}-${idempotencySuffix}`;

  const res = await fetch(new URL(path, API_BASE_URL), {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
  if (!res.ok) {
    const message = parsed?.error?.message ?? parsed?.message ?? `HTTP ${res.status}`;
    throw new Error(message);
  }
  return parsed;
}

// Each step: who acts, what it does, and what the UI should show afterwards.
// `run.results` carries identifiers forward between steps.
const STEPS = [
  {
    id: "job",
    label: "POST A JOB",
    actor: "POLISH COMPANY",
    detail: "Creates the work brief with scope, skills and a PLN budget.",
    async execute() {
      const out = await call("polishCompany", "POST", "/v1/jobs", {
        title: "Cross-border reconciliation service",
        description: "Build a reconciliation service that compares settlement evidence against the business ledger, with a complete test suite and an operational runbook.",
        skills: ["typescript", "postgres", "reconciliation"],
        destinationCountry: "IN",
        budget: PLN
      }, "job");
      const job = out.job ?? out;
      run.results.jobId = job.id;
      return { facts: [["JOB", job.id], ["BUDGET", "12,000.00 PLN"], ["STATUS", job.status]] };
    }
  },
  {
    id: "apply",
    label: "APPLY FOR THE WORK",
    actor: "INDIAN FREELANCER",
    detail: "The freelancer applies with a cover letter.",
    async execute() {
      const out = await call("indianFreelancer", "POST", `/v1/jobs/${run.results.jobId}/applications`, {
        coverLetter: "I have delivered typescript and postgres reconciliation services for two licensed payment providers, including ledger-to-settlement comparison and exception handling."
      }, "apply");
      const application = out.application ?? out;
      run.results.applicationId = application.id;
      return { facts: [["APPLICATION", application.id], ["STATUS", application.status ?? "SUBMITTED"]] };
    }
  },
  {
    id: "select",
    label: "EVALUATE + DRAFT CONTRACT",
    actor: "POLISH COMPANY",
    detail: "Advisory evaluation, then the human act of selecting the applicant. Drafts the contract and its hash.",
    async execute() {
      const out = await call("polishCompany", "POST", `/v1/applications/${run.results.applicationId}/evaluate`, {
        select: true,
        amount: PLN
      }, "select");
      const contract = out.contract;
      if (!contract) throw new Error("The evaluation returned no contract.");
      run.results.contractId = contract.id;
      run.results.contractHash = contract.contractHash;
      return { facts: [["CONTRACT", contract.id], ["STATE", contract.state], ["HASH", contract.contractHash]] };
    }
  },
  {
    id: "approve-buyer",
    label: "COMPANY APPROVES TERMS",
    actor: "POLISH COMPANY",
    detail: "Buyer-side approval, bound to the exact contract hash.",
    async execute() {
      await call("polishCompany", "POST", `/v1/contracts/${run.results.contractId}/approve`, {
        party: "BUYER", acceptedTermsHash: run.results.contractHash
      }, "approve-buyer");
      return { facts: [["PARTY", "BUYER"], ["BOUND TO", run.results.contractHash]] };
    }
  },
  {
    id: "approve-provider",
    label: "FREELANCER APPROVES TERMS",
    actor: "INDIAN FREELANCER",
    detail: "Provider-side approval. The contract takes effect only once both parties sign the same hash.",
    async execute() {
      const out = await call("indianFreelancer", "POST", `/v1/contracts/${run.results.contractId}/approve`, {
        party: "PROVIDER", acceptedTermsHash: run.results.contractHash
      }, "approve-provider");
      const state = out?.contract?.state ?? out?.state ?? "APPROVED";
      return { facts: [["PARTY", "PROVIDER"], ["CONTRACT STATE", state]] };
    }
  },
  {
    id: "documents",
    label: "RECORD TRADE DOCUMENTS",
    actor: "POLISH COMPANY",
    detail: "Invoice and service-export declaration, hashed and committed as evidence.",
    async execute() {
      const codes = ["INVOICE", "SERVICE_EXPORT_DECLARATION"];
      const facts = [];
      for (const code of codes) {
        const out = await call("polishCompany", "POST", `/v1/contracts/${run.results.contractId}/documents`, {
          code,
          contentType: "application/pdf",
          contentBase64: Buffer.from(`${code} (demonstration only)`, "utf8").toString("base64")
        }, `doc-${code}`);
        facts.push([code, out?.document?.id ?? out?.id ?? "RECORDED"]);
      }
      return { facts };
    }
  },
  {
    id: "payment",
    label: "RESOLVE CORRIDOR, FX + COMPLIANCE",
    actor: "POLISH COMPANY",
    detail: "Creating the payment resolves the PL→IN corridor, takes an FX quote and runs the compliance rules.",
    async execute() {
      const out = await call("polishCompany", "POST", "/v1/payments", {
        contractId: run.results.contractId,
        fundingAmount: PLN
      }, "payment");
      const payment = out.payment ?? out;
      run.results.paymentId = payment.id;
      const facts = [["PAYMENT", payment.id], ["CORRIDOR", payment.corridorId], ["STATE", payment.state]];
      if (payment.payoutAmountMinor) {
        const payout = (Number(payment.payoutAmountMinor) / 10 ** (payment.payoutScale ?? 2))
          .toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        facts.push(["PAYOUT", `₹${payout}`]);
      }
      if (out.compliance?.outcome) facts.push(["COMPLIANCE", out.compliance.outcome]);
      return { facts };
    }
  },
  {
    id: "fund",
    label: "FUND ESCROW",
    actor: "POLISH COMPANY",
    detail: "Local PLN debit, provider settlement posting, then USDC locked in Algorand escrow.",
    async execute() {
      const out = await call("polishCompany", "POST", `/v1/payments/${run.results.paymentId}/fund`, {}, "fund");
      const payment = out.payment ?? out;
      const facts = [["STATE", payment.state ?? "FUNDED"]];
      // fund() returns {payment, quote, compliance, corridor}; the escrow
      // binding is only readable from the payment's timeline.
      const timeline = await call("polishCompany", "GET", `/v1/payments/${run.results.paymentId}/timeline`);
      const binding = timeline?.binding;
      if (binding) {
        run.results.dealId = binding.dealId;
        facts.push(["ESCROW DEAL", binding.dealId]);
        facts.push(["USDC LOCKED", usdc(binding.amountUsdcMinor, binding.scale)]);
        facts.push(["NETWORK", binding.network]);
      }
      return { facts };
    }
  },
  {
    id: "submit",
    label: "SUBMIT THE WORK",
    actor: "INDIAN FREELANCER",
    detail: "The deliverable is hashed; only the hash and version go to Fabric — never the file.",
    async execute() {
      const out = await call("indianFreelancer", "POST", `/v1/contracts/${run.results.contractId}/submissions`, {
        fileName: "reconciliation-service.zip",
        contentType: "application/zip",
        contentBase64: Buffer.from("demonstration deliverable bytes", "utf8").toString("base64"),
        note: "Service, tests and runbook delivered."
      }, "submit");
      const submission = out.submission ?? out;
      run.results.submissionId = submission.id;
      return {
        facts: [
          ["SUBMISSION", submission.id],
          ["VERSION", String(submission.version ?? 1)],
          ["FILE HASH", submission.fileHash ?? "—"]
        ]
      };
    }
  },
  {
    id: "access",
    label: "GRANT REVIEW ACCESS",
    actor: "POLISH COMPANY",
    detail: "The buyer takes authorised access to the deliverable in order to review it.",
    async execute() {
      const out = await call("polishCompany", "GET", `/v1/submissions/${run.results.submissionId}/access`);
      return {
        facts: [
          ["FILE HASH", out.fileHash],
          ["SIZE", `${out.byteLength} bytes`],
          ["LINK EXPIRES IN", `${out.ttlSeconds}s`]
        ]
      };
    }
  },
  {
    id: "approve-work",
    label: "APPROVE THE WORK",
    actor: "POLISH COMPANY",
    detail: "The buyer decision is committed to Fabric and becomes the release condition.",
    async execute() {
      const out = await call("polishCompany", "POST", `/v1/submissions/${run.results.submissionId}/approve`, {
        decision: "APPROVED",
        comment: "Reviewed against the milestone and accepted."
      }, "approve-work");
      const facts = [["DECISION", "APPROVED"]];
      if (out?.fabricTxId) facts.push(["FABRIC TX", out.fabricTxId]);
      const hash = out?.submission?.buyerDecisionHash ?? out?.buyerDecisionHash;
      if (hash) facts.push(["DECISION HASH", hash]);
      return { facts };
    }
  },
  {
    id: "release",
    label: "RELEASE + PAY OUT",
    actor: "POLISH COMPANY",
    detail: "Escrow verifies the approval evidence, releases USDC, and the freelancer is credited in INR.",
    async execute() {
      const out = await call("polishCompany", "POST", `/v1/payments/${run.results.paymentId}/release`, {}, "release");
      const payment = out.payment ?? out;
      const facts = [["STATE", payment.state ?? "COMPLETED"]];
      if (payment.payoutAmountMinor) {
        const payout = (Number(payment.payoutAmountMinor) / 10 ** (payment.payoutScale ?? 2))
          .toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        facts.push(["CREDITED", `₹${payout}`]);
      }
      const timeline = await call("polishCompany", "GET", `/v1/payments/${run.results.paymentId}/timeline`);
      if (timeline?.binding?.state) facts.push(["ESCROW", timeline.binding.state]);
      facts.push(["LEDGER EVENTS", String((timeline?.events ?? []).length)]);
      return { facts };
    }
  }
];

export function stepList() {
  return STEPS.map((s, index) => ({
    index, id: s.id, label: s.label, actor: s.actor, detail: s.detail
  }));
}

export function resetRun() {
  run = freshRun();
  return { ok: true, startedAt: run.startedAt };
}

export async function runStep(index) {
  if (!run) run = freshRun();
  const step = STEPS[index];
  if (!step) return { ok: false, error: `No workflow step at index ${index}.` };
  try {
    const output = await step.execute();
    run.results[`step:${step.id}`] = "DONE";
    return { ok: true, index, id: step.id, label: step.label, actor: step.actor, facts: output.facts };
  } catch (error) {
    return { ok: false, index, id: step.id, label: step.label, actor: step.actor, error: String(error.message ?? error) };
  }
}

export function currentRun() {
  return run ? { startedAt: run.startedAt, results: run.results } : null;
}
