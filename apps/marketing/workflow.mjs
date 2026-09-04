// Server-side driver for Anchor's role-aware, real-ledger demonstration.
// The browser submits only human decisions. Advisory and operational work runs
// as observable background stages, while party tokens and signing material stay
// on the server.

import { readFileSync, renameSync, writeFileSync } from "node:fs";

const API_BASE_URL = process.env.OPTIWORK_API_BASE_URL ?? "http://127.0.0.1:4000";
const STATE_FILE = process.env.ANCHOR_WORKFLOW_STATE_FILE ?? "/tmp/anchor-workflow-state.json";
const DEFAULT_PLN = { amountMinor: "1200000", currency: "PLN", scale: 2 };
const DEMO_COMPANY_PROFILES = {
  PL: { partyKey: "polishCompany", currency: "PLN", preferredTalentCountry: "IN" },
  IN: { partyKey: "indianCompany", currency: "INR", preferredTalentCountry: "GB" },
  GB: { partyKey: "ukCompany", currency: "GBP", preferredTalentCountry: "IN" },
  DE: { partyKey: "germanCompany", currency: "EUR", preferredTalentCountry: "IN" },
  RU: { partyKey: "russianCompany", currency: "RUB", preferredTalentCountry: "GB" },
  KP: { partyKey: "northKoreanCompany", currency: "KPW", preferredTalentCountry: "GB" },
};
const DEMO_PROVIDER_PROFILES = {
  PL: { partyKey: "polishFreelancer", currency: "PLN", partyType: "FREELANCER" },
  IN: { partyKey: "indianFreelancer", currency: "INR", partyType: "FREELANCER" },
  GB: { partyKey: "ukFreelancer", currency: "GBP", partyType: "FREELANCER" },
  DE: { partyKey: "germanFreelancer", currency: "EUR", partyType: "FREELANCER" },
  RU: { partyKey: "russianFreelancer", currency: "RUB", partyType: "FREELANCER" },
  KP: { partyKey: "northKoreanFreelancer", currency: "KPW", partyType: "FREELANCER" },
};
const PURPOSE_BY_ROUTE = {
  "PL-IN": "P0802",
  "IN-GB": "S0102",
  "PL-GB": "B2B_DIGITAL_SERVICES",
  "DE-PL": "B2B_DIGITAL_SERVICES",
  "PL-RU": "B2B_SERVICES",
};
const FALLBACK_DOCUMENTS_BY_ROUTE = {
  "PL-IN": ["INVOICE", "SERVICE_EXPORT_DECLARATION"],
  "IN-GB": ["INVOICE", "FORM_A2_DEMO", "TAX_REVIEW_DEMO", "IMPORT_EVIDENCE", "BUYER_DUE_DILIGENCE"],
  "PL-GB": ["INVOICE", "B2B_CUSTOMER_STATUS", "SERVICE_PLACE_OF_SUPPLY_ASSESSMENT", "PAYER_PAYEE_TRANSFER_DATA"],
};
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const OPERATOR = Buffer.from(JSON.stringify({
  subject: "USER-PLATFORM-ADMIN",
  organizationId: "ORG-OPTIWORK-ADMIN",
  roles: ["platform_admin", "audit_service", "compliance_service"],
  displayName: "Platform administrator"
}), "utf8").toString("base64url");

const PUBLIC_COMPANY_SAMPLE = {
  legalName: "WISE PAYMENTS LIMITED",
  country: "GB",
  registryAuthority: "COMPANIES_HOUSE",
  registrationNumber: "07209813",
  lei: "213800U4GNTXRFYZKG18",
  taxIdentifier: "DEMO-PRIVATE-TAX-REF",
  registeredAddress: "1st Floor, Worship Square, 65 Clifton Street, London, England, EC2A 4JE",
  directors: ["Jane Fahey"],
  beneficialOwners: [{ name: "Wise Financial Holdings Ltd", controlType: "PERSON_WITH_SIGNIFICANT_CONTROL" }],
  representativeEmail: "demo@anchor.dev",
  representativeRole: "Anchor demo contracting representative",
  authorityBasis: "Tenant administrator approved this representative for the local demonstration.",
  mandateReference: "ANCHOR-DEMO-MANDATE-GB-001",
};

const ACTIONS = [
  { id: "onboard", actor: "COMPANY", label: "APPROVE COMPANY PROFILE", detail: "Review the extracted policy profile once; its versioned hash becomes a reusable agreement source." },
  { id: "job", actor: "COMPANY", label: "CREATE JOB", detail: "Publish requirements, skills, budget, payer country and funding currency." },
  { id: "apply", actor: "FREELANCER", label: "SUBMIT PROPOSAL", detail: "Propose an approach, exact price, availability and delivery time." },
  { id: "select", actor: "COMPANY", label: "SELECT FREELANCER", detail: "Review the agent-ranked proposals and make the final human choice." },
  { id: "terms", actor: "COMPANY", label: "GENERATE AGREEMENT", detail: "Compose a sourced draft from onboarding policy, job brief and selected proposal." },
  { id: "agreement-company-approve", actor: "COMPANY", label: "APPROVE AGREEMENT", detail: "The company reviews and accepts the generated private agreement hash." },
  { id: "agreement-approve", actor: "FREELANCER", label: "APPROVE AGREEMENT", detail: "The selected freelancer accepts the exact same private agreement." },
  { id: "submit", actor: "FREELANCER", label: "DELIVER WORK", detail: "Upload any deliverable; MinIO stores bytes and Fabric receives only SHA-256 evidence." },
  { id: "approve-work", actor: "COMPANY", label: "APPROVE DELIVERY", detail: "Review the real file and advisory validation before authorizing release." }
];

const COMPETING_PROPOSALS = [
  {
    coverLetter: "I build TypeScript services and operational dashboards, with experience documenting payment workflows.",
    approach: "Model settlement events first, implement reconciliation checks, then add unit and restart-recovery tests.",
    deliveryDays: 18,
    availability: "Available to begin in five business days",
    proposedSkills: ["typescript", "fabric", "reconciliation"]
  },
  {
    coverLetter: "I specialise in PostgreSQL ledgers, TypeScript APIs and exception queues for cross-border reconciliation.",
    approach: "Deliver schema and invariants, build the comparison worker, then prove exceptions and balancing in integration tests.",
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

function freshRun(previous = null) {
  const retainedProfile = previous?.results?.companyPolicyProfile ?? null;
  const retainedCompanyPartyKey = previous?.results?.companyPartyKey ?? null;
  const retainedVerification = previous?.results?.companyVerificationProfile ?? null;
  const retainedAuthorization = previous?.results?.companyAuthorization ?? null;
  return {
    startedAt: new Date().toISOString(), nonce: Date.now().toString(36), phase: retainedProfile ? "JOB_DRAFT" : "COMPANY_ONBOARDING",
    results: { applications: [], ...(retainedProfile ? { companyPolicyProfile: retainedProfile } : {}), ...(retainedCompanyPartyKey ? { companyPartyKey: retainedCompanyPartyKey } : {}), ...(retainedVerification ? { companyVerificationProfile: retainedVerification } : {}), ...(retainedAuthorization ? { companyAuthorization: retainedAuthorization } : {}) }, actions: {}, screening: { status: "IDLE", stages: {} },
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

function companyProfile(country = run?.results?.job?.payerCountry) {
  const profile = DEMO_COMPANY_PROFILES[String(country ?? "").toUpperCase()];
  if (!profile) throw new Error(`No signed demo company identity is configured for ${country ?? "that country"}.`);
  return profile;
}

function providerProfile(country) {
  const profile = DEMO_PROVIDER_PROFILES[String(country ?? "").toUpperCase()];
  if (!profile) throw new Error(`No signed demo freelancer/provider identity is configured for ${country ?? "that country"}.`);
  return profile;
}

function companyPartyKey() {
  return run?.results?.companyPartyKey ?? companyProfile().partyKey;
}

async function authorizeJobPayerProfile(country) {
  const target = companyProfile(country);
  const source = run.results.companyPolicyProfile;
  if (!source) throw new Error("Approve the reusable company policy profile before publishing work.");
  if (source.country === country && source.fundingCurrency === target.currency) {
    run.results.companyPartyKey = target.partyKey;
    return source;
  }
  const artifact = Buffer.from(JSON.stringify({
    kind: "ANCHOR_DEMO_DERIVED_POLICY_PROFILE",
    sourceProfileHash: source.profileHash,
    sourceArtifactHash: source.sourceArtifactHash,
    targetCountry: country,
    fundingCurrency: target.currency,
    notice: "Demo-only signed payer identity switch. Corridor obligations are evaluated separately for the selected payer and payee."
  }), "utf8");
  const created = await call(target.partyKey, "POST", "/v1/company/policy-profile", {
    companyCountry: country,
    fundingCurrency: target.currency,
    fileName: `anchor-approved-policy-${country.toLowerCase()}.json`,
    contentType: "application/json",
    contentBase64: artifact.toString("base64"),
    policies: source.policies,
    legalClauses: source.legalClauses,
    commercialStandards: source.commercialStandards,
    authorizedApprovers: source.authorizedApprovers,
    extractionSource: source.extractionSource === "OPENAI" ? "OPENAI" : "FIXTURE",
    extractionModel: String(`${source.extractionModel ?? "approved-profile"}-country-derived`).slice(0, 64)
  }, `company-policy-${country.toLowerCase()}`);
  const stored = created.profile ?? created;
  const { sourceObjectId: _sourceObjectId, approvedByUserId: _approvedByUserId, ...publicProfile } = stored;
  run.results.companyPolicyProfile = publicProfile;
  run.results.companyPartyKey = target.partyKey;
  persistRun();
  return publicProfile;
}

function orderedRoute() {
  const application = selectedApplication();
  const originCountry = run?.results?.job?.payerCountry;
  const destinationCountry = application?.payoutCountry ?? application?.residenceCountry;
  if (!originCountry || !destinationCountry) throw new Error("The ordered payer-to-payee route is not complete.");
  return { originCountry, destinationCountry, key: `${originCountry}-${destinationCountry}` };
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
      residenceCountry: row.residenceCountry ?? row.proposal?.residenceCountry ?? previous.residenceCountry,
      payoutCountry: row.payoutCountry ?? row.proposal?.payoutCountry ?? previous.payoutCountry,
      payoutCurrency: row.payoutCurrency ?? row.proposal?.payoutCurrency ?? previous.payoutCurrency,
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
  run.results.applications = normalizeApplications(await call(companyPartyKey(), "GET", `/v1/jobs/${run.results.jobId}/applications`));
  return run.results.applications;
}

async function seedCompetingApplications() {
  const all = await loadParties({ refresh: true });
  const targetCountry = run.results.job.destinationCountry;
  const profile = providerProfile(targetCountry);
  const candidates = Object.entries(all).filter(([key, party]) =>
    key !== profile.partyKey
    && key.startsWith(profile.partyKey)
    && party.principal.roles?.some(role => role === "freelancer" || role === "supplier")
  ).slice(0, 2);
  for (const [index, [key]] of candidates.entries()) {
    const template = COMPETING_PROPOSALS[index];
    if (!template) continue;
    const budgetMinor = BigInt(run.results.job.budgetAmountMinor);
    const factors = [97n, 104n];
    await call(key, "POST", `/v1/jobs/${run.results.jobId}/applications`, {
      ...template,
      residenceCountry: targetCountry,
      payoutCountry: targetCountry,
      payoutCurrency: profile.currency,
      proposedPrice: {
        amountMinor: ((budgetMinor * factors[index]) / 100n).toString(),
        currency: run.results.job.fundingCurrency,
        scale: run.results.job.budgetScale,
      },
    }, `seed-${key}`);
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
    const ranked = await call(companyPartyKey(), "POST", `/v1/jobs/${run.results.jobId}/applications/rank`, {}, "rank-all");
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
    stageSet("automation", "rules", "RUNNING", "Checking the reviewed corpus against official sources.");
    const regulation = await call(companyPartyKey(), "POST", `/v1/contracts/${run.results.contractId}/regulations/refresh`, {}, "auto-regulations");
    if (!run || run.nonce !== nonce) return;
    run.results.regulation = regulation;
    run.results.regulatoryPlan = regulation.plan ?? regulation.regulatoryPlan;
    const observations = regulation.report?.observations ?? [];
    stageSet("automation", "rules", regulation.coverage?.outcome === "MANUAL_REVIEW" ? "REVIEW" : "COMPLETED", regulation.explanation?.summary ?? "Reviewed regulation corpus checked.", [
      ["CORPUS", regulation.report?.approvedCorpusHash ?? "—"],
      ["COVERAGE", regulation.coverage ? `${regulation.coverage.checks?.filter(item => item.status === "COVERED").length ?? 0}/${regulation.coverage.checks?.length ?? 0}` : "—"],
      ["UNCHANGED", String(observations.filter(item => item.status === "UNCHANGED").length)],
      ["REVIEW", String(observations.filter(item => item.status === "REVIEW_REQUIRED").length)],
      ["UNAVAILABLE", String(observations.filter(item => item.status === "UNAVAILABLE").length)],
      ["RULES CHANGED", regulation.report?.rulesChanged ? "YES" : "NO"]
    ]);
    const plan = run.results.regulatoryPlan;
    if (plan?.hardGate && !plan.hardGate.canQuoteOrFund) {
      throw new Error(`${plan.hardGate.code}: ${(plan.hardGate.reasons ?? []).join(" ") || "The reviewed regulatory coverage cannot authorize this route."}`);
    }
    const route = orderedRoute();
    const requiredDocuments = plan?.requiredDocuments?.length
      ? plan.requiredDocuments
      : FALLBACK_DOCUMENTS_BY_ROUTE[route.key] ?? [];
    stageSet("automation", "documents", "RUNNING", `Preparing ${requiredDocuments.length} route-specific evidence records.`);
    for (const code of requiredDocuments) {
      await call(selectedPartyKey(), "POST", `/v1/contracts/${run.results.contractId}/documents`, {
        code, contentType: "application/pdf",
        contentBase64: Buffer.from(`ANCHOR DEMONSTRATION ONLY\n${route.key}\n${code}\nAGREEMENT ${run.results.contractHash}`, "utf8").toString("base64")
      }, `auto-document-${code}`);
    }
    stageSet("automation", "documents", "COMPLETED", `${requiredDocuments.length} required document hashes stored; private demo bytes remain in MinIO.`, [
      ["ROUTE", `${route.originCountry} → ${route.destinationCountry}`],
      ["DOCUMENTS", requiredDocuments.join(" · ") || "NONE REQUIRED"],
    ]);
    await wait(700);
    stageSet("automation", "fx", "RUNNING", "Resolving corridor, compliance and a live two-leg FX quote.");
    const created = await call(companyPartyKey(), "POST", "/v1/payments", {
      contractId: run.results.contractId,
      fundingAmount: run.results.contractAmount,
      purposeCode: plan?.facts?.purposeCode ?? PURPOSE_BY_ROUTE[route.key] ?? "B2B_SERVICES",
    }, "auto-payment");
    if (!run || run.nonce !== nonce) return;
    run.results.payment = created.payment ?? created;
    run.results.paymentId = run.results.payment.id;
    run.results.quote = created.quote;
    run.results.compliance = created.compliance;
    stageSet("automation", "rules", regulation.coverage?.outcome === "MANUAL_REVIEW" ? "REVIEW" : "COMPLETED", regulation.explanation?.summary ?? "Reviewed regulation corpus checked.", [
      ["RULESET", created.compliance?.rulesVersion ?? "—"], ["CORPUS", regulation.report?.approvedCorpusHash ?? "—"]
    ]);
    stageSet("automation", "fx", "COMPLETED", "Quote stored and bound to this payment.", [
      ["SOURCE", created.quote?.rateSource ?? "—"], ["OBSERVED", created.quote?.rateObservedAt ?? "—"], ["EXPIRES", created.quote?.expiresAt ?? "—"]
    ]);
    await wait(700);
    stageSet("automation", "escrow", "RUNNING", "Locking the quote-fixed USD amount in ARC-4 escrow.");
    const funded = await call(companyPartyKey(), "POST", `/v1/payments/${run.results.paymentId}/fund`, {}, "auto-fund");
    run.results.payment = funded.payment ?? funded;
    const timeline = await call(companyPartyKey(), "GET", `/v1/payments/${run.results.paymentId}/timeline`);
    run.results.binding = timeline.binding;
    run.results.settlementTimeline = timeline;
    run.results.quote = timeline.quote ?? run.results.quote;
    run.results.compliance = timeline.compliance ?? run.results.compliance;
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
    const evaluated = await call(companyPartyKey(), "POST", `/v1/submissions/${run.results.submissionId}/evaluate`, {}, "auto-validate");
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
    const released = await call(companyPartyKey(), "POST", `/v1/payments/${run.results.paymentId}/release`, {}, "auto-release");
    if (!run || run.nonce !== nonce) return;
    run.results.payment = released.payment ?? released;
    const timeline = await call(companyPartyKey(), "GET", `/v1/payments/${run.results.paymentId}/timeline`);
    run.results.binding = timeline.binding;
    run.results.settlementTimeline = timeline;
    run.results.quote = timeline.quote ?? run.results.quote;
    run.results.compliance = timeline.compliance ?? run.results.compliance;
    stageSet("deliveryAutomation", "release", "COMPLETED", `Provider settlement and ${run.results.payment.payoutCurrency} credit completed.`, [
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
  async onboard(input) {
    if (run.phase !== "COMPANY_ONBOARDING") throw new Error("The company policy profile is already approved for this workspace.");
    const profile = companyProfile(input.companyCountry);
    if (profile.currency !== input.fundingCurrency) {
      throw new Error(`The ${input.companyCountry} demo company is verified to fund in ${profile.currency}.`);
    }
    run.results.companyPartyKey = profile.partyKey;
    const created = await call(profile.partyKey, "POST", "/v1/company/policy-profile", input, "company-policy");
    const storedProfile = created.profile ?? created;
    const { sourceObjectId: _sourceObjectId, approvedByUserId: _approvedByUserId, ...publicProfile } = storedProfile;
    run.results.companyPolicyProfile = publicProfile;
    run.phase = "JOB_DRAFT";
    return [["PROFILE", run.results.companyPolicyProfile.id], ["VERSION", String(run.results.companyPolicyProfile.version)], ["POLICY HASH", run.results.companyPolicyProfile.profileHash], ["SOURCE HASH", run.results.companyPolicyProfile.sourceArtifactHash]];
  },
  async job(input) {
    if (run.phase !== "JOB_DRAFT") throw new Error("A job already exists for this deal.");
    const profile = companyProfile(input.payerCountry);
    if (profile.currency !== input.fundingCurrency || input.budget?.currency !== profile.currency) {
      throw new Error(`The ${input.payerCountry} demo company is verified to fund in ${profile.currency}.`);
    }
    await authorizeJobPayerProfile(input.payerCountry);
    const created = await call(profile.partyKey, "POST", "/v1/jobs", {
      title: input.title, description: input.description, skills: input.skills,
      acceptanceCriteria: termList(input.acceptanceCriteria),
      targetDeliveryDate: input.deliveryDate,
      payerCountry: input.payerCountry,
      fundingCurrency: input.fundingCurrency,
      // Search preference only. The ordered settlement route is created later
      // from the selected applicant's verified payout profile.
      destinationCountry: profile.preferredTalentCountry,
      budget: input.budget
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
    if (input.residenceCountry !== input.payoutCountry) {
      throw new Error("The current demo rails require tax residence and payout country to match.");
    }
    const profile = providerProfile(input.payoutCountry);
    if (profile.currency !== input.payoutCurrency) {
      throw new Error(`The ${input.payoutCountry} demo payout profile is verified for ${profile.currency}.`);
    }
    run.results.primaryProviderPartyKey = profile.partyKey;
    const created = await call(profile.partyKey, "POST", `/v1/jobs/${run.results.jobId}/applications`, input, "primary-apply");
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
    const selected = await call(companyPartyKey(), "POST", `/v1/applications/${application.id}/select`, { amount }, "select");
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
    const generated = await call(companyPartyKey(), "POST", `/v1/contracts/${run.results.contractId}/agreement`, {
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
    run.phase = "AWAITING_COMPANY_AGREEMENT";
    return [["DOCUMENT", agreement.fileName ?? "anchor-work-agreement.md"], ["SHA-256", agreement.artifactHash ?? agreement.documentHash ?? agreement.sha256], ["TERMS HASH", run.results.contractHash], ["SOURCES", String(generated.contract?.agreementTerms?.sources?.length ?? 0)]];
  },
  async "agreement-company-approve"() {
    if (run.phase !== "AWAITING_COMPANY_AGREEMENT") throw new Error("Generate and review the sourced agreement before approving it.");
    const approved = await call(companyPartyKey(), "POST", `/v1/contracts/${run.results.contractId}/approve`, {
      party: "BUYER", acceptedTermsHash: run.results.contractHash
    }, "approve-company-agreement");
    run.results.approvals = approved.approvals;
    run.phase = "AWAITING_FREELANCER_AGREEMENT";
    return [["COMPANY", "APPROVED"], ["TERMS HASH", run.results.contractHash], ["NEXT", "FREELANCER REVIEW"]];
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
    const decided = await call(companyPartyKey(), "POST", `/v1/submissions/${run.results.submissionId}/approve`, {
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
  run = freshRun(run);
  automationPromise = validationPromise = releasePromise = null;
  persistRun();
  return { ok: true, startedAt: run.startedAt };
}

export async function authorizePortal(role, input = {}) {
  if (!run) run = freshRun();
  if (role !== "COMPANY") {
    const all = await loadParties();
    const party = all[run.results.primaryProviderPartyKey ?? "indianFreelancer"];
    if (!party?.credentialId || !party.principal?.roles?.includes("freelancer")) {
      throw new Error("The freelancer credential or tenant role is unavailable.");
    }
    return {
      outcome: "AUTHORIZED",
      subject: party.principal.subject,
      checks: [
        { code: "SIGNED_CREDENTIAL", status: "PASSED", detail: "Active signed demo credential loaded." },
        { code: "TENANT_ROLE", status: "PASSED", detail: "Freelancer role is present in the authenticated principal." },
      ],
      disclaimer: "Demo identity only; no production KYC assertion is made.",
    };
  }

  const payload = { ...PUBLIC_COMPANY_SAMPLE, ...input, country: String(input.country ?? PUBLIC_COMPANY_SAMPLE.country).toUpperCase() };
  const profile = companyProfile(payload.country);
  if (run.results.companyPartyKey && run.results.companyPartyKey !== profile.partyKey) run = freshRun(null);
  run.results.companyPartyKey = profile.partyKey;
  const evaluated = await call(profile.partyKey, "POST", "/v1/company/authorization/evaluate", payload, `login-authorization-${Date.now()}`);
  const decision = evaluated.decision;
  if (decision?.outcome !== "AUTHORIZED") {
    persistRun();
    throw new Error(`Authorization Agent returned ${decision?.outcome ?? "NO DECISION"}. ${evaluated.profile?.verificationReasons?.join(" ") ?? ""}`.trim());
  }
  const { taxIdentifier: _taxIdentifier, ...safeProfile } = evaluated.profile;
  run.results.companyVerificationProfile = safeProfile;
  run.results.companyAuthorization = {
    id: decision.id,
    outcome: decision.outcome,
    checks: decision.checks,
    citations: decision.citations,
    decisionHash: decision.decisionHash,
    decidedAt: decision.decidedAt,
    expiresAt: decision.expiresAt,
    representativeRole: decision.representativeRole,
    mandateReference: decision.mandateReference,
  };
  persistRun();
  return {
    outcome: decision.outcome,
    company: safeProfile,
    authorization: run.results.companyAuthorization,
    disclaimer: "Public registry sample; no affiliation with the referenced company. Representative authority is simulated for this zero-value demo.",
  };
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
  return call(role === "freelancer" ? selectedPartyKey() : companyPartyKey(), "GET", `/v1/contracts/${run.results.contractId}/agreement/access`);
}

export async function submissionAccess() {
  if (!run?.results?.submissionId) throw new Error("No deliverable is available.");
  return call(companyPartyKey(), "GET", `/v1/submissions/${run.results.submissionId}/access`);
}

export async function extractForm(role, input) {
  if (!run) {
    run = freshRun();
    persistRun();
  }
  const freelancer = role === "freelancer";
  const allowedPurposes = freelancer ? ["FREELANCER_PROPOSAL"] : ["COMPANY_IDENTITY", "COMPANY_POLICY", "JOB_BRIEF", "AGREEMENT_TERMS"];
  if (!allowedPurposes.includes(input?.purpose)) {
    throw new Error(`The ${freelancer ? "Freelancer" : "Company"} portal cannot extract ${String(input?.purpose ?? "this document")}.`);
  }
  return call(
    freelancer ? (run.results.primaryProviderPartyKey ?? "indianFreelancer") : (run.results.companyPartyKey ?? "polishCompany"),
    "POST",
    "/v1/ai/extract-form",
    input,
    `extract-${String(input.purpose).toLowerCase()}-${Date.now()}`,
  );
}

export function currentRun() {
  if (!run) return null;
  persistRun();
  return {
    startedAt: run.startedAt, phase: run.phase, results: run.results, actions: run.actions,
    screening: run.screening, automation: run.automation, deliveryAutomation: run.deliveryAutomation
  };
}
