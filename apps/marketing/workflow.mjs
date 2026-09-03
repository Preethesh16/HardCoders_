// Server-side driver for Anchor's role-aware, real-ledger demonstration.
// The browser submits only human decisions. Advisory and operational work runs
// as observable background stages, while party tokens and signing material stay
// on the server.

import { readFileSync, renameSync, writeFileSync } from "node:fs";

const API_BASE_URL = process.env.OPTIWORK_API_BASE_URL ?? "http://127.0.0.1:4000";
const STATE_FILE = process.env.ANCHOR_WORKFLOW_STATE_FILE ?? "/tmp/anchor-workflow-state.json";
const DEFAULT_PLN = { amountMinor: "1200000", currency: "PLN", scale: 2 };
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const OPERATOR = Buffer.from(JSON.stringify({
  subject: "USER-PLATFORM-ADMIN",
  organizationId: "ORG-OPTIWORK-ADMIN",
  roles: ["platform_admin", "audit_service", "compliance_service"],
  displayName: "Platform administrator"
}), "utf8").toString("base64url");

const ACTIONS = [
  { id: "job", actor: "COMPANY", label: "CREATE JOB", detail: "Publish requirements, skills, budget and destination." },
  { id: "apply", actor: "FREELANCER", label: "SUBMIT PROPOSAL", detail: "Propose an approach, exact price, availability and delivery time." },
  { id: "select", actor: "COMPANY", label: "SELECT FREELANCER", detail: "Review the agent-ranked proposals and make the final human choice." },
  { id: "terms", actor: "COMPANY", label: "DEFINE AGREEMENT", detail: "Supply policies, legal clauses and acceptance criteria, then approve the document hash." },
  { id: "agreement-approve", actor: "FREELANCER", label: "APPROVE AGREEMENT", detail: "The selected freelancer accepts the exact same private agreement." },
  { id: "submit", actor: "FREELANCER", label: "DELIVER WORK", detail: "Upload any deliverable; MinIO stores bytes and Fabric receives only SHA-256 evidence." },
  { id: "approve-work", actor: "COMPANY", label: "APPROVE DELIVERY", detail: "Review the real file and advisory validation before authorizing release." }
];

const COMPETING_PROPOSALS = [
  {
    coverLetter: "I build TypeScript services and operational dashboards, with experience documenting payment workflows.",
    approach: "Model settlement events first, implement reconciliation checks, then add unit and restart-recovery tests.",
    proposedPrice: { amountMinor: "1160000", currency: "PLN", scale: 2 },
    deliveryDays: 18,
    availability: "Available to begin in five business days",
    proposedSkills: ["typescript", "fabric", "reconciliation"]
  },
  {
    coverLetter: "I specialise in PostgreSQL ledgers, TypeScript APIs and exception queues for cross-border reconciliation.",
    approach: "Deliver schema and invariants, build the comparison worker, then prove exceptions and balancing in integration tests.",
    proposedPrice: { amountMinor: "1250000", currency: "PLN", scale: 2 },
    deliveryDays: 14,
    availability: "Available immediately for 30 hours per week",
    proposedSkills: ["typescript", "postgresql", "algorand"]
  }
];

function loadPersistedRun() {
  try {
    const candidate = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    if (candidate && typeof candidate === "object" && typeof candidate.startedAt === "string" && typeof candidate.nonce === "string") return candidate;
  } catch {
    // A missing or invalid local cursor must never prevent the real services from starting.
  }
  return null;
}

function persistRun() {
  if (!run) return;
  const temporary = `${STATE_FILE}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(run)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, STATE_FILE);
}

let run = loadPersistedRun();
let parties = null;
let automationPromise = null;
let validationPromise = null;
let releasePromise = null;

function freshRun() {
  return {
    startedAt: new Date().toISOString(), nonce: Date.now().toString(36), phase: "JOB_DRAFT",
    results: { applications: [] }, actions: {}, screening: { status: "IDLE", stages: {} },
    automation: { status: "IDLE", stages: {} }, deliveryAutomation: { status: "IDLE", stages: {} }
  };
}

function stageSet(group, id, status, detail = "", facts = []) {
  if (run?.[group]) {
    run[group].stages[id] = { status, detail, facts, updatedAt: new Date().toISOString() };
    persistRun();
  }
}

async function loadParties({ refresh = false } = {}) {
  if (parties && !refresh) return parties;
  const response = await fetch(new URL("/v1/demo/principals", API_BASE_URL), {
    headers: { accept: "application/json", authorization: `Bearer ${OPERATOR}` }
  });
  if (!response.ok) throw new Error(`Could not load demo principals (HTTP ${response.status}).`);
  const body = await response.json();
  parties = Object.fromEntries(body.parties.map(party => [party.key, party]));
  return parties;
}

async function call(partyKey, method, path, body, suffix) {
  const party = (await loadParties())[partyKey];
  if (!party) throw new Error(`Unknown demo party "${partyKey}".`);
  const headers = { accept: "application/json", authorization: `Bearer ${party.token}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET") headers["idempotency-key"] = `ui-${run.nonce}-${suffix}`;
  const response = await fetch(new URL(path, API_BASE_URL), {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
  if (!response.ok) throw new Error(parsed?.error?.message ?? parsed?.message ?? `HTTP ${response.status}`);
  return parsed;
}

function selectedApplication() {
  return run?.results?.applications?.find(application => application.id === run.results.selectedApplicationId);
}

function selectedPartyKey() {
  const selected = selectedApplication();
  if (!selected) throw new Error("No freelancer has been selected.");
  const found = Object.entries(parties ?? {}).find(([, party]) => party.principal?.subject === selected.applicantUserId);
  if (!found) throw new Error("The selected freelancer identity is unavailable.");
  return found[0];
}

function proposalMoney(application) {
  if (application?.proposedPrice && typeof application.proposedPrice === "object") return application.proposedPrice;
  if (application?.proposedPriceMinor) return {
    amountMinor: application.proposedPriceMinor,
    currency: application.proposedPriceCurrency ?? "PLN",
    scale: application.proposedPriceScale ?? 2
  };
  return run.results.budget ?? DEFAULT_PLN;
}

function normalizeApplications(payload) {
  const rows = payload?.ranking ?? payload?.applications ?? payload ?? [];
  if (!Array.isArray(rows)) return [];
  return rows.map((row, index) => {
    const id = row.id ?? row.applicationId;
    const previous = run?.results?.applications?.find(application => application.id === id) ?? {};
    const price = row.proposal?.price;
    return {
      ...previous,
      ...row,
      id,
      rank: row.rank ?? index + 1,
      applicantDisplayName: row.applicantDisplayName ?? row.applicant?.label ?? previous.applicantDisplayName,
      proposedPriceMinor: row.proposedPriceMinor ?? row.proposedAmountMinor ?? price?.amountMinor ?? previous.proposedPriceMinor,
      proposedPriceCurrency: row.proposedPriceCurrency ?? row.proposedCurrency ?? price?.currency ?? previous.proposedPriceCurrency,
      proposedPriceScale: row.proposedPriceScale ?? row.proposedScale ?? price?.scale ?? previous.proposedPriceScale,
      deliveryDays: row.deliveryDays ?? row.proposal?.deliveryDays ?? previous.deliveryDays,
      availability: row.availability ?? row.proposal?.availability ?? previous.availability,
      approach: row.approach ?? row.proposal?.approach ?? previous.approach,
      evaluation: row.evaluation ?? (row.score === undefined ? previous.evaluation : {
        score: row.score,
        summary: row.summary,
        source: row.source,
        advisoryOnly: row.advisoryOnly,
      }),
    };
  });
}

function termList(value) {
  if (Array.isArray(value)) return value.map(item => String(item).trim()).filter(Boolean);
  return String(value ?? "").split(/\r?\n|;/u).map(item => item.replace(/^[-*]\s*/u, "").trim()).filter(Boolean);
}

async function refreshApplications() {
  run.results.applications = normalizeApplications(await call("polishCompany", "GET", `/v1/jobs/${run.results.jobId}/applications`));
  return run.results.applications;
}

async function seedCompetingApplications() {
  const all = await loadParties({ refresh: true });
  const freelancers = Object.entries(all).filter(([, party]) => party?.principal?.roles?.includes("freelancer"));
  const competitors = freelancers.filter(([key]) => key !== "indianFreelancer").slice(0, 2);
  for (const [index, [key]] of competitors.entries()) {
    if (COMPETING_PROPOSALS[index]) await call(key, "POST", `/v1/jobs/${run.results.jobId}/applications`, COMPETING_PROPOSALS[index], `seed-${key}`);
  }
  await refreshApplications();
}

async function runScreening(nonce) {
  if (!run || run.nonce !== nonce || run.screening.status === "RUNNING") return;
  run.screening.status = "RUNNING";
  stageSet("screening", "collect", "RUNNING", "Collecting all submitted proposals.");
  try {
    await wait(650);
    if (!run || run.nonce !== nonce) return;
    await refreshApplications();
    stageSet("screening", "collect", "COMPLETED", `${run.results.applications.length} proposals collected.`);
    stageSet("screening", "rank", "RUNNING", "Screening agent is comparing price, timing, skills and approach.");
    const ranked = await call("polishCompany", "POST", `/v1/jobs/${run.results.jobId}/applications/rank`, {}, "rank-all");
    if (!run || run.nonce !== nonce) return;
    run.results.applications = normalizeApplications(ranked);
    stageSet("screening", "rank", "COMPLETED", "Advisory ranking persisted; company retains the final choice.");
    run.screening.status = "COMPLETED";
    run.phase = "COMPANY_SELECTION";
  } catch (error) {
    if (!run || run.nonce !== nonce) return;
    run.screening.status = "FAILED";
    stageSet("screening", "rank", "FAILED", String(error.message ?? error));
  }
}

function usdc(minor, scale = 6) {
  return `$${(Number(minor) / 10 ** Number(scale)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })} USDC`;
}

async function runFundingAutomation(nonce) {
  if (!run || run.nonce !== nonce || run.automation.status === "RUNNING") return;
  run.automation.status = "RUNNING";
  run.phase = "AUTOMATING_ESCROW";
  try {
    stageSet("automation", "agreement", "COMPLETED", "Both parties approved the same agreement hash.", [["HASH", run.results.contractHash]]);
    stageSet("automation", "documents", "RUNNING", "Preparing required commercial evidence.");
    for (const code of ["INVOICE", "SERVICE_EXPORT_DECLARATION"]) {
      await call(selectedPartyKey(), "POST", `/v1/contracts/${run.results.contractId}/documents`, {
        code, contentType: "application/pdf",
        contentBase64: Buffer.from(`ANCHOR DEMONSTRATION ONLY\n${code}\nAGREEMENT ${run.results.contractHash}`, "utf8").toString("base64")
      }, `auto-document-${code}`);
    }
    stageSet("automation", "documents", "COMPLETED", "Document hashes stored; private bytes remain in MinIO.");
    await wait(700);
    stageSet("automation", "rules", "RUNNING", "Checking the reviewed corpus against official sources.");
    const regulation = await call("polishCompany", "POST", `/v1/contracts/${run.results.contractId}/regulations/refresh`, {}, "auto-regulations");
    if (!run || run.nonce !== nonce) return;
    run.results.regulation = regulation;
    const observations = regulation.report?.observations ?? [];
    stageSet("automation", "rules", regulation.report?.requiresHumanReview ? "REVIEW" : "COMPLETED", regulation.explanation?.summary ?? "Reviewed regulation corpus checked.", [
      ["CORPUS", regulation.report?.approvedCorpusHash ?? "—"],
      ["UNCHANGED", String(observations.filter(item => item.status === "UNCHANGED").length)],
      ["REVIEW", String(observations.filter(item => item.status === "REVIEW_REQUIRED").length)],
      ["UNAVAILABLE", String(observations.filter(item => item.status === "UNAVAILABLE").length)],
      ["RULES CHANGED", regulation.report?.rulesChanged ? "YES" : "NO"]
    ]);
    stageSet("automation", "fx", "RUNNING", "Resolving corridor, compliance and a live two-leg FX quote.");
    const created = await call("polishCompany", "POST", "/v1/payments", {
      contractId: run.results.contractId, fundingAmount: run.results.contractAmount
    }, "auto-payment");
    if (!run || run.nonce !== nonce) return;
    run.results.payment = created.payment ?? created;
    run.results.paymentId = run.results.payment.id;
    run.results.quote = created.quote;
    run.results.compliance = created.compliance;
    stageSet("automation", "rules", regulation.report?.requiresHumanReview ? "REVIEW" : "COMPLETED", regulation.explanation?.summary ?? "Reviewed regulation corpus checked.", [
      ["RULESET", created.compliance?.rulesVersion ?? "—"], ["CORPUS", regulation.report?.approvedCorpusHash ?? "—"]
    ]);
    stageSet("automation", "fx", "COMPLETED", "Quote stored and bound to this payment.", [
      ["SOURCE", created.quote?.rateSource ?? "—"], ["OBSERVED", created.quote?.rateObservedAt ?? "—"], ["EXPIRES", created.quote?.expiresAt ?? "—"]
    ]);
    await wait(700);
    stageSet("automation", "escrow", "RUNNING", "Locking the quote-fixed USD amount in ARC-4 escrow.");
    const funded = await call("polishCompany", "POST", `/v1/payments/${run.results.paymentId}/fund`, {}, "auto-fund");
    run.results.payment = funded.payment ?? funded;
    const timeline = await call("polishCompany", "GET", `/v1/payments/${run.results.paymentId}/timeline`);
    run.results.binding = timeline.binding;
    stageSet("automation", "escrow", "COMPLETED", "Algorand confirmed the funded escrow.", [
      ["DEAL", timeline.binding?.dealId ?? "—"], ["LOCKED", timeline.binding ? usdc(timeline.binding.amountUsdcMinor, timeline.binding.scale) : "—"], ["NETWORK", timeline.binding?.network ?? "—"]
    ]);
    run.automation.status = "COMPLETED";
    run.phase = "AWAITING_DELIVERY";
  } catch (error) {
    if (!run || run.nonce !== nonce) return;
    run.automation.status = "FAILED";
    run.automation.error = String(error.message ?? error);
    const active = Object.entries(run.automation.stages).find(([, value]) => value.status === "RUNNING")?.[0] ?? "escrow";
    stageSet("automation", active, "FAILED", run.automation.error);
    run.phase = "AUTOMATION_FAILED";
  }
}

async function runDeliveryValidation(nonce) {
  if (!run || run.nonce !== nonce) return;
  run.deliveryAutomation.status = "RUNNING";
  stageSet("deliveryAutomation", "fabric", "COMPLETED", "Submission hash and version committed to Fabric.", [
    ["EVIDENCE", run.results.submission?.evidenceId ?? "—"], ["FILE HASH", run.results.submission?.fileHash ?? "—"]
  ]);
  stageSet("deliveryAutomation", "validation", "RUNNING", "Advisory agent is checking delivery metadata against the milestone.");
  try {
    await wait(700);
    const evaluated = await call("polishCompany", "POST", `/v1/submissions/${run.results.submissionId}/evaluate`, {}, "auto-validate");
    if (!run || run.nonce !== nonce) return;
    run.results.workValidation = evaluated.advisory ?? evaluated;
    stageSet("deliveryAutomation", "validation", "COMPLETED", run.results.workValidation.summary, [
      ["SCORE", `${run.results.workValidation.score}/100`], ["SOURCE", run.results.workValidation.source], ["ADVISORY", "YES"]
    ]);
    run.deliveryAutomation.status = "COMPLETED";
    run.phase = "AWAITING_WORK_APPROVAL";
  } catch (error) {
    if (!run || run.nonce !== nonce) return;
    run.deliveryAutomation.status = "FAILED";
    stageSet("deliveryAutomation", "validation", "FAILED", String(error.message ?? error));
    run.phase = "VALIDATION_FAILED";
  } finally { validationPromise = null; }
}

async function runRelease(nonce) {
  if (!run || run.nonce !== nonce) return;
  run.deliveryAutomation.status = "RUNNING";
  stageSet("deliveryAutomation", "release", "RUNNING", "Verifying Fabric approval and releasing the quote-fixed escrow amount.");
  try {
    await wait(700);
    const released = await call("polishCompany", "POST", `/v1/payments/${run.results.paymentId}/release`, {}, "auto-release");
    if (!run || run.nonce !== nonce) return;
    run.results.payment = released.payment ?? released;
    const timeline = await call("polishCompany", "GET", `/v1/payments/${run.results.paymentId}/timeline`);
    run.results.binding = timeline.binding;
    stageSet("deliveryAutomation", "release", "COMPLETED", "Provider settlement and INR credit completed.", [
      ["PAYMENT", run.results.payment.state], ["ESCROW", timeline.binding?.state ?? "—"], ["EVENTS", String(timeline.events?.length ?? 0)]
    ]);
    run.deliveryAutomation.status = "COMPLETED";
    run.phase = "COMPLETED";
  } catch (error) {
    if (!run || run.nonce !== nonce) return;
    run.deliveryAutomation.status = "FAILED";
    stageSet("deliveryAutomation", "release", "FAILED", String(error.message ?? error));
    run.phase = "RELEASE_FAILED";
  } finally { releasePromise = null; }
}

const EXECUTORS = {
  async job(input) {
    if (run.phase !== "JOB_DRAFT") throw new Error("A job already exists for this deal.");
    const created = await call("polishCompany", "POST", "/v1/jobs", {
      title: input.title, description: input.description, skills: input.skills,
      acceptanceCriteria: termList(input.acceptanceCriteria),
      targetDeliveryDate: input.deliveryDate,
      destinationCountry: "IN", budget: input.budget
    }, "job");
    const job = created.job ?? created;
    run.results.job = job;
    run.results.jobId = job.id;
    run.results.budget = { amountMinor: job.budgetAmountMinor, currency: job.budgetCurrency, scale: job.budgetScale };
    run.phase = "APPLICATIONS_OPEN";
    await seedCompetingApplications();
    return [["JOB", job.id], ["STATUS", job.status], ["EARLY PROPOSALS", String(run.results.applications.length)]];
  },
  async apply(input) {
    if (run.phase !== "APPLICATIONS_OPEN") throw new Error("This opportunity is not accepting proposals.");
    const created = await call("indianFreelancer", "POST", `/v1/jobs/${run.results.jobId}/applications`, input, "primary-apply");
    run.results.primaryApplicationId = (created.application ?? created).id;
    await refreshApplications();
    run.phase = "SCREENING";
    automationPromise = runScreening(run.nonce).finally(() => { automationPromise = null; });
    return [["APPLICATION", run.results.primaryApplicationId], ["PROPOSALS", String(run.results.applications.length)], ["NEXT", "AUTOMATIC SCREENING"]];
  },
  async select(input) {
    if (run.screening.status !== "COMPLETED") throw new Error("Wait for the screening agent to finish ranking every proposal.");
    const application = run.results.applications.find(item => item.id === input.applicationId);
    if (!application) throw new Error("Choose one of the ranked proposals.");
    const amount = proposalMoney(application);
    const selected = await call("polishCompany", "POST", `/v1/applications/${application.id}/select`, { amount }, "select");
    const contract = selected.contract ?? selected;
    run.results.selectedApplicationId = application.id;
    run.results.contract = contract;
    run.results.contractId = contract.id;
    run.results.contractHash = contract.contractHash;
    run.results.contractAmount = amount;
    run.phase = "AGREEMENT_DRAFT";
    return [["SELECTED", application.applicantDisplayName ?? application.applicantUserId], ["CONTRACT", contract.id], ["PRICE", `${amount.amountMinor} ${amount.currency} minor`]];
  },
  async terms(input) {
    if (run.phase !== "AGREEMENT_DRAFT") throw new Error("Select a freelancer before preparing the agreement.");
    const generated = await call("polishCompany", "POST", `/v1/contracts/${run.results.contractId}/agreement`, {
      policies: termList(input.policies),
      legalClauses: termList(input.legalClauses),
      acceptanceCriteria: termList(input.acceptanceCriteria),
      commercialTerms: termList(input.commercialTerms),
    }, "agreement");
    const agreement = {
      ...(generated.agreement ?? generated),
      terms: generated.contract?.agreementTerms,
      policies: generated.contract?.agreementTerms?.policies,
      legalClauses: generated.contract?.agreementTerms?.legalClauses,
      acceptanceCriteria: generated.contract?.agreementTerms?.acceptanceCriteria,
      commercialTerms: generated.contract?.agreementTerms?.commercialTerms,
      byteLength: generated.agreement?.byteLength,
    };
    run.results.agreement = agreement;
    run.results.contract = generated.contract ?? run.results.contract;
    run.results.contractHash = generated.contract?.contractHash ?? agreement.contractHash ?? agreement.agreementHash;
    if (!run.results.contractHash) throw new Error("The agreement service returned no binding hash.");
    const approved = await call("polishCompany", "POST", `/v1/contracts/${run.results.contractId}/approve`, {
      party: "BUYER", acceptedTermsHash: run.results.contractHash
    }, "approve-company-agreement");
    run.results.approvals = approved.approvals;
    run.phase = "AWAITING_FREELANCER_AGREEMENT";
    return [["DOCUMENT", agreement.fileName ?? "anchor-work-agreement.md"], ["SHA-256", agreement.artifactHash ?? agreement.documentHash ?? agreement.sha256], ["TERMS HASH", run.results.contractHash], ["COMPANY", "APPROVED"]];
  },
  async "agreement-approve"() {
    if (run.phase !== "AWAITING_FREELANCER_AGREEMENT") throw new Error("The agreement is not ready for freelancer approval.");
    const access = await call(selectedPartyKey(), "GET", `/v1/contracts/${run.results.contractId}/agreement/access`);
    const approved = await call(selectedPartyKey(), "POST", `/v1/contracts/${run.results.contractId}/approve`, {
      party: "PROVIDER", acceptedTermsHash: run.results.contractHash
    }, "approve-freelancer-agreement");
    run.results.approvals = approved.approvals;
    run.results.agreementAccess = {
      fileName: access.fileName, contentType: access.contentType, byteLength: access.byteLength,
      sha256: access.artifactHash ?? access.sha256 ?? access.documentHash, expiresAt: access.expiresAt
    };
    automationPromise = runFundingAutomation(run.nonce).finally(() => { automationPromise = null; });
    return [["FREELANCER", "APPROVED"], ["HASH", run.results.contractHash], ["NEXT", "AUTOMATIC RULES + FX + ESCROW"]];
  },
  async submit(input) {
    if (run.phase !== "AWAITING_DELIVERY") throw new Error("Wait until the escrow has been funded.");
    const created = await call(selectedPartyKey(), "POST", `/v1/contracts/${run.results.contractId}/submissions`, input, "deliverable");
    const submission = created.submission ?? created;
    run.results.submission = submission;
    run.results.submissionId = submission.id;
    run.phase = "VALIDATING_DELIVERY";
    validationPromise = runDeliveryValidation(run.nonce);
    return [["SUBMISSION", submission.id], ["FILE", input.fileName], ["SHA-256", submission.fileHash], ["NEXT", "AUTOMATIC VALIDATION"]];
  },
  async "approve-work"(input) {
    if (run.phase !== "AWAITING_WORK_APPROVAL") throw new Error("Wait for advisory delivery validation to finish.");
    const decided = await call("polishCompany", "POST", `/v1/submissions/${run.results.submissionId}/approve`, {
      decision: input.decision ?? "APPROVED", comment: input.comment ?? "Reviewed against the private agreement and accepted."
    }, "approve-work");
    run.results.submission = decided.submission ?? run.results.submission;
    run.results.fabricDecisionTxId = decided.fabricTxId;
    run.phase = "RELEASING";
    releasePromise = runRelease(run.nonce);
    return [["DECISION", input.decision ?? "APPROVED"], ["FABRIC TX", decided.fabricTxId], ["NEXT", "AUTOMATIC RELEASE"]];
  }
};

export function stepList() { return ACTIONS.map((action, index) => ({ index, ...action })); }

export function resetRun() {
  run = freshRun();
  automationPromise = validationPromise = releasePromise = null;
  persistRun();
  return { ok: true, startedAt: run.startedAt };
}

export async function runAction(id, input = {}) {
  if (!run) {
    run = freshRun();
    persistRun();
  }
  const action = ACTIONS.find(item => item.id === id);
  const execute = EXECUTORS[id];
  if (!action || !execute) return { ok: false, id, error: `Unknown workflow action ${id}.` };
  if (run.actions[id]?.status === "DONE") return { ok: true, id, replay: true, facts: run.actions[id].facts };
  run.actions[id] = { status: "RUNNING", startedAt: new Date().toISOString() };
  persistRun();
  try {
    const facts = await execute(input);
    run.actions[id] = { status: "DONE", facts, completedAt: new Date().toISOString() };
    persistRun();
    return { ok: true, id, label: action.label, actor: action.actor, facts };
  } catch (error) {
    run.actions[id] = { status: "FAILED", error: String(error.message ?? error), failedAt: new Date().toISOString() };
    persistRun();
    return { ok: false, id, label: action.label, actor: action.actor, error: String(error.message ?? error) };
  }
}

export async function runStep(index, input = {}) {
  const action = ACTIONS[index];
  return action ? runAction(action.id, input) : { ok: false, error: `No workflow action at index ${index}.` };
}

export async function agreementAccess(role) {
  if (!run?.results?.contractId) throw new Error("No agreement is available.");
  return call(role === "freelancer" ? selectedPartyKey() : "polishCompany", "GET", `/v1/contracts/${run.results.contractId}/agreement/access`);
}

export async function submissionAccess() {
  if (!run?.results?.submissionId) throw new Error("No deliverable is available.");
  return call("polishCompany", "GET", `/v1/submissions/${run.results.submissionId}/access`);
}

export function currentRun() {
  if (!run) return null;
  persistRun();
  return {
    startedAt: run.startedAt, phase: run.phase, results: run.results, actions: run.actions,
    screening: run.screening, automation: run.automation, deliveryAutomation: run.deliveryAutomation
  };
}
