// Anchor's role-specific deal workspace. The browser never receives party
// credentials or signing material: every command crosses the same-origin
// workflow boundary and is authorized server-side.
(() => {
  "use strict";

  let role = "COMPANY";
  let model = { steps: [], run: null };
  let busy = false;
  let initialized = false;
  let inspectedStage = null;
  let transferAnimationUntil = 0;
  let transferAnimationTimer = null;

  const $ = selector => document.querySelector(selector);
  const escape = value => String(value ?? "—").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
  const results = () => model.run?.results ?? {};
  const stepState = id => model.run?.actions?.[id];
  const isDone = id => stepState(id)?.status === "DONE";
  const isFailed = id => stepState(id)?.status === "FAILED";
  const firstStep = (...ids) => model.steps.find(step => ids.includes(step.id));
  const hasDone = (...ids) => ids.some(isDone);
  const companyPolicyProfile = () => results().companyPolicyProfile ?? null;
  const companyVerificationProfile = () => results().companyVerificationProfile ?? null;
  const companyAuthorization = () => results().companyAuthorization ?? null;

  function money(minor, scale = 2, currency = "PLN") {
    if (minor === undefined || minor === null || minor === "") return "—";
    const amount = Number(minor) / 10 ** Number(scale);
    if (!Number.isFinite(amount)) return "—";
    return `${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
  }

  function rate(units, scale = 10) {
    const value = Number(units) / 10 ** Number(scale);
    return Number.isFinite(value) ? value.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 6 }) : "—";
  }

  function shortRef(value, size = 12) {
    const text = String(value ?? "—");
    return text.length > size * 2 + 3 ? `${text.slice(0, size)}…${text.slice(-size)}` : text;
  }

  function proposalPrice(application) {
    const proposed = application?.proposedPrice;
    return proposed && typeof proposed === "object"
      ? money(proposed.amountMinor, proposed.scale, proposed.currency)
      : money(application?.proposedPriceMinor, application?.proposedPriceScale, application?.proposedPriceCurrency);
  }

  const countryNames = { PL: "Poland", IN: "India", GB: "United Kingdom", DE: "Germany", RU: "Russia", KP: "North Korea" };
  const countryCurrencies = { PL: "PLN", IN: "INR", GB: "GBP", DE: "EUR", RU: "RUB", KP: "KPW" };

  function dealRoute() {
    const r = results();
    const job = r.job ?? {};
    const freelancer = selectedApplication() ?? applications()[0] ?? {};
    const plan = r.regulatoryPlan ?? r.regulation?.plan ?? r.regulation?.regulatoryPlan ?? {};
    const ordered = String(plan.orderedRoute ?? r.corridor?.orderedRoute ?? "").split(/\s*→\s*/u);
    const corridorParts = String(r.payment?.corridorId ?? r.compliance?.corridorId ?? r.corridor?.id ?? "").split("-");
    const originCountry = job.payerCountry ?? job.originCountry ?? job.organizationCountry ?? plan.facts?.originCountry ?? r.payment?.originCountry ?? r.corridor?.originCountry ?? ordered[0] ?? corridorParts[0];
    const destinationCountry = freelancer.payoutCountry ?? freelancer.residenceCountry ?? plan.facts?.destinationCountry ?? r.payment?.destinationCountry ?? r.corridor?.destinationCountry ?? ordered[1] ?? corridorParts[1];
    return {
      originCountry,
      destinationCountry,
      fundingCurrency: job.fundingCurrency ?? job.budgetCurrency ?? r.quote?.fundingAmount?.currency ?? r.payment?.fundingCurrency,
      payoutCurrency: freelancer.payoutCurrency ?? r.quote?.payoutAmount?.currency ?? r.payment?.payoutCurrency,
      direction: plan.facts?.direction ?? plan.direction ?? r.corridor?.direction ?? r.payment?.direction ?? r.compliance?.direction ?? corridorParts[2],
      bookId: plan.bookId ?? r.compliance?.bookId ?? r.payment?.bookId
    };
  }

  function countryLabel(code) {
    return countryNames[String(code ?? "").toUpperCase()] ?? code ?? "Pending";
  }

  function countryOptions(selected) {
    return Object.entries(countryNames).map(([code, name]) => `<option value="${code}" data-currency="${countryCurrencies[code]}" ${code === selected ? "selected" : ""}>${escape(name)} · ${code}</option>`).join("");
  }

  function currencyOptions(selected) {
    return Object.entries(countryCurrencies).map(([code, currency]) => `<option value="${currency}" ${currency === selected ? "selected" : ""}>${currency} · ${escape(countryNames[code])}</option>`).join("");
  }

  function displayedPolicyOutcome(plan, regulation, compliance) {
    const raw = plan?.policyStatus ?? plan?.outcome ?? regulation?.coverage?.outcome ?? compliance?.outcome;
    if (raw === "PASSED") return "ACTIVE";
    if (raw === "MANUAL_REVIEW") return "REVIEW";
    return raw ?? "PENDING";
  }

  function automationStatusLabel() {
    const r = results();
    const plan = r.regulatoryPlan ?? r.regulation?.plan ?? r.regulation?.regulatoryPlan;
    const outcome = displayedPolicyOutcome(plan, r.regulation, r.compliance);
    if (plan?.hardGate?.canQuoteOrFund === false) return outcome === "BLOCKED" ? "BLOCKED BY HARD GATE" : "REVIEW REQUIRED";
    return model.run?.automation?.status === "FAILED" ? "AUTOMATION FAILED" : "AGENTS WORKING";
  }

  function lines(value) {
    return String(value ?? "").split(/\n+/u).map(item => item.replace(/^[-*]\s*/u, "").trim()).filter(Boolean);
  }

  async function request(path, options = {}) {
    const { headers = {}, ...requestOptions } = options;
    const response = await fetch(path, {
      ...requestOptions,
      headers: { accept: "application/json", "x-anchor-role": role, ...(options.body ? { "content-type": "application/json" } : {}), ...headers }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : body?.error?.message ?? `Request failed (${response.status})`);
    return body;
  }

  function setStatus(message, tone = "live") {
    const element = $("#workflowStatus");
    element.textContent = message;
    element.dataset.tone = tone;
  }

  function applications() {
    const list = results().applications;
    if (Array.isArray(list)) return list;
    const legacy = results().application;
    if (legacy) return [legacy];
    if (results().applicationId) return [{
      id: results().applicationId,
      applicantDisplayName: "Arjun Studio",
      evaluation: results().evaluation,
      coverLetter: "Proposal received through the authenticated freelancer account."
    }];
    return [];
  }

  function selectedApplication() {
    const id = results().selectedApplicationId ?? (results().contract ? results().applicationId : null);
    return applications().find(application => application.id === id) ?? (id ? { id } : null);
  }

  function agreement() {
    const value = results().agreement;
    if (value) return value;
    const contract = results().contract;
    return contract ? {
      contractHash: contract.contractHash,
      documentHash: contract.documentHash,
      fileName: contract.fileName,
      terms: contract.terms,
      policies: contract.policies,
      legalClauses: contract.legalClauses,
      acceptanceCriteria: contract.acceptanceCriteria,
      commercialTerms: contract.commercialTerms
    } : null;
  }

  function phaseStatus(ids, activeWhen = false) {
    if (ids.includes("onboard") && companyPolicyProfile()) return "done";
    if (ids.some(isFailed)) return "failed";
    if (ids.includes("automation") && model.run?.phase === "AUTOMATION_FAILED" && !results().binding) return "held";
    if (ids.includes("automation") && results().binding) return "done";
    const existing = ids.filter(id => model.steps.some(step => step.id === id));
    if (existing.length && existing.every(isDone)) return "done";
    if (activeWhen) return "current";
    return "pending";
  }

  function renderRail() {
    const r = results();
    const route = dealRoute();
    const phase = model.run?.phase ?? "JOB_DRAFT";
    const proposalDetail = applications().length ? `${applications().length} proposals · agent ranked` : "Waiting for proposals";
    const agreementDetail = agreement() ? `Hash ${shortRef(agreement().contractHash ?? agreement().artifactHash, 6)}` : "Generate from approved sources";
    const settlementHeld = phase === "AUTOMATION_FAILED" && !r.binding;
    const escrowDetail = r.binding
      ? `${money(r.binding.amountUsdcMinor, r.binding.scale ?? 6, "USDC")} · ${r.binding.network}`
      : settlementHeld ? "Stopped before quote or signing" : "Rules, FX and funding";
    const evidenceDetail = r.submission ? `Fabric ${shortRef(r.submission.evidenceId, 7)}` : "Validate evidence, decide, release";
    const companyPhases = [
      ["01", "Company setup", companyPolicyProfile() ? `Identity authorized · policy v${companyPolicyProfile().version}` : "Identity authorized · policy pending", ["onboard"], phase === "COMPANY_ONBOARDING"],
      ["02", "Publish brief", "Define scope and budget", ["job"], phase === "JOB_DRAFT"],
      ["03", "Choose talent", proposalDetail, ["apply", "select"], ["APPLICATIONS_OPEN", "SCREENING", "COMPANY_SELECTION"].includes(phase)],
      ["04", "Lock agreement", agreementDetail, ["terms", "agreement-company-approve", "agreement-approve"], ["AGREEMENT_DRAFT", "AWAITING_COMPANY_AGREEMENT", "AWAITING_FREELANCER_AGREEMENT"].includes(phase)],
      ["05", "Secure escrow", escrowDetail, ["automation"], ["AUTOMATING_ESCROW", "AUTOMATION_FAILED"].includes(phase)],
      ["06", "Review delivery", evidenceDetail, ["submit", "approve-work"], ["AWAITING_DELIVERY", "VALIDATING_DELIVERY", "VALIDATION_FAILED", "AWAITING_WORK_APPROVAL", "RELEASING", "RELEASE_FAILED", "COMPLETED"].includes(phase)]
    ];
    const freelancerPhases = [
      ["01", "Find opportunity", "Review the company brief", ["job"], phase === "JOB_DRAFT"],
      ["02", "Send proposal", "Price, timing and approach", ["apply"], phase === "APPLICATIONS_OPEN"],
      ["03", "Selection", r.selectedApplicationId ? "Company selection recorded" : "Agent screening in progress", ["select"], ["SCREENING", "COMPANY_SELECTION"].includes(phase)],
      ["04", "Review agreement", agreementDetail, ["terms", "agreement-company-approve", "agreement-approve"], ["AGREEMENT_DRAFT", "AWAITING_COMPANY_AGREEMENT", "AWAITING_FREELANCER_AGREEMENT"].includes(phase)],
      ["05", settlementHeld ? "Settlement held" : "Escrow secured", escrowDetail, ["automation"], phase === "AUTOMATING_ESCROW"],
      ["06", "Deliver & receive", evidenceDetail, ["submit", "approve-work"], ["AWAITING_DELIVERY", "VALIDATING_DELIVERY", "VALIDATION_FAILED", "AWAITING_WORK_APPROVAL", "RELEASING", "RELEASE_FAILED", "COMPLETED"].includes(phase)]
    ];
    const phases = role === "COMPANY" ? companyPhases : freelancerPhases;
    const completed = phases.filter(([, , , ids]) => phaseStatus(ids) === "done").length;
    $("#stageCount").textContent = `${String(completed).padStart(2, "0")} / ${String(phases.length).padStart(2, "0")}`;
    $("#workspaceStages").innerHTML = phases.map(([number, label, detail, ids, active]) => {
      const state = phaseStatus(ids, active);
      const selected = inspectedStage === number;
      const content = `<i>${state === "done" ? "✓" : number}</i><span><b>${escape(label)}</b><small>${escape(detail)}</small></span><em>${selected ? "VIEWING" : state === "current" ? "LIVE" : state.toUpperCase()}</em>`;
      return state === "done"
        ? `<button type="button" class="role-stage-item ${selected ? "selected" : ""}" data-state="${state}" data-inspect-stage="${number}">${content}</button>`
        : `<div class="role-stage-item" data-state="${state}" ${active ? 'aria-current="step"' : ""}>${content}</div>`;
    }).join("");
    const corridor = $("#railCorridor");
    if (corridor) corridor.textContent = route.originCountry && route.destinationCountry
      ? `${route.originCountry} → ${route.destinationCountry}`
      : route.originCountry ? `${route.originCountry} → PAYEE PENDING` : "PAYER → PAYEE";
  }

  function documentAutofill(purpose) {
    const companyPolicy = purpose === "COMPANY_POLICY";
    const brief = purpose === "JOB_BRIEF";
    const agreementTerms = purpose === "AGREEMENT_TERMS";
    const documentName = companyPolicy ? "YOUR COMPANY POLICY" : brief ? "A JOB BRIEF" : agreementTerms ? "COMMERCIAL / LEGAL TERMS" : "YOUR PROPOSAL";
    const accessibleName = companyPolicy ? "company onboarding policy" : brief ? "company brief" : agreementTerms ? "commercial and legal terms" : "freelancer proposal";
    return `<div class="document-autofill">
      <input class="document-autofill-input" type="file" name="${companyPolicy ? "file" : "draftFile"}" ${companyPolicy ? "required" : ""} data-draft-file data-extract-purpose="${purpose}" accept=".pdf,.txt,.md,.doc,.docx,.rtf,.odt" aria-label="Upload ${accessibleName} to autofill the form">
      <div class="document-autofill-icon">↥</div>
      <div><small>AI DOCUMENT INTAKE · OPTIONAL</small><strong>DROP ${documentName} TO AUTOFILL</strong><p>PDF, DOCX, TXT or MD · maximum 8 MB. Review every extracted field before you submit.</p></div>
      <span data-draft-file-name>CHOOSE FILE</span>
      <output data-extraction-status aria-live="polite">Nothing is uploaded or published automatically.</output>
    </div>`;
  }

  function policyProfileCard() {
    const profile = companyPolicyProfile();
    if (!profile) return "";
    return `<section class="workspace-card policy-profile-card"><header><span>APPROVED COMPANY POLICY</span><b>VERSION ${escape(profile.version)}</b></header><div class="policy-profile-summary"><span><small>COMPANY COUNTRY</small><b>${escape(countryLabel(profile.country))}</b></span><span><small>FUNDING CURRENCY</small><b>${escape(profile.fundingCurrency)}</b></span><span><small>PROFILE HASH</small><b>${escape(shortRef(profile.profileHash, 10))}</b></span><span><small>SOURCE HASH</small><b>${escape(shortRef(profile.sourceArtifactHash, 10))}</b></span></div><p>Approved once and reused as a versioned agreement source. The original document remains private in MinIO.</p></section>`;
  }

  function companyVerificationCard() {
    const profile = companyVerificationProfile();
    const authorization = companyAuthorization();
    if (!profile || !authorization) return "";
    const passed = (authorization.checks ?? []).filter(check => check.status === "PASSED").length;
    return `<section class="workspace-card policy-profile-card"><header><span>LOGIN AUTHORIZATION AGENT</span><b>${escape(authorization.outcome)}</b></header><div class="policy-profile-summary"><span><small>LEGAL ENTITY</small><b>${escape(profile.legalName)}</b></span><span><small>PUBLIC REGISTER</small><b>${escape(`${profile.registryAuthority} · ${profile.registrationNumber}`)}</b></span><span><small>ENTITY STATUS</small><b>${escape(profile.entityStatus)}</b></span><span><small>AUTHORITY CHECKS</small><b>${escape(`${passed}/${authorization.checks?.length ?? 0} PASSED`)}</b></span></div><p>Registry evidence and sanctions/ownership screening are separate from the tenant mandate authorizing this signed-in representative. Public-record demo; no affiliation with the referenced company.</p></section>`;
  }

  function onboardingForm() {
    const identity = companyVerificationProfile() ?? {};
    const verifiedCountry = identity.country ?? "GB";
    const verifiedCurrency = countryCurrencies[verifiedCountry] ?? "GBP";
    return `${companyVerificationCard()}<section class="workspace-card action-card"><header><span>POLICY VAULT · AFTER IDENTITY AUTHORIZATION</span><b>HUMAN APPROVAL REQUIRED</b></header><form class="workspace-form" data-workspace-form="onboard">
      ${documentAutofill("COMPANY_POLICY")}
      <div class="selected-talent"><small>VERIFIED COMPANY · FROM LOGIN AUTHORIZATION</small><strong>${escape(identity.legalName ?? "Company identity pending")}</strong><span>${escape(countryLabel(verifiedCountry))} · ${escape(identity.registryAuthority ?? "Registry pending")} ${escape(identity.registrationNumber ?? "")}</span></div><input type="hidden" name="companyCountry" value="${escape(verifiedCountry)}"><input type="hidden" name="fundingCurrency" value="${escape(verifiedCurrency)}">
      <label><span>COMPANY POLICIES</span><textarea name="policies" required minlength="20" placeholder="Security, confidentiality, IP, data handling and communication standards"></textarea></label>
      <label><span>LEGAL STANDARDS</span><textarea name="legalClauses" required minlength="20" placeholder="Governing law, disputes, ownership, termination and warranties"></textarea></label>
      <label><span>COMMERCIAL STANDARDS</span><textarea name="commercialStandards" required minlength="20" placeholder="Invoicing, revisions, payment timing and expense rules"></textarea></label>
      <label><span>AUTHORIZED APPROVERS</span><textarea name="authorizedApprovers" required minlength="5" placeholder="Roles authorized to approve private work agreements"></textarea></label>
      <input type="hidden" name="extractionSource" value="FIXTURE"><input type="hidden" name="extractionModel" value="manual-review-v1">
      <button type="submit">APPROVE VERSIONED POLICY PROFILE <b>→</b></button><p class="form-hint">The legal entity and representative were authorized at login. This separate source defines reusable company standards; AI extracts a draft but never accepts an agreement.</p>
    </form></section>`;
  }

  function jobForm() {
    const profile = companyPolicyProfile() ?? {};
    const payerCountry = profile.country ?? companyVerificationProfile()?.country ?? "GB";
    const fundingCurrency = countryCurrencies[payerCountry] ?? profile.fundingCurrency ?? "GBP";
    return `<section class="workspace-card action-card"><header><span>COMPANY INPUT · REQUIRED</span><b>NEW BRIEF</b></header><form class="workspace-form" data-workspace-form="job">
      ${documentAutofill("JOB_BRIEF")}
      <div class="selected-talent"><small>AUTHORIZED COMPANY · JOB-LEVEL PAYER PROFILE</small><strong>${escape(companyVerificationProfile()?.legalName ?? "Verified demo company")}</strong><span>Choose the payer country for this job. Anchor switches to that country's signed demo entity and reuses the approved policy source; corridor law is evaluated after freelancer selection.</span></div>
      <label><span>WORK TITLE</span><input name="title" required minlength="4" autocomplete="off" placeholder="e.g. Build a settlement reconciliation service"></label>
      <label><span>SCOPE OF WORK</span><textarea name="description" required minlength="20" placeholder="Explain the problem, expected outcome and what must be delivered"></textarea></label>
      <label><span>ACCEPTANCE CRITERIA</span><textarea name="acceptanceCriteria" required minlength="10" placeholder="List the objective checks used to accept the final work"></textarea></label>
      <div class="field-grid"><label><span>REQUIRED SKILLS</span><input name="skills" required placeholder="TypeScript, PostgreSQL, reconciliation"></label><label><span>FUNDING AMOUNT</span><input name="budget" type="number" min="1" step="0.01" required placeholder="12000.00"></label></div>
      <div class="field-grid corridor-inputs"><label><span>PAYER COUNTRY</span><select name="payerCountry" data-country-select="fundingCurrency" required>${countryOptions(payerCountry)}</select></label><label><span>FUNDING CURRENCY</span><select name="fundingCurrency" required>${currencyOptions(fundingCurrency)}</select></label></div>
      <label><span>TARGET DELIVERY DATE</span><input name="deliveryDate" type="date" required></label>
      <button type="submit">PUBLISH OPPORTUNITY <b>→</b></button><p class="form-hint">Country and currency are deal inputs. The server still enforces their mapping and uses an authorized, signed demo payer identity for the selected jurisdiction.</p>
    </form></section>`;
  }

  function applicationForm(job) {
    return `<section class="workspace-card action-card"><header><span>YOUR PROPOSAL</span><b>PRIVATE UNTIL SUBMITTED</b></header><form class="workspace-form" data-workspace-form="apply">
      ${documentAutofill("FREELANCER_PROPOSAL")}
      <div class="field-grid"><label><span>PROPOSED PRICE · ${escape(job?.fundingCurrency ?? job?.budgetCurrency ?? "PAYER CURRENCY")}</span><input name="proposedPrice" type="number" min="1" step="0.01" required placeholder="10800.00"></label><label><span>DELIVERY · DAYS</span><input name="deliveryDays" type="number" min="1" max="365" required placeholder="21"></label></div>
      <div class="field-grid corridor-inputs"><label><span>TAX RESIDENCE</span><select name="residenceCountry" required><option value="" selected disabled>Choose residence</option><option value="PL">Poland</option><option value="IN">India</option><option value="GB">United Kingdom</option><option value="DE">Germany</option><option value="RU">Russia</option><option value="KP">North Korea</option></select></label><label><span>PAYOUT COUNTRY</span><select name="payoutCountry" data-country-select="payoutCurrency" required><option value="" selected disabled>Choose payout country</option><option value="PL" data-currency="PLN">Poland</option><option value="IN" data-currency="INR">India</option><option value="GB" data-currency="GBP">United Kingdom</option><option value="DE" data-currency="EUR">Germany</option><option value="RU" data-currency="RUB">Russia</option><option value="KP" data-currency="KPW">North Korea</option></select></label></div>
      <label><span>PAYOUT CURRENCY</span><select name="payoutCurrency" required><option value="" selected disabled>Derived from payout country</option><option value="PLN">PLN · Polish złoty</option><option value="INR">INR · Indian rupee</option><option value="GBP">GBP · Pound sterling</option><option value="EUR">EUR · Euro</option><option value="RUB">RUB · Russian ruble</option><option value="KPW">KPW · North Korean won</option></select></label>
      <label><span>AVAILABILITY</span><input name="availability" required minlength="3" placeholder="e.g. Available from Monday, 30 hours/week"></label>
      <label><span>DELIVERY APPROACH</span><textarea name="approach" required minlength="20" placeholder="Describe your milestones, technical approach and how you will prove completion"></textarea></label>
      <label><span>COVER LETTER</span><textarea name="coverLetter" required minlength="20" placeholder="Explain the experience that makes you a strong fit for this work"></textarea></label>
      <button type="submit">SUBMIT PROPOSAL <b>→</b></button><p class="form-hint">The screening agent can rank fit; only the company can award the work.</p>
      <input type="hidden" name="jobId" value="${escape(job?.id)}">
    </form></section>`;
  }

  function termsForm(application) {
    const proposed = proposalPrice(application);
    const job = results().job ?? {};
    const profile = companyPolicyProfile();
    return `<section class="workspace-card action-card"><header><span>AGREEMENT SCRIBE</span><b>NO POLICY RE-ENTRY</b></header><div class="selected-talent"><small>SELECTED FREELANCER</small><strong>${escape(application?.applicantDisplayName ?? "Selected freelancer")}</strong><span>${escape(proposed)} · ${escape(application?.deliveryDays ? `${application.deliveryDays} days` : "delivery to be agreed")}</span></div><div class="agreement-source-grid"><article><small>01 · COMPANY ONBOARDING</small><b>POLICY VERSION ${escape(profile?.version ?? "—")}</b><p>${escape((profile?.policies ?? []).length)} policies · ${escape((profile?.legalClauses ?? []).length)} legal clauses · hash ${escape(shortRef(profile?.profileHash, 6))}</p></article><article><small>02 · JOB BRIEF</small><b>${escape(job.title)}</b><p>${escape((job.acceptanceCriteria ?? []).length)} objective acceptance checks</p></article><article><small>03 · SELECTED PROPOSAL</small><b>${escape(proposed)}</b><p>${escape(application?.deliveryDays)} days · ${escape(application?.payoutCountry)} / ${escape(application?.payoutCurrency)}</p></article></div><form class="workspace-form" data-workspace-form="terms">
      <button type="submit">GENERATE SOURCED PRIVATE AGREEMENT <b>→</b></button><p class="form-hint">The agent composes only from these approved sources. You will review the generated document and its clause provenance before approving.</p>
    </form></section>`;
  }

  function submissionForm() {
    return `<section class="workspace-card action-card"><header><span>PRIVATE DELIVERY</span><b>ANY FILE TYPE</b></header><form class="workspace-form" data-workspace-form="submit">
      <label class="workspace-file"><span>DELIVERABLE / SOURCE / PROOF</span><input name="file" type="file" required><b>SELECT THE ACTUAL FILE</b><small>No extension restriction. Bytes go to MinIO; SHA-256 evidence goes to Fabric.</small></label>
      <label><span>DELIVERY NOTE</span><textarea name="note" maxlength="2000" required placeholder="Explain what is included and how the company should validate it"></textarea></label>
      <button type="submit">UPLOAD + COMMIT EVIDENCE <b>→</b></button>
    </form></section>`;
  }

  function opportunity(job) {
    if (!job) return `<section class="workspace-card empty-state"><span>⌁</span><h2>WAITING FOR A VERIFIED OPPORTUNITY</h2><p>A company brief will appear here when it is published. You will never see company-only creation controls.</p></section>`;
    const skills = Array.isArray(job.skills) ? job.skills : [];
    return `<section class="workspace-card opportunity-card"><header><span>OPEN OPPORTUNITY</span><b>${escape(job.status ?? "OPEN")}</b></header><div><p class="mini-label">PAYER · ${escape(job.payerCountry ?? job.originCountry ?? job.organizationCountry ?? "COMPANY COUNTRY PENDING")} · ${escape(job.fundingCurrency ?? job.budgetCurrency ?? "FUNDING CURRENCY PENDING")}</p><h2>${escape(job.title)}</h2><p>${escape(job.description)}</p><div class="opportunity-meta"><span><small>BUDGET</small><b>${escape(money(job.budgetAmountMinor, job.budgetScale, job.budgetCurrency))}</b></span><span><small>SKILLS</small><b>${escape(skills.join(" · ") || "See brief")}</b></span></div></div></section>`;
  }

  function applicantCards() {
    const list = applications().slice().sort((a, b) => Number(a.rank ?? 999) - Number(b.rank ?? 999) || Number(b.evaluation?.score ?? 0) - Number(a.evaluation?.score ?? 0));
    if (!list.length) return `<section class="workspace-card empty-state"><span>⌛</span><h2>WAITING FOR PROPOSALS</h2><p>Freelancers submit their own pricing, delivery timing, availability and approach. Applicant data is never fabricated in this view.</p></section>`;
    const selectStep = firstStep("select");
    const selectedId = results().selectedApplicationId ?? (results().contract ? results().applicationId : null);
    const screeningReady = model.run?.screening?.status === "COMPLETED";
    return `<section class="workspace-card applicants-card"><header><span>SCREENING DESK</span><b>${escape(model.run?.screening?.status ?? "WAITING")} · ${list.length} PROPOSALS</b></header><div class="applicant-grid">${list.map((application, index) => {
      const evaluation = application.evaluation ?? application.aiEvaluation;
      const chosen = selectedId === application.id;
      return `<article class="applicant-card ${chosen ? "selected" : ""}"><div class="applicant-rank"><i>${escape(application.rank ?? index + 1)}</i><span><small>${chosen ? "SELECTED" : "AGENT RANK"}</small><b>${evaluation?.score !== undefined ? `${escape(evaluation.score)}/100` : "SCREENING"}</b></span></div><h3>${escape(application.applicantDisplayName ?? application.applicantName ?? `Freelancer ${index + 1}`)}</h3><p>${escape(evaluation?.summary ?? application.coverLetter ?? "Proposal received and awaiting advisory screening.")}</p><dl><div><dt>PRICE</dt><dd>${escape(proposalPrice(application))}</dd></div><div><dt>DELIVERY</dt><dd>${escape(application.deliveryDays ? `${application.deliveryDays} days` : "—")}</dd></div><div><dt>AVAILABILITY</dt><dd>${escape(application.availability)}</dd></div><div><dt>PAYOUT PROFILE</dt><dd>${escape(application.payoutCountry ? `${countryLabel(application.payoutCountry)} · ${application.payoutCurrency ?? "currency pending"}` : "Pending")}</dd></div></dl><details><summary>READ APPROACH</summary><p>${escape(application.approach ?? application.coverLetter)}</p></details>${!selectedId && selectStep && screeningReady ? `<button type="button" data-select-application="${escape(application.id)}">SELECT THIS FREELANCER <b>→</b></button>` : ""}</article>`;
    }).join("")}</div><p class="advisory-note">AI ranking is advisory. The company remains accountable for the final selection.</p></section>`;
  }

  function agreementCard(approvalParty = null) {
    const item = agreement();
    if (!item) return `<section class="workspace-card empty-state"><span>▤</span><h2>AGREEMENT NOT GENERATED YET</h2><p>The selected freelancer will receive the exact document after company terms are formalized.</p></section>`;
    const terms = item.terms ?? {};
    const rows = [["COMMERCIAL TERMS", item.commercialTerms ?? terms.commercialTerms], ["ACCEPTANCE", item.acceptanceCriteria ?? terms.acceptanceCriteria], ["COMPANY POLICIES", item.policies ?? terms.policies], ["LEGAL CLAUSES", item.legalClauses ?? terms.legalClauses]].filter(([, value]) => value);
    const downloadUrl = `/api/workflow/agreement/download?role=${role === "FREELANCER" ? "freelancer" : "company"}`;
    const sources = Array.isArray(terms.sources) ? terms.sources : [];
    const sourceList = sources.length ? `<section class="agreement-provenance"><header><span>CLAUSE PROVENANCE</span><b>${escape(sources.length)} SOURCED TERMS</b></header>${sources.map(source => `<div><span>${escape(source.sourceType)}</span><b>${escape(source.section.replaceAll("_", " "))}</b><p>${escape(source.text)}</p><code>${escape(shortRef(source.sourceHash, 8))}</code></div>`).join("")}</section>` : "";
    const approve = approvalParty === "COMPANY"
      ? `<button type="button" data-approve-company-agreement>I REVIEWED THIS HASH · COMPANY ACCEPTS <b>→</b></button>`
      : approvalParty === "FREELANCER" ? `<button type="button" data-approve-agreement>I REVIEWED THIS HASH · FREELANCER ACCEPTS <b>→</b></button>` : "";
    return `<section class="workspace-card agreement-card"><header><span>PRIVATE LEGAL AGREEMENT</span><b>PARTIES ONLY</b></header><div class="agreement-document"><div class="document-icon">DOC<br><b>✓</b></div><div><small>${escape(item.fileName ?? "anchor-work-agreement.pdf")}</small><h2>SHARED BETWEEN COMPANY + SELECTED FREELANCER</h2><p>${escape(item.byteLength ? `${item.byteLength} encrypted bytes in MinIO` : "Encrypted source document stored in MinIO")}</p></div></div><div class="hash-panel"><small>AGREEMENT SHA-256</small><code>${escape(item.artifactHash ?? item.documentHash ?? item.sha256 ?? item.contractHash)}</code></div>${rows.length ? `<dl class="agreement-terms">${rows.map(([label, value]) => `<div><dt>${label}</dt><dd>${escape(value)}</dd></div>`).join("")}</dl>` : ""}${sourceList}<div class="document-actions"><a href="${downloadUrl}" target="_blank" rel="noopener">DOWNLOAD AUTHORIZED DOCUMENT ↗</a>${approve}</div></section>`;
  }

  function automationCard() {
    const r = results();
    const automation = model.run?.automation;
    const stages = automation?.stages ?? {};
    const quote = r.quote;
    const compliance = r.compliance;
    const regulation = r.regulation;
    const plan = r.regulatoryPlan ?? regulation?.plan ?? regulation?.regulatoryPlan;
    const binding = r.binding;
    const route = dealRoute();
    const observations = Array.isArray(regulation?.report?.observations) ? regulation.report.observations : [];
    const categories = Array.isArray(plan?.categories)
      ? plan.categories
      : Array.isArray(regulation?.coverage?.checks) ? regulation.coverage.checks : [];
    const documents = Array.isArray(compliance?.requiredDocuments) ? compliance.requiredDocuments : [];
    const fees = Array.isArray(quote?.fees) ? quote.fees : [];
    const legs = Array.isArray(quote?.legs) ? quote.legs : [];
    const routeReady = Boolean(route.originCountry && route.destinationCountry);
    const policyOutcome = displayedPolicyOutcome(plan, regulation, compliance);
    const gate = plan?.hardGate;
    const gateStopped = gate?.canQuoteOrFund === false;
    const blocked = gateStopped && policyOutcome === "BLOCKED";
    const items = [
      {
        label: "Official-source refresh", status: stages.regulations?.status ?? stages.rules?.status ?? (regulation ? "COMPLETED" : "PENDING"),
        detail: regulation
          ? "Source refresh completed and the approved corpus hash was persisted."
          : "Refresh approved official sources for this ordered route."
      },
      {
        label: "Tax + document duties",
        status: stages.tradeDocuments?.status ?? stages.documents?.status ?? (gateStopped ? (blocked ? "BLOCKED" : "REVIEW") : documents.length ? "COMPLETED" : "PENDING"),
        detail: gateStopped
          ? "Duty modules are incomplete; human review is required."
          : "Resolve payer, payee and transaction-file responsibilities."
      },
      {
        label: "Corridor + compliance",
        status: gateStopped ? (blocked ? "BLOCKED" : "REVIEW") : stages.fxCompliance?.status ?? (compliance ? "COMPLETED" : quote ? "RUNNING" : "PENDING"),
        detail: gateStopped
          ? blocked ? "This ordered route is rejected by the policy gate." : "This ordered route requires a human compliance decision."
          : compliance?.reasons?.[0] ?? "Evaluate route, credentials, controls and limits."
      },
      {
        label: "Live FX + value lock", status: gateStopped && !quote ? "NOT REQUESTED" : stages.fxCompliance?.status ?? stages.fx?.status ?? (quote ? "COMPLETED" : "PENDING"),
        detail: gateStopped && !quote
          ? "No FX quote was requested after the policy hold."
          : quote ? `${money(quote.fundingAmount?.amountMinor, quote.fundingAmount?.scale, quote.fundingAmount?.currency)} was valued using the persisted quote.` : "Fetch reference-rate legs and calculate fees."
      },
      {
        label: "Provider escrow funding", status: gateStopped && !binding ? "NOT CREATED" : stages.escrowFunding?.status ?? stages.escrow?.status ?? (binding ? "COMPLETED" : "PENDING"),
        detail: gateStopped && !binding
          ? "No Algorand transaction was signed or broadcast."
          : binding ? "ARC-4 escrow funded for the persisted settlement amount." : "Wait for an approved decision and unexpired quote."
      }
    ];
    const gateReasons = Array.isArray(gate?.reasons) && gate.reasons.length
      ? gate.reasons
      : Array.isArray(plan?.reasons) ? plan.reasons : [];
    const sourceRows = observations.map(item => {
      const label = item.authority ?? item.sourceId ?? item.sourceVersion ?? "Official source";
      const detail = item.note ?? item.status ?? item.checkedAt ?? "Checked";
      return item.sourceUri
        ? `<a href="${escape(item.sourceUri)}" target="_blank" rel="noopener"><b>${escape(label)}</b><span>${escape(detail)}</span></a>`
        : `<div><b>${escape(label)}</b><span>${escape(detail)}</span></div>`;
    }).join("");
    const categoryRows = categories.length ? categories.map(item => {
      const requirements = Array.isArray(item.requirements) ? item.requirements : [];
      const reasons = Array.isArray(item.reasons) ? item.reasons : [];
      return `<article data-state="${escape(String(item.status ?? "PENDING").toLowerCase())}"><header><b>${escape(String(item.category ?? item.id ?? "OBLIGATION").replaceAll("_", " "))}</b><em>${escape(item.status ?? "PENDING")}</em></header><p>${escape(requirements[0] ?? reasons[0] ?? item.reason ?? "No persisted obligation detail yet.")}</p><small>${escape(Array.isArray(item.moduleIds) ? item.moduleIds.join(" · ") : item.sourceReferences?.length ? `${item.sourceReferences.length} source references` : "DEAL-DERIVED CHECK")}</small></article>`;
    }).join("") : `<div class="trace-empty">Obligation trace will appear after the selected payer → payee route is resolved.</div>`;
    const documentRows = documents.length ? documents.map(item => `<div><span><b>${escape(item.code ?? item.name ?? "DOCUMENT")}</b><small>${escape(item.responsibleParty ?? item.actor ?? "TRANSACTION FILE")}</small></span><em data-state="${item.satisfied ? "completed" : "pending"}">${item.satisfied ? "READY" : "REQUIRED"}</em><p>${escape(item.reason ?? "Required by the persisted corridor decision.")}</p></div>`).join("") : `<div class="trace-empty">Document duties are waiting for compliance evaluation.</div>`;
    const tax = categories.find(item => String(item.category ?? "").toUpperCase() === "TAX");
    const taxCopy = tax ? (tax.requirements?.join(" · ") || tax.reasons?.join(" · ") || tax.reason || tax.status) : "Tax responsibility is pending the deal-specific obligation plan.";
    const fxRows = legs.length ? legs.map((leg, index) => `<div><i>${String(index + 1).padStart(2, "0")}</i><span><small>${escape(leg.pair ?? `${leg.from ?? "?"}/${leg.to ?? "?"}`)}</small><b>${escape(rate(leg.rateUnits, leg.rateScale))}</b></span></div>`).join("") : `<div class="trace-empty">FX legs are waiting for a live quote.</div>`;
    const feeCopy = fees.length ? fees.map(item => `${item.code ?? "FEE"}: ${money(item.amount?.amountMinor ?? item.amountMinor, item.amount?.scale ?? item.scale, item.amount?.currency ?? item.currency ?? route.fundingCurrency)}`).join(" · ") : "No persisted fee breakdown yet";
    return `<section class="automation-workspace"><header><div><small>DEAL-DERIVED ORCHESTRATION</small><h3>How this escrow is authorized</h3><p>The route comes from the payer company and selected freelancer—not from a scenario picker. Each output is persisted before funding.</p></div><span data-state="${escape(String(policyOutcome).toLowerCase())}">${escape(policyOutcome)}</span></header>
      <section class="corridor-trace" aria-label="Ordered cross-border corridor"><div><small>ORDERED ROUTE</small><h4>${escape(routeReady ? `${countryLabel(route.originCountry)} → ${countryLabel(route.destinationCountry)}` : "Waiting for both parties")}</h4><p>${escape(`${route.fundingCurrency ?? "Funding currency pending"} → USDC ESCROW → ${route.payoutCurrency ?? "Payout currency pending"}`)}</p></div><dl><div><dt>DIRECTION</dt><dd>${escape(route.direction ?? plan?.facts?.direction ?? "Pending")}</dd></div><div><dt>BOOK</dt><dd>${escape(route.bookId ?? "Pending")}</dd></div><div><dt>POLICY</dt><dd data-outcome="${escape(String(policyOutcome).toLowerCase())}">${escape(policyOutcome)}</dd></div></dl></section>
      ${gate ? `<aside class="hard-gate" data-state="${gate.canQuoteOrFund ? "active" : String(policyOutcome).toLowerCase()}" aria-live="polite"><div><small>BACKEND HARD GATE</small><b>${gate.canQuoteOrFund ? "QUOTE + FUNDING AUTHORIZED" : "AUTOMATION STOPPED"}</b></div><span>${escape(gate.code)}</span><p>${escape(gate.canQuoteOrFund ? "The reviewed deal plan authorizes the quote and funding stages." : gateReasons.join(" ") || "The backend denied quote and funding for this deal.")}</p></aside>` : ""}
      <div class="automation-stream status-only" aria-label="Automated pipeline status">${items.map((item, index) => {
      const state = String(item.status ?? "PENDING").toLowerCase();
      return `<article data-state="${escape(state)}"><i>${state === "completed" ? "✓" : String(index + 1).padStart(2, "0")}</i><div><span><b>${escape(item.label)}</b><em>${escape(item.status)}</em></span><p>${escape(item.detail)}</p></div></article>`;
    }).join("")}</div>
      <section class="decision-trace"><header><span>COMPLIANCE OBLIGATION TRACE</span><b>${escape(categories.length ? `${categories.length} CATEGORIES` : "PENDING")}</b></header><div class="obligation-grid">${categoryRows}</div></section>
      <div class="trace-grid"><section class="decision-trace"><header><span>LIVE SOURCE REFRESH</span><b>${escape(observations.length ? `${observations.length} CHECKED` : "PENDING")}</b></header><div class="source-observations">${sourceRows || `<div class="trace-empty">Official-source observations will appear after refresh.</div>`}</div></section><section class="decision-trace"><header><span>TAX + DOCUMENT RESPONSIBILITIES</span><b>DEAL FILE</b></header><div class="responsibility-list">${documentRows}<div class="tax-duty"><span><b>TAX REVIEW</b><small>${escape(tax?.status ?? "PENDING")}</small></span><p>${escape(taxCopy)}</p></div></div></section></div>
      <section class="decision-trace payout-structure"><header><span>FX LEGS + PAYOUT STRUCTURE</span><b>${escape(quote?.rateSource ?? "QUOTE PENDING")}</b></header><div class="payout-plan"><span><small>PAYER FUNDS</small><b>${escape(quote ? money(quote.fundingAmount?.amountMinor, quote.fundingAmount?.scale, quote.fundingAmount?.currency) : route.fundingCurrency ?? "Pending")}</b></span><div class="fx-leg-list">${fxRows}</div><span><small>ESCROW LOCK</small><b>${escape(quote ? money(quote.settlementAmount?.amountMinor, quote.settlementAmount?.scale, "USDC") : "Pending")}</b></span><span><small>PAYEE RECEIVES</small><b>${escape(quote ? money(quote.payoutAmount?.amountMinor, quote.payoutAmount?.scale, quote.payoutAmount?.currency) : route.payoutCurrency ?? "Pending")}</b></span></div><p class="fee-line"><b>FEES</b> · ${escape(feeCopy)}</p></section>
      ${binding ? `<footer class="escrow-proof"><span><small>NETWORK</small><b>${escape(binding.network)}</b></span><span><small>ARC-4 APPLICATION</small><b>${escape(binding.applicationId)}</b></span><span><small>ASSET</small><b>${escape(binding.assetId)}</b></span><span><small>BINDING</small><b>${escape(shortRef(binding.bindingHash, 10))}</b></span></footer>` : ""}</section>`;
  }

  function submissionReview() {
    const submission = results().submission;
    if (!submission) return `<section class="workspace-card empty-state"><span>⇧</span><h2>WAITING FOR PRIVATE DELIVERY</h2><p>The selected freelancer uploads the actual deliverable. You receive authorized access while Fabric receives only its hash.</p></section>`;
    const advisory = results().workValidation;
    const delivery = model.run?.deliveryAutomation;
    const approveStep = firstStep("approve-work");
    const ready = model.run?.phase === "AWAITING_WORK_APPROVAL";
    return `<section class="workspace-card review-card"><header><span>DELIVERY REVIEW</span><b>${escape(delivery?.status ?? submission.status ?? "SUBMITTED")}</b></header><div class="review-file"><i>FILE</i><span><small>${escape(submission.fileName ?? "Private deliverable")}</small><b>${escape(submission.byteLength ? `${submission.byteLength} bytes` : "Stored in MinIO")}</b></span><a href="/api/workflow/submission/download" target="_blank" rel="noopener">DOWNLOAD ↗</a></div><div class="hash-panel"><small>FABRIC EVIDENCE · SHA-256</small><code>${escape(submission.fileHash)}</code></div><div class="agent-verdict"><span><small>ADVISORY VALIDATION</small><b>${escape(advisory?.score !== undefined ? `${advisory.score}/100` : delivery?.status ?? "RUNNING")}</b></span><p>${escape(advisory?.summary ?? delivery?.stages?.validation?.detail ?? "The validation agent is checking the deliverable against the accepted criteria.")}</p></div>${approveStep && !isDone(approveStep.id) && ready ? `<button class="primary-command" type="button" data-approve-work>APPROVE WORK + RELEASE PAYOUT <b>→</b></button>` : ""}<p class="advisory-note">The agent recommends. A company human approves. Release then proceeds automatically against Fabric evidence.</p></section>`;
  }

  function submissionReceipt() {
    const submission = results().submission;
    if (!submission) return waiting("DELIVERY NOT RECORDED", "Upload the private deliverable from the live delivery stage.");
    const advisory = results().workValidation;
    const delivery = model.run?.deliveryAutomation;
    return `<section class="workspace-card review-card"><header><span>YOUR DELIVERY RECORD</span><b>${escape(delivery?.status ?? submission.status ?? "SUBMITTED")}</b></header><div class="review-file"><i>FILE</i><span><small>${escape(submission.fileName ?? "Private deliverable")}</small><b>${escape(submission.byteLength ? `${submission.byteLength} bytes` : "Stored in MinIO")}</b></span><a href="/api/workflow/submission/download" target="_blank" rel="noopener">DOWNLOAD ↗</a></div><div class="hash-panel"><small>FABRIC EVIDENCE · SHA-256</small><code>${escape(submission.fileHash)}</code></div><div class="agent-verdict"><span><small>ADVISORY VALIDATION</small><b>${escape(advisory?.score !== undefined ? `${advisory.score}/100` : delivery?.status ?? "RUNNING")}</b></span><p>${escape(advisory?.summary ?? delivery?.stages?.validation?.detail ?? "The validation agent is checking the deliverable against the accepted criteria.")}</p></div><p class="advisory-note">Your private file remains in MinIO. Its Fabric evidence and the company decision are linked to the settlement release.</p></section>`;
  }

  function payoutCard() {
    const payment = results().payment;
    const binding = results().binding;
    const agreedFunding = results().quote?.fundingAmount ?? results().contractAmount ?? (results().job ? {
      amountMinor: results().job.budgetAmountMinor,
      currency: results().job.budgetCurrency,
      scale: results().job.budgetScale
    } : null);
    const completed = model.run?.phase === "COMPLETED" || payment?.state === "COMPLETED" || binding?.state === "COMPLETED";
    const quote = results().quote;
    const compliance = results().compliance;
    const route = dealRoute();
    const payout = quote?.payoutAmount ?? (payment?.payoutAmountMinor ? { amountMinor: payment.payoutAmountMinor, scale: payment.payoutScale, currency: payment.payoutCurrency } : null);
    return `<section class="workspace-card payout-card ${completed ? "complete" : ""}"><header><span>SECURED PAYOUT</span><b>${completed ? "COMPLETED" : escape(payment?.state ?? binding?.state ?? "PENDING")}</b></header><div class="payout-route"><span><small>AGREED PRICE</small><b>${escape(agreedFunding ? money(agreedFunding.amountMinor, agreedFunding.scale, agreedFunding.currency) : route.fundingCurrency ?? "PENDING")}</b></span><i>→</i><span><small>ESCROW LOCKS</small><b>${escape(binding ? money(binding.amountUsdcMinor, binding.scale ?? 6, "USDC") : "USDC · PENDING")}</b></span><i>→</i><span><small>YOU RECEIVE</small><b>${escape(payout ? money(payout.amountMinor, payout.scale, payout.currency) : route.payoutCurrency ?? "PENDING")}</b></span></div>${quote || compliance || binding ? `<div class="payout-reasoning"><span><small>WHY THIS AMOUNT</small><b>${escape(quote ? `${quote.legs?.length ?? 0} persisted FX legs · ${quote.rateSource}` : "Waiting for FX quote")}</b></span><span><small>WHY IT CAN SETTLE</small><b>${escape(compliance ? `${compliance.outcome} · ${compliance.appliedRules?.length ?? 0} rules` : "Compliance pending")}</b></span><span><small>WHERE IT IS LOCKED</small><b>${escape(binding ? `${binding.network} · app ${binding.applicationId} · asset ${binding.assetId}` : "Escrow pending")}</b></span></div>` : ""}<p>${completed ? `The local ${escape(payout?.currency ?? route.payoutCurrency ?? "payout")} credit is linked to the approved Fabric evidence and confirmed provider release.` : "The quoted USDC amount is fixed when funded, so later FX movement cannot change this escrow."}</p></section>`;
  }

  function moneyTransferScreen() {
    const payment = results().payment;
    const binding = results().binding;
    const quote = results().quote;
    const completed = model.run?.phase === "COMPLETED" || payment?.state === "COMPLETED";
    const companyAmount = quote?.fundingAmount ?? (payment ? { amountMinor: payment.fundingAmountMinor, scale: payment.fundingScale, currency: payment.fundingCurrency } : null);
    const payoutAmount = quote?.payoutAmount ?? (payment ? { amountMinor: payment.payoutAmountMinor, scale: payment.payoutScale, currency: payment.payoutCurrency } : null);
    const route = dealRoute();
    const payoutCurrency = payoutAmount?.currency ?? route.payoutCurrency ?? "LOCAL FIAT";
    return `<section class="money-transfer-screen" data-transfer-screen data-state="${completed ? "completed" : "releasing"}" aria-live="polite">
      <header><div><small>REAL SETTLEMENT EVENT</small><h3>${completed ? "PAYMENT LANDED." : "PAYMENT IS MOVING."}</h3><p>${completed ? `Algorand confirmed the provider release and the destination ledger recorded the local ${escape(payoutCurrency)} credit.` : "The approved Fabric evidence is authorizing the Algorand escrow release now."}</p></div><span>${completed ? "CONFIRMED" : "RELEASING"}</span></header>
      <div class="money-transfer-stage">
        <figure><div><img src="assets/optiwork-company-pixel.png" alt="Company representative"></div><figcaption><small>COMPANY · ${escape(countryLabel(route.originCountry).toUpperCase())}</small><b>WORK APPROVED</b><em>${escape(companyAmount ? money(companyAmount.amountMinor, companyAmount.scale, companyAmount.currency) : route.fundingCurrency ?? "PENDING")}</em></figcaption></figure>
        <div class="transfer-lane" aria-hidden="true"><small>FABRIC APPROVAL → ALGORAND ESCROW → ${escape(payoutCurrency)} CREDIT</small><div>${Array.from({ length: 9 }, (_, index) => `<i style="--packet:${index}">${index < 3 ? "✓" : index < 7 ? "$" : "●"}</i>`).join("")}</div><b>${completed ? "TRANSFER CONFIRMED" : "RELEASING SECURED VALUE"}</b></div>
        <figure><div><img src="assets/optiwork-freelancer-pixel.png" alt="Freelancer"></div><figcaption><small>FREELANCER · ${escape(countryLabel(route.destinationCountry).toUpperCase())}</small><b>${completed ? "MONEY RECEIVED" : "AWAITING CREDIT"}</b><em>${escape(payoutAmount ? money(payoutAmount.amountMinor, payoutAmount.scale, payoutAmount.currency) : payoutCurrency)}</em></figcaption></figure>
      </div>
      <dl class="transfer-proof"><div><dt>FABRIC DECISION</dt><dd>${escape(shortRef(results().fabricDecisionTxId, 10))}</dd></div><div><dt>ESCROW DEAL</dt><dd>${escape(shortRef(binding?.dealId, 10))}</dd></div><div><dt>NETWORK</dt><dd>${escape(binding?.network ?? "LOCALNET")}</dd></div></dl>
      ${completed ? `<section class="deal-complete-confirmation"><i>✓</i><div><small>PAYMENT CONFIRMATION</small><h4>DEAL COMPLETE.</h4><p>${escape(`${money(payoutAmount?.amountMinor, payoutAmount?.scale, payoutCurrency)} credited after Fabric-approved evidence released escrow ${shortRef(binding?.dealId, 8)}.`)}</p></div>${role === "COMPANY" ? '<button type="button" data-start-new-deal>START A NEW DEAL →</button>' : '<span>COMPANY + FREELANCER OBLIGATIONS CLOSED</span>'}</section>` : ""}
      <p class="transfer-explainer">The characters visualize the real provider-mediated flow. The company and freelancer remain fiat-only; neither user receives cryptocurrency or signs a blockchain transaction.</p>
    </section>`;
  }

  function showTransferScreen(phase) {
    return phase === "RELEASING" || phase === "COMPLETED" || Date.now() < transferAnimationUntil;
  }

  function waiting(title, copy) {
    return `<section class="workspace-card empty-state"><span>⌛</span><h2>${escape(title)}</h2><p>${escape(copy)}</p></section>`;
  }

  function jobBrief(job) {
    if (!job) return "";
    const skills = Array.isArray(job.skills) ? job.skills.join(" · ") : "See published brief";
    const payer = job.payerCountry ?? job.originCountry ?? job.organizationCountry;
    const funding = job.fundingCurrency ?? job.budgetCurrency;
    return `<section class="stage-brief"><span><small>LIVE OPPORTUNITY</small><b>${escape(job.title)}</b></span><span><small>PAYER + BUDGET</small><b>${escape(`${payer ?? "—"} · ${money(job.budgetAmountMinor, job.budgetScale, funding)}`)}</b></span><span><small>SKILLS</small><b>${escape(skills)}</b></span></section>`;
  }

  function stageScreen(number, eyebrow, title, copy, content, status = "ACTION REQUIRED") {
    return `<section class="stage-screen"><header class="stage-screen-head"><div class="stage-number"><small>STAGE</small><b>${escape(number)}</b></div><div class="stage-title"><small>${escape(eyebrow)}</small><h2>${escape(title)}</h2><p>${escape(copy)}</p></div><span class="stage-state"><i></i>${escape(status)}</span></header><div class="stage-screen-body">${content}</div></section>`;
  }

  function pairedStage(primary, secondary) {
    return `<div class="stage-content-grid">${primary}${secondary}</div>`;
  }

  function renderCompany() {
    const r = results();
    const phase = model.run?.phase;
    if (!companyPolicyProfile() && !r.job) return stageScreen("01", "VERIFIED COMPANY SETUP", "Store the reusable company policy", "The Authorization Agent already verified the legal entity, ownership/sanctions evidence and your tenant mandate. Now approve the separate policy source used for future agreements.", onboardingForm());
    if (!r.job) return stageScreen("02", "PUBLISH THE MISSION", "Create the work brief", "Describe only this engagement: outcome, acceptance proof, skills, budget and delivery date. Standard company policies come from onboarding.", `${policyProfileCard()}${jobForm()}`);
    if (!r.selectedApplicationId && !r.contract) return stageScreen("03", "SCREENING DESK", "Choose the right freelancer", "Live proposals are ranked by the advisory agent. You remain responsible for the final award.", `${jobBrief(r.job)}${applicantCards()}`, applications().length ? "HUMAN DECISION" : "WAITING FOR TALENT");
    if (phase === "AGREEMENT_DRAFT" || !agreement()) return stageScreen("04", "PRIVATE AGREEMENT", "Generate from approved sources", "The agreement agent combines the versioned company policy, job brief and selected proposal. No company policy is entered again.", termsForm(selectedApplication()));
    if (phase === "AWAITING_COMPANY_AGREEMENT") return stageScreen("04", "COMPANY REVIEW", "Review the generated agreement", "Inspect the document, clause provenance and exact hash. The AI cannot approve it for you.", agreementCard("COMPANY"), "COMPANY DECISION");
    if (phase === "AWAITING_FREELANCER_AGREEMENT") return stageScreen("04", "COUNTERPARTY REVIEW", "Agreement sent for acceptance", "The freelancer receives the same private document and must accept its exact SHA-256 hash.", agreementCard(), "WAITING FOR FREELANCER");
    if (!r.binding && phase !== "AWAITING_DELIVERY") return stageScreen("05", "ANCHOR AUTOPILOT", "Secure the cross-border escrow", "Official-source policy checks, live FX, compliance evidence and Algorand funding advance only when the backend hard gate authorizes them.", automationCard(), automationStatusLabel());
    if (!r.submission) return stageScreen("06", "DELIVERY DESK", "Escrow is secured", "The agreed settlement value is locked. The selected freelancer can now upload the private deliverable.", payoutCard(), "WAITING FOR DELIVERY");
    if (showTransferScreen(phase)) return stageScreen("06", "SETTLEMENT RAIL", phase === "COMPLETED" ? "The payout has arrived" : "Approved value is moving", "This screen follows the actual release state after the company approval was recorded on Fabric.", moneyTransferScreen(), phase === "COMPLETED" ? "TRANSFER COMPLETE" : "LIVE TRANSFER");
    return stageScreen("06", "EVIDENCE + RELEASE", phase === "COMPLETED" ? "Work approved. Payout complete." : "Review the private delivery", "Download the file, inspect the validation evidence, and authorize release only when the agreed criteria are met.", pairedStage(submissionReview(), payoutCard()), phase === "COMPLETED" ? "COMPLETED" : "HUMAN DECISION");
  }

  function renderFreelancer() {
    const r = results();
    const phase = model.run?.phase;
    if (!r.job) return stageScreen("01", "OPPORTUNITY DESK", "Waiting for verified work", "A published company brief will appear here. Company-only creation controls never appear in your portal.", opportunity(null), "LISTENING FOR BRIEFS");
    if (!hasDone("apply")) return stageScreen("02", "YOUR PROPOSAL", "Price and plan the work", "Review the live brief, then enter your own price, delivery timing, availability and technical approach.", `${jobBrief(r.job)}${applicationForm(r.job)}`);
    const selected = Boolean(r.selectedApplicationId || r.contract);
    if (!selected) return stageScreen("03", "SELECTION STATUS", "Your proposal is in review", "The screening agent ranks every real proposal; only the company can award the work.", `${jobBrief(r.job)}${waiting("PROPOSAL SUBMITTED", "Stay on this screen. The shared workflow updates automatically when the company chooses a freelancer.")}`, "SCREENING IN PROGRESS");
    if (!agreement()) return stageScreen("04", "AGREEMENT PREPARATION", "You were selected", "The agreement agent is combining the company onboarding profile, job brief and your selected proposal.", waiting("SOURCED AGREEMENT IS BEING PREPARED", "You will be asked to accept the exact agreement hash before any escrow can be funded."), "WAITING FOR COMPANY");
    if (phase === "AWAITING_COMPANY_AGREEMENT") return stageScreen("04", "COMPANY REVIEW", "The sourced agreement is awaiting company approval", "You can inspect the same private document, but the company must approve its exact hash first.", agreementCard(), "WAITING FOR COMPANY");
    if (phase === "AWAITING_FREELANCER_AGREEMENT" && !hasDone("agreement-approve")) return stageScreen("04", "BILATERAL APPROVAL", "Review the private agreement", "Download the document, verify every term and its source, then accept the exact hash only when you agree.", agreementCard("FREELANCER"));
    if (!r.binding && phase !== "AWAITING_DELIVERY") return stageScreen("05", "ANCHOR AUTOPILOT", "Watch escrow become secured", "Anchor checks the selected corridor and advances to FX and provider escrow only when the backend hard gate authorizes it.", automationCard(), automationStatusLabel());
    if (!r.submission) return stageScreen("06", "PRIVATE DELIVERY", "Submit the finished work", "Your bytes go to private object storage. Only the evidence hash and buyer decision go to Hyperledger Fabric.", pairedStage(submissionForm(), payoutCard()));
    if (showTransferScreen(phase)) return stageScreen("06", "SETTLEMENT RAIL", phase === "COMPLETED" ? "Your local payout has arrived" : "Your payout is moving", "The release follows the approved Fabric evidence and confirmed Algorand escrow state.", moneyTransferScreen(), phase === "COMPLETED" ? "MONEY RECEIVED" : "LIVE TRANSFER");
    return stageScreen("06", "DELIVERY + PAYOUT", phase === "COMPLETED" ? "Local payout complete" : "Delivery submitted", phase === "COMPLETED" ? `The company approved the Fabric evidence and the destination provider credited your local ${dealRoute().payoutCurrency ?? "fiat"} balance.` : "The company is reviewing your private file. The advisory agent cannot release funds.", pairedStage(submissionReceipt(), payoutCard()), phase === "COMPLETED" ? "COMPLETED" : "WAITING FOR COMPANY");
  }

  function proposalReceipt() {
    const application = applications().find(item => item.id === results().primaryApplicationId) ?? applications()[0];
    if (!application) return waiting("PROPOSAL NOT RECORDED", "Submit your price, timing and approach from the live stage.");
    return `<section class="workspace-card proposal-receipt"><header><span>YOUR RECORDED PROPOSAL</span><b>${escape(application.status ?? "SUBMITTED")}</b></header><div><span><small>PRICE</small><b>${escape(proposalPrice(application))}</b></span><span><small>DELIVERY</small><b>${escape(application.deliveryDays ? `${application.deliveryDays} days` : "—")}</b></span><span><small>PAYOUT</small><b>${escape(application.payoutCountry ? `${application.payoutCountry} · ${application.payoutCurrency ?? "pending"}` : "Pending")}</b></span><span><small>AGENT SCORE</small><b>${escape(application.evaluation?.score !== undefined ? `${application.evaluation.score}/100` : "Pending")}</b></span></div><p>${escape(application.evaluation?.summary ?? application.approach)}</p></section>`;
  }

  function renderInspection(number) {
    const r = results();
    let content;
    if (role === "COMPANY") {
      if (number === "01") content = stageScreen("01", "ONBOARDING RECORD", "The approved company policy source", "This reusable version was human-approved before any job was published.", policyProfileCard(), "COMPLETED");
      if (number === "02") content = stageScreen("02", "PUBLISHED RECORD", "The opportunity that started this deal", "This job-specific brief is shared with eligible freelancers.", opportunity(r.job), "COMPLETED");
      if (number === "03") content = stageScreen("03", "SCREENING RESULT", "How the company chose talent", "Scores and summaries are advisory outputs produced from the submitted proposal data.", `${jobBrief(r.job)}${applicantCards()}`, "COMPLETED");
      if (number === "04") content = stageScreen("04", "BILATERAL RECORD", "The exact agreement both parties accepted", "The document stays private in MinIO; every clause identifies its approved source.", agreementCard(), "COMPLETED");
      if (number === "05") content = stageScreen("05", "DECISION TRACE", "How compliance, FX and escrow were resolved", "Inspect the actual official-source, quote, policy and Algorand outputs used for this deal.", automationCard(), "COMPLETED");
      if (number === "06") content = stageScreen("06", "EVIDENCE + RELEASE", "How the work unlocked settlement", "Fabric evidence, advisory validation and the confirmed payout remain linked in one record.", pairedStage(submissionReview(), payoutCard()), model.run?.phase === "COMPLETED" ? "COMPLETED" : "RECORDED");
    } else {
      if (number === "01") content = stageScreen("01", "PUBLISHED OPPORTUNITY", "The company brief you reviewed", "This is the real opportunity record that your proposal references.", opportunity(r.job), "COMPLETED");
      if (number === "02") content = stageScreen("02", "PROPOSAL RECORD", "What you offered", "Your price, timing and approach were persisted before the company made its decision.", proposalReceipt(), "COMPLETED");
      if (number === "03") content = stageScreen("03", "SELECTION RESULT", "Why this proposal was selected", "The agent supplied advisory reasoning; the company remained responsible for selection.", proposalReceipt(), "COMPLETED");
      if (number === "04") content = stageScreen("04", "BILATERAL RECORD", "The agreement you accepted", "The exact artifact hash is shared only between the two contracting parties.", agreementCard(false), "COMPLETED");
      if (number === "05") content = stageScreen("05", "DECISION TRACE", "How your escrow amount was secured", "Inspect the actual regulation, compliance, FX and Algorand results behind the payout.", automationCard(), "COMPLETED");
      if (number === "06") content = stageScreen("06", "DELIVERY + PAYOUT", "How your evidence became local money", "The payout is tied to the company decision over the Fabric work-evidence record.", pairedStage(submissionReceipt(), payoutCard()), model.run?.phase === "COMPLETED" ? "COMPLETED" : "RECORDED");
    }
    return `<div class="history-banner"><span>Viewing persisted stage ${escape(number)}</span><button type="button" data-return-live>Return to live stage</button></div>${content ?? (role === "COMPANY" ? renderCompany() : renderFreelancer())}`;
  }

  function renderSnapshot() {
    const r = results();
    const item = agreement();
    const route = dealRoute();
    const plan = r.regulatoryPlan ?? r.regulation?.plan ?? r.regulation?.regulatoryPlan;
    const rows = [];
    if (r.job) rows.push(["OPPORTUNITY", r.job.title], ["BUDGET", money(r.job.budgetAmountMinor, r.job.budgetScale, r.job.budgetCurrency)]);
    if (applications().length) rows.push(["PROPOSALS", String(applications().length)]);
    if (selectedApplication()) rows.push(["SELECTED", selectedApplication().applicantDisplayName ?? selectedApplication().id]);
    if (route.originCountry && route.destinationCountry) rows.push(["ORDERED CORRIDOR", `${route.originCountry} → ${route.destinationCountry} · ${route.direction ?? "direction pending"}`]);
    if (item) rows.push(["AGREEMENT HASH", item.artifactHash ?? item.documentHash ?? item.contractHash]);
    if (plan) rows.push(
      ["POLICY OUTCOME", displayedPolicyOutcome(plan, r.regulation, r.compliance)],
      ["HARD GATE", plan.hardGate?.code ?? "Pending"]
    );
    if (r.regulation) rows.push([
      "RULE SOURCE",
      r.regulation.coverage?.outcome === "MANUAL_REVIEW"
        ? "HUMAN REVIEW REQUIRED"
        : `${r.regulation.report?.observations?.length ?? 0} OFFICIAL SOURCES CHECKED · ${r.regulation.coverage?.checks?.length ?? 0} OBLIGATIONS COVERED`
    ]);
    if (r.compliance) rows.push(["COMPLIANCE", `${r.compliance.outcome} · ${r.compliance.rulesVersion}`]);
    if (r.quote) rows.push(["FX LOCK", `${r.quote.rateSource} · ${r.quote.rateObservedAt}`]);
    if (r.binding) rows.push(["ARC-4 APP", r.binding.applicationId], ["ASA", r.binding.assetId], ["ESCROW", r.binding.dealId]);
    if (r.submission) rows.push(["FABRIC EVIDENCE", r.submission.evidenceId], ["FILE HASH", r.submission.fileHash]);
    $("#workspaceSnapshot").innerHTML = `<header>PRIVATE DEAL RECORD</header>${rows.length ? rows.map(([label, value]) => `<div><span>${escape(label)}</span><b>${escape(value)}</b></div>`).join("") : "<p>No deal record yet.</p>"}`;
  }

  function currentMachineStage() {
    const groups = [model.run?.automation?.stages, model.run?.deliveryAutomation?.stages, model.run?.screening?.stages].filter(Boolean);
    const rows = groups.flatMap(stages => Object.entries(stages).map(([id, value]) => ({ id, ...value })));
    return rows.find(stage => stage.status === "RUNNING") ?? rows.findLast?.(stage => ["FAILED", "REVIEW", "COMPLETED"].includes(stage.status)) ?? rows.at(-1);
  }

  function companionNarration() {
    const r = results();
    const phase = model.run?.phase ?? "COMPANY_ONBOARDING";
    const route = dealRoute();
    const company = role === "COMPANY";
    const selected = selectedApplication();
    const liveStage = currentMachineStage();
    const payout = r.quote?.payoutAmount ?? (r.payment?.payoutAmountMinor ? { amountMinor: r.payment.payoutAmountMinor, scale: r.payment.payoutScale, currency: r.payment.payoutCurrency } : null);
    const narration = {
      COMPANY_ONBOARDING: ["COMPANY SETUP", "Your company identity is authorized. Add the reusable policy source once; it will feed every agreement."],
      JOB_DRAFT: ["BRIEF THE MISSION", "Choose the payer country and currency for this job. Anchor will derive the legal corridor only after a freelancer is selected."],
      APPLICATIONS_OPEN: [company ? "PROPOSALS INCOMING" : "MAKE YOUR CASE", company ? `${applications().length} proposal${applications().length === 1 ? " is" : "s are"} currently attached to “${r.job?.title ?? "this job"}”.` : `Set your own price and destination country for “${r.job?.title ?? "this opportunity"}”.`],
      SCREENING: ["SCREENING LIVE", `The advisory agent is comparing ${applications().length} proposals by skills, price, timing and approach. The company keeps the final choice.`],
      COMPANY_SELECTION: [company ? "YOU CHOOSE" : "AWAITING THE COMPANY", selected ? `${selected.applicantDisplayName ?? "The selected freelancer"} is ranked and ready for the company's decision.` : "The ranking is complete; no award has been recorded yet."],
      AGREEMENT_DRAFT: ["AGREEMENT SOURCES READY", `${selected?.applicantDisplayName ?? "The freelancer"}'s proposal will be combined with the job brief and policy profile—not invented from a blank prompt.`],
      AWAITING_COMPANY_AGREEMENT: [company ? "CHECK BEFORE YOU ACCEPT" : "COMPANY IS REVIEWING", `Agreement ${shortRef(agreement()?.artifactHash ?? agreement()?.contractHash, 7)} is private in MinIO. Approval binds this exact hash.`],
      AWAITING_FREELANCER_AGREEMENT: [company ? "SENT FOR COUNTERSIGNING" : "YOUR APPROVAL IS NEEDED", `Both parties see agreement ${shortRef(agreement()?.artifactHash ?? agreement()?.contractHash, 7)}. Escrow cannot start until the freelancer accepts it.`],
      AUTOMATING_ESCROW: ["AUTOPILOT IS WORKING", liveStage?.detail ?? `${countryLabel(route.originCountry)} → ${countryLabel(route.destinationCountry)} rules, taxes and FX are being resolved.`],
      AUTOMATION_FAILED: ["SETTLEMENT STOPPED SAFELY", r.regulatoryPlan?.hardGate?.reasons?.[0] ?? model.run?.automation?.error ?? "The compliance hard gate stopped funding before any blockchain signature."],
      AWAITING_DELIVERY: [company ? "ESCROW IS READY" : "YOUR WORK CAN START", `${money(r.binding?.amountUsdcMinor, r.binding?.scale ?? 6, "USDC")} is locked on ${r.binding?.network ?? "Algorand"} for deal ${shortRef(r.binding?.dealId, 7)}.`],
      VALIDATING_DELIVERY: ["PROOF IS BEING CHECKED", liveStage?.detail ?? `Fabric evidence ${shortRef(r.submission?.evidenceId, 7)} is linked to the private file.`],
      VALIDATION_FAILED: ["VALIDATION NEEDS ATTENTION", liveStage?.detail ?? "The advisory validation did not complete; no release was authorized."],
      AWAITING_WORK_APPROVAL: [company ? "YOUR DECISION UNLOCKS PAYMENT" : "COMPANY REVIEW IN PROGRESS", `${r.submission?.fileName ?? "The delivery"} scored ${r.workValidation?.score ?? "—"}/100. Only a company approval can authorize release.`],
      RELEASING: ["PAYMENT IS MOVING", liveStage?.detail ?? `Fabric approval is releasing escrow ${shortRef(r.binding?.dealId, 7)} through the provider rail.`],
      RELEASE_FAILED: ["RELEASE HELD", liveStage?.detail ?? "The release did not confirm, so the workflow remains open and no duplicate payout is permitted."],
      COMPLETED: ["DEAL COMPLETE", `${money(payout?.amountMinor, payout?.scale, payout?.currency ?? route.payoutCurrency)} is credited. Fabric evidence, Algorand release and the local ledger now reconcile.`]
    };
    const [title, copy] = narration[phase] ?? ["LIVE DEAL GUIDE", `Current workflow state: ${phase.replaceAll("_", " ")}.`];
    return { phase, title, copy };
  }

  function renderCompanion() {
    const element = $("#dealCompanion");
    if (!element) return;
    const narration = companionNarration();
    const company = role === "COMPANY";
    element.dataset.phase = narration.phase.toLowerCase();
    $("#dealCompanionStage").textContent = `${company ? "COMPANY" : "FREELANCER"} GUIDE · ${narration.phase.replaceAll("_", " ")}`;
    $("#dealCompanionTitle").textContent = narration.title;
    $("#dealCompanionCopy").textContent = narration.copy;
    const character = $("#dealCompanionCharacter");
    character.src = company ? "assets/optiwork-company-pixel.png" : "assets/optiwork-freelancer-pixel.png";
    character.alt = `${company ? "Company" : "Freelancer"} workflow guide`;
  }

  function render() {
    const company = role === "COMPANY";
    const route = dealRoute();
    $("#portalWorkflow").dataset.role = role.toLowerCase();
    $("#workspaceEyebrow").textContent = company ? "COMPANY / HIRING COMMAND" : "FREELANCER / OPPORTUNITY DESK";
    $("#workspaceTitle").textContent = company ? "HIRE WITH PROOF BUILT IN." : "FIND WORK. GET PAID LOCALLY.";
    $("#workspaceIntro").textContent = company ? "Publish a real brief, compare multiple proposals, define the agreement and release only against approved evidence." : "Discover verified work, submit your own terms, review the private agreement and deliver into secured escrow.";
    $("#workspaceRailTitle").textContent = company ? "COMPANY JOURNEY" : "YOUR JOURNEY";
    $("#railRoleHint").textContent = company ? "YOU CONTROL COMPANY DECISIONS" : "YOU CONTROL FREELANCER ACTIONS";
    $("#portalNetworkRoute").textContent = route.originCountry && route.destinationCountry
      ? `NETWORK LIVE · ${route.originCountry} → ${route.destinationCountry}`
      : route.originCountry ? `NETWORK LIVE · ${route.originCountry} → PAYEE PENDING` : "NETWORK LIVE · ROUTE PENDING";
    const resetButton = $("#workflowReset");
    resetButton.hidden = !company || !model.run;
    resetButton.textContent = model.run?.phase === "COMPLETED" ? "START NEW DEAL" : "RESET CURRENT DEAL";
    $("#workspaceAction").innerHTML = inspectedStage ? renderInspection(inspectedStage) : company ? renderCompany() : renderFreelancer();
    renderRail();
    renderSnapshot();
    renderCompanion();
    bindActions();
  }

  function bindActions() {
    document.querySelectorAll("[data-inspect-stage]").forEach(button => button.addEventListener("click", () => { inspectedStage = button.dataset.inspectStage; render(); document.querySelector(".portal-main")?.scrollTo({ top: 0, behavior: "smooth" }); }));
    $("[data-return-live]")?.addEventListener("click", () => { inspectedStage = null; render(); document.querySelector(".portal-main")?.scrollTo({ top: 0, behavior: "smooth" }); });
    $("[data-start-new-deal]")?.addEventListener("click", reset);
    document.querySelectorAll("[data-select-application]").forEach(button => button.addEventListener("click", () => executeByIds(["select", "assign"], { applicationId: button.dataset.selectApplication })));
    $("[data-approve-company-agreement]")?.addEventListener("click", () => executeByIds(["agreement-company-approve"], { acceptedTermsHash: agreement()?.contractHash }));
    $("[data-approve-agreement]")?.addEventListener("click", () => executeByIds(["agreement-approve"], { acceptedTermsHash: agreement()?.contractHash }));
    $("[data-approve-work]")?.addEventListener("click", () => executeByIds(["approve-work"], { decision: "APPROVED", comment: "Reviewed against the agreed acceptance criteria and accepted." }));
    document.querySelectorAll("[data-draft-file]").forEach(input => input.addEventListener("change", () => extractDraft(input)));
    document.querySelectorAll("[data-country-select]").forEach(country => country.addEventListener("change", () => {
      const currency = country.form?.elements.namedItem(country.dataset.countrySelect);
      const expected = country.selectedOptions[0]?.dataset.currency;
      if (currency instanceof HTMLSelectElement && expected) currency.value = expected;
    }));
    document.querySelectorAll("[data-workspace-form]").forEach(form => {
      form.addEventListener("input", () => { form.dataset.dirty = "true"; });
      form.addEventListener("change", () => { form.dataset.dirty = "true"; });
      form.addEventListener("submit", submitForm);
    });
  }

  function inferredContentType(file) {
    if (file.type) return file.type;
    const extension = file.name.split(".").pop()?.toLowerCase();
    return ({ pdf: "application/pdf", txt: "text/plain", md: "text/markdown", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", rtf: "application/rtf", odt: "application/vnd.oasis.opendocument.text" })[extension] ?? "application/octet-stream";
  }

  async function filePayload(file) {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    return { fileName: file.name, contentType: inferredContentType(file), contentBase64: String(dataUrl).split(",")[1] };
  }

  function populate(form, name, value) {
    if (value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) return;
    const control = form.elements.namedItem(name);
    if (!control) return;
    control.value = Array.isArray(value) ? value.join(name === "skills" ? ", " : "\n") : String(value);
    control.dispatchEvent(new Event("input", { bubbles: true }));
    control.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function extractDraft(input) {
    if (busy) return;
    const file = input.files?.[0];
    if (!file) return;
    const form = input.closest("form");
    const status = form?.querySelector("[data-extraction-status]");
    const fileName = form?.querySelector("[data-draft-file-name]");
    if (!form || !status) return;
    if (fileName) fileName.textContent = file.name;
    if (file.size > 8 * 1024 * 1024) {
      status.dataset.tone = "error";
      status.textContent = "FILE TOO LARGE · USE A DOCUMENT UNDER 8 MB";
      input.value = "";
      return;
    }
    busy = true;
    input.disabled = true;
    status.dataset.tone = "working";
    status.textContent = `READING ${file.name.toUpperCase()} · EXTRACTING A REVIEWABLE DRAFT…`;
    try {
      const result = await request("/api/workflow/extract", {
        method: "POST",
        body: JSON.stringify({ purpose: input.dataset.extractPurpose, ...(await filePayload(file)) })
      });
      const fields = result.fields ?? {};
      if (input.dataset.extractPurpose === "COMPANY_POLICY") {
        populate(form, "policies", fields.policies);
        populate(form, "legalClauses", fields.legalClauses);
        populate(form, "commercialStandards", fields.commercialStandards);
        populate(form, "authorizedApprovers", fields.authorizedApprovers);
        populate(form, "extractionSource", result.source);
        populate(form, "extractionModel", result.model);
      } else if (input.dataset.extractPurpose === "JOB_BRIEF") {
        populate(form, "title", fields.title);
        populate(form, "description", fields.description);
        populate(form, "acceptanceCriteria", fields.acceptanceCriteria);
        populate(form, "skills", fields.skills);
        populate(form, "budget", fields.budget ?? fields.budgetAmount ?? fields.budgetPln);
        populate(form, "deliveryDate", fields.deliveryDate);
        populate(form, "payerCountry", fields.payerCountry ?? fields.companyCountry ?? fields.originCountry);
        populate(form, "fundingCurrency", fields.fundingCurrency ?? fields.currency);
      } else if (input.dataset.extractPurpose === "FREELANCER_PROPOSAL") {
        populate(form, "proposedPrice", fields.proposedPrice ?? fields.proposedPriceAmount ?? fields.proposedPricePln);
        populate(form, "deliveryDays", fields.deliveryDays);
        populate(form, "availability", fields.availability);
        populate(form, "approach", fields.approach);
        populate(form, "coverLetter", fields.coverLetter);
        populate(form, "residenceCountry", fields.residenceCountry);
        populate(form, "payoutCountry", fields.payoutCountry ?? fields.destinationCountry);
        populate(form, "payoutCurrency", fields.payoutCurrency);
      } else {
        populate(form, "commercialTerms", fields.commercialTerms);
        populate(form, "acceptanceCriteria", fields.acceptanceCriteria);
        populate(form, "policies", fields.policies);
        populate(form, "legalClauses", fields.legalClauses);
      }
      const warning = result.warnings?.[0];
      status.dataset.tone = warning ? "warning" : "success";
      status.textContent = warning
        ? `${file.name.toUpperCase()} · DRAFT PARTIALLY EXTRACTED · ${warning}`
        : `${file.name.toUpperCase()} · DRAFT FILLED BY ${result.source} · REVIEW EACH FIELD, THEN SUBMIT MANUALLY`;
    } catch (error) {
      status.dataset.tone = "error";
      status.textContent = `EXTRACTION FAILED · ${error.message} · MANUAL ENTRY STILL WORKS`;
    } finally {
      input.disabled = false;
      busy = false;
    }
  }

  async function submitForm(event) {
    event.preventDefault();
    if (!event.currentTarget.reportValidity()) return;
    const kind = event.currentTarget.dataset.workspaceForm;
    const data = new FormData(event.currentTarget);
    if (kind === "onboard") {
      if (countryCurrencies[data.get("companyCountry")] !== data.get("fundingCurrency")) return setStatus("COMPANY COUNTRY AND FUNDING CURRENCY DO NOT MATCH_", "error");
      const file = data.get("file");
      if (!(file instanceof File) || file.size === 0) return setStatus("UPLOAD THE COMPANY POLICY SOURCE DOCUMENT_", "error");
      return executeByIds(["onboard"], { companyCountry: data.get("companyCountry"), fundingCurrency: data.get("fundingCurrency"), ...(await filePayload(file)), policies: lines(data.get("policies")), legalClauses: lines(data.get("legalClauses")), commercialStandards: lines(data.get("commercialStandards")), authorizedApprovers: lines(data.get("authorizedApprovers")), extractionSource: data.get("extractionSource") || "FIXTURE", extractionModel: data.get("extractionModel") || "manual-review-v1" });
    }
    if (kind === "job") {
      if (countryCurrencies[data.get("payerCountry")] !== data.get("fundingCurrency")) return setStatus("PAYER COUNTRY AND FUNDING CURRENCY DO NOT MATCH_", "error");
      return executeByIds(["job"], { title: data.get("title"), description: data.get("description"), acceptanceCriteria: data.get("acceptanceCriteria"), skills: String(data.get("skills")).split(",").map(value => value.trim()).filter(Boolean), deliveryDate: data.get("deliveryDate"), payerCountry: data.get("payerCountry"), fundingCurrency: data.get("fundingCurrency"), budget: { amountMinor: String(Math.round(Number(data.get("budget")) * 100)), currency: data.get("fundingCurrency"), scale: 2 } });
    }
    if (kind === "apply") {
      if (countryCurrencies[data.get("payoutCountry")] !== data.get("payoutCurrency")) return setStatus("PAYOUT COUNTRY AND PAYOUT CURRENCY DO NOT MATCH_", "error");
      const fundingCurrency = results().job?.fundingCurrency ?? results().job?.budgetCurrency;
      return executeByIds(["apply"], { jobId: data.get("jobId"), coverLetter: data.get("coverLetter"), approach: data.get("approach"), availability: data.get("availability"), deliveryDays: Number(data.get("deliveryDays")), residenceCountry: data.get("residenceCountry"), payoutCountry: data.get("payoutCountry"), payoutCurrency: data.get("payoutCurrency"), proposedPrice: { amountMinor: String(Math.round(Number(data.get("proposedPrice")) * 100)), currency: fundingCurrency, scale: 2 } });
    }
    if (kind === "terms") return executeByIds(["terms"], {});
    if (kind === "submit") return executeByIds(["submit"], { ...(await filePayload(data.get("file"))), note: data.get("note") });
  }

  async function executeByIds(ids, payload = {}) {
    if (busy) return;
    const step = firstStep(...ids);
    if (!step) return setStatus(`WORKFLOW UPDATE REQUIRED · NO ${ids.join("/").toUpperCase()} COMMAND`, "error");
    inspectedStage = null;
    busy = true;
    setStatus(`${step.actor} · ${step.label} · WORKING_`, "working");
    try {
      await request(`/api/workflow/action/${step.id}`, { method: "POST", body: JSON.stringify(payload) });
      if (step.id === "approve-work") {
        transferAnimationUntil = Date.now() + 6_000;
        clearTimeout(transferAnimationTimer);
        transferAnimationTimer = setTimeout(() => { if (!busy) render(); }, 6_100);
      }
      await refresh({ follow: true });
      setStatus(`${step.label} COMPLETE · RESULT PERSISTED_`, "success");
    } catch (error) {
      setStatus(`ACTION FAILED · ${error.message}`, "error");
      await refresh();
    } finally { busy = false; }
  }

  async function refresh({ follow = false } = {}) {
    model = await request("/api/workspace/state");
    // A poll may start just before document extraction marks the UI busy. Do
    // not let that in-flight response replace the live form and detach the
    // controls that the extractor is about to populate.
    if (!follow && busy) return;
    if (!follow && (document.activeElement?.closest("[data-workspace-form]") || document.querySelector('[data-workspace-form][data-dirty="true"]'))) return;
    render();
  }

  async function reset() {
    if (role !== "COMPANY" || busy || !confirm("Start a new deal? This clears the shared live workspace for both Company and Freelancer. Existing ledger records remain auditable.")) return;
    inspectedStage = null;
    await request("/api/workflow/reset", { method: "POST" });
    await refresh({ follow: true });
    setStatus("FRESH WORKSPACE READY · NO BLOCKCHAIN ACTIONS YET_", "success");
  }

  async function init() {
    if (!initialized) {
      initialized = true;
      $("#workflowReset")?.addEventListener("click", reset);
      setInterval(() => { if (!busy && $("#portalWorld")?.classList.contains("open")) refresh().catch(() => {}); }, 3000);
    }
    try {
      await refresh({ follow: true });
      setStatus(`${role === "COMPANY" ? "HIRING WORKSPACE" : "FREELANCER WORKSPACE"} READY · REAL SERVICES CONNECTED_`);
    } catch (error) { setStatus(`WORKSPACE UNAVAILABLE · ${error.message}`, "error"); }
  }

  window.OptiWorkWorkflow = { init, setRole(nextRole) { role = nextRole === "FREELANCER" ? "FREELANCER" : "COMPANY"; inspectedStage = null; if (initialized) render(); } };
})();
