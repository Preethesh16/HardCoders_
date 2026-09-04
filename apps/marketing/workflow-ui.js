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
  let transferVisualizationPaymentId = null;
  let completedPaymentId = null;
  let completedView = "workflow";
  let analyticsRevealTimer = null;
  let routeOptimizerPaymentId = null;
  let routeOptimizerUntil = 0;
  let routeOptimizerTimer = null;
  let notificationToastTimer = null;
  const completionHoldMilliseconds = 4_500;
  const routeOptimizerHoldMilliseconds = 6_000;

  const $ = selector => document.querySelector(selector);
  const escape = value => String(value ?? "—").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
  const results = () => model.run?.results ?? {};
  const milestones = () => results().milestones ?? results().job?.milestones ?? [];
  const usesMilestoneReleases = () => milestones().length > 1;
  const activeMilestone = () => milestones()[results().activeMilestoneIndex ?? 0] ?? milestones()[0] ?? null;
  const stepState = id => model.run?.actions?.[
    (id === "submit" || id === "approve-work") && activeMilestone()?.id ? `${id}:${activeMilestone().id}` : id
  ];
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
  // Circle's public faucet supplies small, zero-value TestNet balances. Keep
  // public-network demonstrations within a transparent notional cap instead
  // of silently scaling the real fiat amount committed to the agreement.
  const testnetBudgetLimits = { PLN: 15, INR: 350, GBP: 3, EUR: 4, RUB: 350, KPW: 3500 };

  function isPublicTestnet() {
    return String(model.runtime?.network ?? "").toLowerCase() === "testnet";
  }

  function testnetBudgetLimit(currency) {
    return isPublicTestnet() ? testnetBudgetLimits[String(currency ?? "").toUpperCase()] : undefined;
  }

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

  function notificationStorageKey() {
    return `anchor.workflow.notifications.${role.toLowerCase()}`;
  }

  function notificationState() {
    try {
      const stored = JSON.parse(localStorage.getItem(notificationStorageKey()) ?? "null");
      return {
        items: Array.isArray(stored?.items) ? stored.items : [],
        readIds: Array.isArray(stored?.readIds) ? stored.readIds : []
      };
    } catch {
      return { items: [], readIds: [] };
    }
  }

  function saveNotificationState(state) {
    try {
      localStorage.setItem(notificationStorageKey(), JSON.stringify({
        items: state.items.slice(0, 50),
        readIds: state.readIds.slice(0, 100)
      }));
    } catch { /* The workflow remains usable when browser storage is unavailable. */ }
  }

  function workflowNotifications() {
    const run = model.run;
    if (!run) return [];
    const r = results();
    const runKey = run.startedAt ?? r.job?.id ?? "current";
    const action = id => run.actions?.[id];
    const done = id => action(id)?.status === "DONE";
    const createdAt = (id, fallback = run.startedAt) => action(id)?.completedAt ?? fallback ?? new Date(0).toISOString();
    const list = [];
    const add = (targetRole, id, title, summary, detail, timestamp, tone = "update") => {
      if (targetRole !== role || !timestamp) return;
      list.push({ id: `${runKey}:${targetRole}:${id}`, title, summary, detail, createdAt: timestamp, tone });
    };
    const job = r.job ?? {};
    const route = dealRoute();
    const actualApplication = applications().find(item => item.id === r.applicationId) ?? applications()[0];
    const selected = selectedApplication();

    if (done("job")) add(
      "FREELANCER", `job:${job.id ?? "published"}`, "NEW OPPORTUNITY",
      job.title ?? "A company published a new job",
      `${countryLabel(route.originCountry)} company · ${money(job.budget?.amountMinor ?? job.budgetMinor, job.budget?.scale ?? job.budgetScale, job.fundingCurrency ?? job.budgetCurrency)} · review the brief and submit your proposal.`,
      createdAt("job"), "opportunity"
    );
    if (done("apply")) add(
      "COMPANY", `proposal:${r.applicationId ?? "submitted"}`, "NEW FREELANCER PROPOSAL",
      `${actualApplication?.applicantDisplayName ?? "A freelancer"} applied for ${job.title ?? "your opportunity"}`,
      `${proposalPrice(actualApplication)} · ${actualApplication?.deliveryDays ?? "—"} days · proposal/resume is ready for agent screening.`,
      createdAt("apply", actualApplication?.submittedAt), "proposal"
    );
    if (done("select")) add(
      "FREELANCER", `selection:${r.selectedApplicationId ?? "selected"}`, "YOU WERE SELECTED",
      `${selected?.applicantDisplayName ?? "Your proposal"} was chosen by the company`,
      `${job.title ?? "The opportunity"} now moves to a private bilateral agreement. Review the exact terms before accepting.`,
      createdAt("select"), "success"
    );
    if (done("agreement-company-approve")) add(
      "FREELANCER", `agreement-company:${agreement()?.contractHash ?? "approved"}`, "AGREEMENT READY",
      "The company approved the private agreement",
      `Review and accept the exact document hash ${shortRef(agreement()?.artifactHash ?? agreement()?.contractHash, 8)} before escrow can be funded.`,
      createdAt("agreement-company-approve"), "agreement"
    );
    if (done("agreement-approve")) add(
      "COMPANY", `agreement-freelancer:${agreement()?.contractHash ?? "approved"}`, "AGREEMENT ACCEPTED",
      `${selected?.applicantDisplayName ?? "The freelancer"} accepted the exact terms`,
      `Both approvals bind agreement ${shortRef(agreement()?.artifactHash ?? agreement()?.contractHash, 8)}. Compliance, FX and escrow automation may now proceed.`,
      createdAt("agreement-approve"), "agreement"
    );

    const submissionActions = Object.entries(run.actions ?? {}).filter(([id, value]) => id.startsWith("submit:") && value?.status === "DONE");
    for (const [id, value] of submissionActions) {
      const milestoneId = id.slice("submit:".length);
      const milestone = milestones().find(item => item.id === milestoneId);
      add("COMPANY", `submission:${milestoneId}`, "WORK SUBMITTED", milestone?.title ?? r.submission?.fileName ?? "A deliverable is ready", `The private file is available for review. Its SHA-256 evidence was committed to Fabric for ${milestone?.title ?? "this delivery"}.`, value.completedAt, "delivery");
    }
    if (!submissionActions.length && done("submit")) add(
      "COMPANY", `submission:${r.submission?.evidenceId ?? "work"}`, "WORK SUBMITTED",
      r.submission?.fileName ?? "A deliverable is ready",
      `The private file is available for review. Fabric evidence ${shortRef(r.submission?.evidenceId, 8)} protects the approval decision.`,
      createdAt("submit", r.submission?.submittedAt), "delivery"
    );

    const paymentEntries = Array.isArray(r.milestonePayments) && r.milestonePayments.length
      ? r.milestonePayments
      : [{ milestone: activeMilestone(), timeline: r.settlementTimeline, payment: r.payment, quote: r.quote, binding: r.binding }];
    for (const [index, entry] of paymentEntries.entries()) {
      const timeline = entry.timeline ?? {};
      const payment = timeline.payment ?? entry.payment ?? {};
      const quote = timeline.quote ?? entry.quote ?? {};
      const binding = timeline.binding ?? entry.binding ?? {};
      const events = Array.isArray(timeline.events) ? timeline.events : [];
      const fiatEvent = events.find(event => event.kind === "FIAT_FUNDED");
      const lockedEvent = events.find(event => event.kind === "USDC_LOCKED");
      const payoutEvent = events.findLast?.(event => event.kind === "PAYOUT_CREDITED") ?? events.find(event => event.kind === "PAYOUT_CREDITED");
      const completedEvent = events.findLast?.(event => event.kind === "PAYMENT_COMPLETED") ?? events.find(event => event.kind === "PAYMENT_COMPLETED");
      const paymentId = payment.id ?? binding.paymentKey ?? `payment-${index + 1}`;
      const milestoneLabel = entry.milestone?.title ?? (paymentEntries.length > 1 ? `Milestone ${index + 1}` : job.title ?? "Deal");
      if (fiatEvent || lockedEvent || ["USDC_LOCKED", "WORK_PENDING", "COMPLETED"].includes(payment.state)) {
        const fundedAt = lockedEvent?.occurredAt ?? fiatEvent?.occurredAt ?? payment.updatedAt;
        add("COMPANY", `funded-company:${paymentId}`, "MONEY DEDUCTED & ESCROWED", milestoneLabel, `${money(quote.fundingAmount?.amountMinor, quote.fundingAmount?.scale, quote.fundingAmount?.currency ?? route.fundingCurrency)} left the company ledger; ${money(binding.amountUsdcMinor ?? quote.settlementAmount?.amountMinor, binding.scale ?? quote.settlementAmount?.scale ?? 6, "USDC")} is locked on ${binding.network ?? model.runtime?.network ?? "Algorand"}.`, fundedAt, "funding");
        add("FREELANCER", `funded-freelancer:${paymentId}`, "ESCROW SECURED", milestoneLabel, `${money(binding.amountUsdcMinor ?? quote.settlementAmount?.amountMinor, binding.scale ?? quote.settlementAmount?.scale ?? 6, "USDC")} is locked on the provider rail for this delivery. You never need a crypto wallet.`, fundedAt, "funding");
      }
      if (payoutEvent || completedEvent || payment.state === "COMPLETED") {
        const payoutAt = completedEvent?.occurredAt ?? payoutEvent?.occurredAt ?? payment.updatedAt;
        const payoutAmount = quote.payoutAmount ?? (payoutEvent ? { amountMinor: payoutEvent.detail?.payoutMinor, scale: payment.payoutScale ?? 2, currency: payoutEvent.detail?.payoutCurrency } : null);
        add("COMPANY", `released:${paymentId}`, "PAYMENT RELEASED", milestoneLabel, `${money(payoutAmount?.amountMinor, payoutAmount?.scale, payoutAmount?.currency ?? route.payoutCurrency)} was credited after Fabric-approved evidence unlocked the Algorand escrow.`, payoutAt, "success");
        add("FREELANCER", `received:${paymentId}`, paymentEntries.length > 1 ? "MILESTONE PAYMENT RECEIVED" : "TOTAL FUNDING RECEIVED", milestoneLabel, `${money(payoutAmount?.amountMinor, payoutAmount?.scale, payoutAmount?.currency ?? route.payoutCurrency)} reached your local payout ledger. The escrow, provider release and reconciliation are complete.`, payoutAt, "success");
      }
    }
    return list.sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  }

  function notificationTime(value) {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return "JUST NOW";
    return parsed.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).toUpperCase();
  }

  function renderNotificationCenter() {
    const state = notificationState();
    const unread = state.items.filter(item => !state.readIds.includes(item.id));
    const badge = $("#notificationBadge");
    if (badge) {
      badge.textContent = unread.length > 9 ? "9+" : String(unread.length);
      badge.hidden = unread.length === 0;
    }
    const button = $("#notificationButton");
    if (button) button.setAttribute("aria-label", unread.length ? `Open notifications, ${unread.length} unread` : "Open notifications");
    const roleLabel = $("#notificationRole");
    if (roleLabel) roleLabel.textContent = `${role} INBOX`;
    const list = $("#notificationList");
    if (!list) return;
    list.innerHTML = state.items.length
      ? state.items.map(item => `<article data-tone="${escape(item.tone)}" data-read="${state.readIds.includes(item.id)}"><i aria-hidden="true"></i><div><header><strong>${escape(item.title)}</strong><time datetime="${escape(item.createdAt)}">${escape(notificationTime(item.createdAt))}</time></header><b>${escape(item.summary)}</b><p>${escape(item.detail)}</p></div></article>`).join("")
      : '<p class="notification-empty">No workflow alerts yet. New deal events will appear here automatically.</p>';
  }

  function showNotificationToast(item) {
    const toast = $("#notificationToast");
    if (!toast || !item) return;
    clearTimeout(notificationToastTimer);
    $("#notificationToastLabel").textContent = `${role} · NEW ALERT`;
    $("#notificationToastTitle").textContent = item.title;
    $("#notificationToastCopy").textContent = item.summary;
    toast.hidden = false;
    requestAnimationFrame(() => toast.classList.add("visible"));
    notificationToastTimer = setTimeout(() => {
      toast.classList.remove("visible");
      setTimeout(() => { if (!toast.classList.contains("visible")) toast.hidden = true; }, 180);
    }, 5_000);
  }

  function syncNotifications({ announce = true } = {}) {
    const generated = workflowNotifications();
    const state = notificationState();
    const existing = new Map(state.items.map(item => [item.id, item]));
    const fresh = generated.filter(item => !existing.has(item.id));
    for (const item of generated) existing.set(item.id, item);
    state.items = [...existing.values()].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)).slice(0, 50);
    saveNotificationState(state);
    renderNotificationCenter();
    if (announce && fresh.length) showNotificationToast(fresh.at(-1));
  }

  function openNotificationCenter() {
    const popover = $("#notificationPopover");
    const button = $("#notificationButton");
    if (!popover || !button) return;
    popover.hidden = false;
    button.setAttribute("aria-expanded", "true");
    const state = notificationState();
    state.readIds = [...new Set([...state.readIds, ...state.items.map(item => item.id)])];
    saveNotificationState(state);
    renderNotificationCenter();
    $("#notificationClose")?.focus();
  }

  function closeNotificationCenter({ restoreFocus = false } = {}) {
    const popover = $("#notificationPopover");
    const button = $("#notificationButton");
    if (!popover || !button) return;
    popover.hidden = true;
    button.setAttribute("aria-expanded", "false");
    if (restoreFocus) button.focus();
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
    const heldDetail = r.payment?.state === "ESCROW_CREATED"
      ? "Escrow created · funding not confirmed"
      : r.payment?.state === "FIAT_FUNDED"
        ? "Fiat journaled · escrow not funded"
        : r.quote
          ? "Quote stored · funding not started"
          : "Stopped before signing";
    const escrowDetail = r.binding
      ? `${money(r.binding.amountUsdcMinor, r.binding.scale ?? 6, "USDC")} · ${r.binding.network}`
      : settlementHeld ? heldDetail : "Rules, FX and funding";
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
    const publicLimit = testnetBudgetLimit(fundingCurrency);
    return `<section class="workspace-card action-card"><header><span>COMPANY INPUT · REQUIRED</span><b>NEW BRIEF</b></header><form class="workspace-form" data-workspace-form="job">
      ${documentAutofill("JOB_BRIEF")}
      <div class="selected-talent"><small>AUTHORIZED COMPANY · JOB-LEVEL PAYER PROFILE</small><strong>${escape(companyVerificationProfile()?.legalName ?? "Verified demo company")}</strong><span>Choose the payer country for this job. Anchor switches to that country's signed demo entity and reuses the approved policy source; corridor law is evaluated after freelancer selection.</span></div>
      <label><span>WORK TITLE</span><input name="title" required minlength="4" autocomplete="off" placeholder="e.g. Build a settlement reconciliation service"></label>
      <label><span>SCOPE OF WORK</span><textarea name="description" required minlength="20" placeholder="Explain the problem, expected outcome and what must be delivered"></textarea></label>
      <label><span>ACCEPTANCE CRITERIA</span><textarea name="acceptanceCriteria" required minlength="10" placeholder="List the overall checks that apply to the complete project"></textarea></label>
      <label><span>REQUIRED SKILLS</span><input name="skills" required placeholder="TypeScript, PostgreSQL, reconciliation"></label>
      <div class="field-grid corridor-inputs"><label><span>PAYER COUNTRY</span><select name="payerCountry" data-country-select="fundingCurrency" required>${countryOptions(payerCountry)}</select></label><label><span>FUNDING CURRENCY</span><select name="fundingCurrency" required>${currencyOptions(fundingCurrency)}</select></label></div>
      <label><span>TARGET DELIVERY DATE</span><input name="deliveryDate" type="date" required></label>
      <section class="delivery-mode-selector"><header><small>PAYMENT RELEASE MODEL</small><b>CHOOSE HOW THE WORK WILL BE DELIVERED</b></header><div role="radiogroup" aria-label="Payment release model"><label><input type="radio" name="deliveryMode" value="SINGLE" data-delivery-mode checked><span><b>ONE COMPLETE DELIVERY</b><small>One escrow · one work submission · one final release</small></span></label><label><input type="radio" name="deliveryMode" value="MILESTONES" data-delivery-mode><span><b>MILESTONE RELEASES</b><small>2–5 independent escrows released as each deliverable is approved</small></span></label></div></section>
      <section class="single-delivery-editor" data-single-delivery><label><span>TOTAL PROJECT BUDGET · ${escape(fundingCurrency)}</span><input name="singleBudget" data-single-budget type="number" min="0.01" step="0.01" required placeholder="1.00"></label><p>Complete the work once, submit one final evidence file, and release the full escrow after company approval.</p><button type="button" data-download-job-brief>DOWNLOAD JOB BRIEF PDF ↓</button></section>
      <section data-milestone-delivery hidden><div class="field-grid"><label><span>NUMBER OF MILESTONES</span><select name="milestoneCount" data-milestone-count>${[2, 3, 4, 5].map(count => `<option value="${count}" ${count === 2 ? "selected" : ""}>${count} milestones</option>`).join("")}</select></label></div><section class="milestone-editor" data-milestone-editor data-public-limit="${publicLimit ?? ""}"></section><div class="milestone-total"><span><small>TOTAL PROJECT FUNDING</small><b data-milestone-total>0.00 ${escape(fundingCurrency)}</b></span><button type="button" data-download-job-brief>DOWNLOAD MILESTONE BRIEF PDF ↓</button></div></section>
      <input name="budget" data-budget-input type="hidden" value="0">
      ${publicLimit ? `<p class="form-hint" data-testnet-budget-hint>PUBLIC TESTNET FAUCET LIMIT · MAX ${publicLimit} ${escape(fundingCurrency)} FOR THIS LIVE ON-CHAIN DEMO. USE LOCALNET FOR LARGE NOTIONAL VALUES.</p>` : ""}
      <button type="submit">PUBLISH OPPORTUNITY <b>→</b></button><p class="form-hint" data-delivery-mode-hint>One complete delivery creates one Algorand escrow and releases the full value only against the final approved Fabric evidence.</p>
    </form></section>`;
  }

  function applicationForm(job) {
    return `<section class="workspace-card action-card"><header><span>YOUR PROPOSAL</span><b>PRIVATE UNTIL SUBMITTED</b></header><form class="workspace-form" data-workspace-form="apply">
      ${documentAutofill("FREELANCER_PROPOSAL")}
      <div class="field-grid"><label><span>PROPOSED PRICE · ${escape(job?.fundingCurrency ?? job?.budgetCurrency ?? "PAYER CURRENCY")}</span><input name="proposedPrice" type="number" min="0.01" step="0.01" required placeholder="10800.00"></label><label><span>DELIVERY · DAYS</span><input name="deliveryDays" type="number" min="1" max="365" required placeholder="21"></label></div>
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
    const item = activeMilestone();
    const milestoneBased = usesMilestoneReleases();
    return `<section class="workspace-card action-card"><header><span>${milestoneBased ? `PRIVATE DELIVERY · MILESTONE ${escape(item?.ordinal ?? 1)} OF ${escape(milestones().length)}` : "PRIVATE DELIVERY · FINAL SUBMISSION"}</span><b>ANY FILE TYPE</b></header><div class="milestone-delivery-brief"><small>${milestoneBased ? "CURRENT RELEASE GATE" : "FULL ESCROW RELEASE GATE"}</small><h3>${escape(milestoneBased ? item?.title ?? "Agreed milestone" : "Complete project delivery")}</h3><p>${escape(item?.deliverable ?? item?.description ?? "Deliver the complete agreed work.")}</p><b>${escape(item ? money(item.amountMinor, item.amountScale, item.amountCurrency) : "")}</b>${item?.acceptanceCriteria?.length ? `<ul>${item.acceptanceCriteria.map(value => `<li>${escape(value)}</li>`).join("")}</ul>` : ""}</div><form class="workspace-form" data-workspace-form="submit">
      <label class="workspace-file"><span>DELIVERABLE / SOURCE / PROOF</span><input name="file" type="file" required><b>SELECT THE ACTUAL FILE</b><small>No extension restriction. Bytes go to MinIO; SHA-256 evidence goes to Fabric.</small></label>
      <label><span>DELIVERY NOTE</span><textarea name="note" maxlength="2000" required placeholder="Explain what is included and how the company should validate it"></textarea></label>
      <button type="submit">UPLOAD + COMMIT EVIDENCE <b>→</b></button>
    </form></section>`;
  }

  function opportunity(job) {
    if (!job) return `<section class="workspace-card empty-state"><span>⌁</span><h2>WAITING FOR A VERIFIED OPPORTUNITY</h2><p>A company brief will appear here when it is published. You will never see company-only creation controls.</p></section>`;
    const skills = Array.isArray(job.skills) ? job.skills : [];
    const schedule = Array.isArray(job.milestones) ? job.milestones : [];
    const milestoneBased = schedule.length > 1;
    return `<section class="workspace-card opportunity-card"><header><span>OPEN OPPORTUNITY</span><b>${escape(job.status ?? "OPEN")}</b></header><div><p class="mini-label">PAYER · ${escape(job.payerCountry ?? job.originCountry ?? job.organizationCountry ?? "COMPANY COUNTRY PENDING")} · ${escape(job.fundingCurrency ?? job.budgetCurrency ?? "FUNDING CURRENCY PENDING")}</p><h2>${escape(job.title)}</h2><p>${escape(job.description)}</p><div class="opportunity-meta"><span><small>BUDGET</small><b>${escape(money(job.budgetAmountMinor, job.budgetScale, job.budgetCurrency))}</b></span><span><small>RELEASE MODEL</small><b>${milestoneBased ? `${escape(schedule.length)} milestone releases` : "One complete delivery"}</b></span><span><small>SKILLS</small><b>${escape(skills.join(" · ") || "See brief")}</b></span></div>${milestoneBased ? `<div class="opportunity-milestones">${schedule.map(item => `<article><i>${escape(String(item.ordinal).padStart(2, "0"))}</i><div><b>${escape(item.title)}</b><p>${escape(item.deliverable)}</p><small>${escape(money(item.amountMinor, item.scale ?? item.amountScale, item.currency ?? item.amountCurrency))} · due ${escape(item.dueDate)}</small></div></article>`).join("")}</div>` : ""}</div></section>`;
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
    const schedule = milestones();
    const scheduleView = schedule.length > 1 ? `<section class="agreement-milestone-schedule"><header><span>CONTRACTUAL RELEASE SCHEDULE</span><b>${schedule.length} ESCROWS AFTER APPROVAL</b></header>${schedule.map(milestone => `<article><i>${escape(String(milestone.ordinal).padStart(2, "0"))}</i><div><b>${escape(milestone.title)}</b><p>${escape(milestone.deliverable)}</p><small>${escape(money(milestone.amountMinor, milestone.amountScale, milestone.amountCurrency))} · due ${escape(milestone.dueDate)}</small></div></article>`).join("")}</section>` : "";
    return `<section class="workspace-card agreement-card"><header><span>PRIVATE LEGAL AGREEMENT</span><b>PARTIES ONLY</b></header><div class="agreement-document"><div class="document-icon">DOC<br><b>✓</b></div><div><small>${escape(item.fileName ?? "anchor-work-agreement.pdf")}</small><h2>SHARED BETWEEN COMPANY + SELECTED FREELANCER</h2><p>${escape(item.byteLength ? `${item.byteLength} encrypted bytes in MinIO` : "Encrypted source document stored in MinIO")}</p></div></div><div class="hash-panel"><small>AGREEMENT SHA-256</small><code>${escape(item.artifactHash ?? item.documentHash ?? item.sha256 ?? item.contractHash)}</code></div>${scheduleView}${rows.length ? `<dl class="agreement-terms">${rows.map(([label, value]) => `<div><dt>${label}</dt><dd>${escape(value)}</dd></div>`).join("")}</dl>` : ""}${sourceList}<div class="document-actions"><a href="${downloadUrl}" target="_blank" rel="noopener">DOWNLOAD AUTHORIZED DOCUMENT ↗</a>${approve}</div></section>`;
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

  function milestoneProgress() {
    const schedule = milestones();
    if (schedule.length <= 1) return "";
    const entries = results().milestonePayments ?? [];
    const activeId = activeMilestone()?.id;
    return `<section class="milestone-progress"><header><div><small>INDEPENDENT ESCROW SCHEDULE</small><h3>${schedule.length} proof-gated release${schedule.length === 1 ? "" : "s"}</h3></div><b>${escape(`${results().completedMilestoneCount ?? 0}/${schedule.length} RELEASED`)}</b></header><div>${schedule.map(item => {
      const entry = entries.find(value => value.milestoneId === item.id);
      const payment = entry?.timeline?.payment ?? entry?.payment;
      const binding = entry?.timeline?.binding ?? entry?.binding;
      const completed = item.state === "COMPLETED" || payment?.state === "COMPLETED" || binding?.state === "COMPLETED";
      const state = completed ? "COMPLETED" : item.id === activeId ? "ACTIVE" : item.state ?? payment?.state ?? "PENDING";
      return `<article data-state="${escape(state.toLowerCase())}"><i>${completed ? "✓" : escape(String(item.ordinal).padStart(2, "0"))}</i><div><small>${escape(state)}</small><b>${escape(item.title)}</b><p>${escape(money(item.amountMinor, item.amountScale, item.amountCurrency))} · ${escape(item.deliverable)}</p><code>${escape(binding?.dealId ? `ESCROW ${shortRef(binding.dealId, 7)}` : "ESCROW PENDING")}</code></div></article>`;
    }).join("")}</div></section>`;
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
    const item = activeMilestone();
    const milestoneBased = usesMilestoneReleases();
    return `${milestoneProgress()}<section class="workspace-card payout-card ${completed ? "complete" : ""}"><header><span>${milestoneBased ? `SECURED PAYOUT · MILESTONE ${escape(item?.ordinal ?? 1)}` : "SECURED PAYOUT · FINAL RELEASE"}</span><b>${completed ? "COMPLETED" : escape(payment?.state ?? binding?.state ?? "PENDING")}</b></header><div class="payout-route"><span><small>${milestoneBased ? "MILESTONE ALLOCATION" : "AGREED PRICE"}</small><b>${escape(agreedFunding ? money(agreedFunding.amountMinor, agreedFunding.scale, agreedFunding.currency) : route.fundingCurrency ?? "PENDING")}</b></span><i>→</i><span><small>ESCROW LOCKS</small><b>${escape(binding ? money(binding.amountUsdcMinor, binding.scale ?? 6, "USDC") : "USDC · PENDING")}</b></span><i>→</i><span><small>${milestoneBased ? "THIS RELEASE PAYS" : "YOU RECEIVE"}</small><b>${escape(payout ? money(payout.amountMinor, payout.scale, payout.currency) : route.payoutCurrency ?? "PENDING")}</b></span></div>${quote || compliance || binding ? `<div class="payout-reasoning"><span><small>WHY THIS AMOUNT</small><b>${escape(quote ? `${quote.legs?.length ?? 0} persisted FX legs · ${quote.rateSource}` : "Waiting for FX quote")}</b></span><span><small>WHY IT CAN SETTLE</small><b>${escape(compliance ? `${compliance.outcome} · ${compliance.appliedRules?.length ?? 0} rules` : "Compliance pending")}</b></span><span><small>WHERE IT IS LOCKED</small><b>${escape(binding ? `${binding.network} · app ${binding.applicationId} · asset ${binding.assetId}` : "Escrow pending")}</b></span></div>` : ""}<p>${completed ? `The local ${escape(payout?.currency ?? route.payoutCurrency ?? "payout")} credit is linked to approved Fabric evidence and the confirmed provider release.` : milestoneBased ? "This milestone has a distinct quote-fixed escrow. Other milestone funds cannot be released by this evidence." : "The complete project value is quote-fixed in one escrow and releases once after final evidence approval."}</p></section>`;
  }

  function formatInstant(value) {
    if (!value) return "—";
    const instant = new Date(value);
    if (!Number.isFinite(instant.getTime())) return String(value);
    return `${instant.toLocaleString("en-GB", {
      day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false, timeZone: "UTC"
    })} UTC`;
  }

  function minorRemainder(total, deduction, net) {
    try {
      return BigInt(total ?? 0) - BigInt(deduction ?? 0) - BigInt(net ?? 0);
    } catch {
      return null;
    }
  }

  function absoluteMinorDifference(left, right) {
    try {
      const difference = BigInt(left ?? 0) - BigInt(right ?? 0);
      return difference < 0n ? -difference : difference;
    } catch {
      return null;
    }
  }

  function durationLabel(milliseconds) {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return "—";
    const seconds = Math.round(milliseconds / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return `${minutes}m ${remainder}s`;
  }

  function settlementRouterPanel(timeline, compact = false) {
    const decision = timeline?.settlementRoute;
    if (!decision) return "";
    const candidates = Array.isArray(decision.candidates) ? decision.candidates : [];
    const rows = candidates.map(candidate => {
      const quote = candidate.quote ?? {};
      return `<article data-selected="${quote.quoteId === decision.selectedQuoteId}" data-eligible="${candidate.eligible}"><header><div><small>${escape(quote.demoOnly ? "DEMO PROVIDER ADAPTER" : "PROVIDER")}</small><b>${escape(quote.providerLabel ?? quote.providerId ?? "Unknown provider")}</b></div><em>${candidate.eligible ? quote.quoteId === decision.selectedQuoteId ? "SELECTED" : "ELIGIBLE" : "REJECTED"}</em></header><dl><div><dt>NET PAYOUT</dt><dd>${escape(money(quote.recipientAmount?.amountMinor, quote.recipientAmount?.scale, quote.recipientAmount?.currency))}</dd></div><div><dt>ETA</dt><dd>${escape(quote.estimatedSettlementSeconds !== undefined ? `${quote.estimatedSettlementSeconds}s` : "—")}</dd></div><div><dt>RELIABILITY</dt><dd>${escape(quote.reliabilityBasisPoints !== undefined ? `${(quote.reliabilityBasisPoints / 100).toFixed(2)}%` : "—")}</dd></div><div><dt>VALID UNTIL</dt><dd>${escape(formatInstant(quote.expiresAt))}</dd></div></dl><p>${escape(candidate.eligible ? quote.quoteId === decision.selectedQuoteId ? decision.reasonCodes?.[0] ?? "Best eligible exact net payout." : "Passed every hard constraint; ranked below the selected route." : (candidate.reasonCodes ?? []).join(" · "))}</p></article>`;
    }).join("");
    return `<section class="settlement-router-panel ${compact ? "compact" : ""}" aria-label="Dynamic settlement provider routing"><header><div><small>LIVE SETTLEMENT ROUTER</small><h4>${escape(decision.selectedProviderId ?? "NO ELIGIBLE ROUTE")}</h4><p>Hard constraints ran before deterministic economics. Rejected routes never received fund authority.</p></div><span data-state="${decision.status === "SELECTED" ? "selected" : "rejected"}">${escape(decision.status)}</span></header><div>${rows || '<p class="settlement-empty">No provider candidates were persisted.</p>'}</div><footer><span><small>FRESH FX ORACLE</small><b>${escape(shortRef(decision.fxOracleHash, 10))}</b></span><span><small>AUTHORIZED ROUTE HASH</small><b>${escape(shortRef(decision.routeHash, 10))}</b></span><span><small>RANKING</small><b>${escape(String(decision.rankingRule ?? "DETERMINISTIC").replaceAll("_", " "))}</b></span></footer></section>`;
  }

  function settlementRouteOptimizerScreen() {
    const r = results();
    const timeline = r.settlementTimeline?.settlementRoute ? r.settlementTimeline : r.lastSettlementTimeline ?? r.settlementTimeline ?? {};
    const decision = timeline.settlementRoute;
    const events = Array.isArray(timeline.events) ? timeline.events : [];
    const routeEvent = events.findLast?.(event => event.kind === "SETTLEMENT_ROUTE_SELECTED") ?? events.find(event => event.kind === "SETTLEMENT_ROUTE_SELECTED");
    const authorizationEvent = events.findLast?.(event => event.kind === "RELEASE_AUTHORIZED") ?? events.find(event => event.kind === "RELEASE_AUTHORIZED");
    const releaseEvent = events.findLast?.(event => event.kind === "USDC_RELEASED") ?? events.find(event => event.kind === "USDC_RELEASED");
    const candidates = Array.isArray(decision?.candidates) ? decision.candidates : [];
    const rejected = candidates.filter(candidate => !candidate.eligible).length;
    const eligible = candidates.filter(candidate => candidate.eligible).length;
    const stages = [
      { label: "FABRIC GATE", detail: shortRef(r.fabricDecisionTxId, 8), done: Boolean(r.fabricDecisionTxId) },
      { label: "QUOTE PROVIDERS", detail: decision ? `${candidates.length} returned` : "Requesting signed quotes", done: Boolean(decision) },
      { label: "HARD CONSTRAINTS", detail: decision ? `${eligible} passed · ${rejected} rejected` : "Compliance · asset · liquidity · expiry", done: Boolean(decision) },
      { label: "ECONOMIC RANKING", detail: decision?.selectedProviderId ?? "Highest exact net payout wins", done: Boolean(decision?.selectedProviderId) },
      { label: "ROUTE COMMITMENT", detail: decision ? shortRef(decision.routeHash, 8) : "Awaiting canonical hash", done: Boolean(routeEvent) },
      { label: "ALGORAND RELEASE", detail: releaseEvent ? `Confirmed ${shortRef(releaseEvent.detail?.transactionId, 8)}` : authorizationEvent ? "Signed permit · broadcasting" : "Waiting for route authorization", done: Boolean(releaseEvent), live: Boolean(authorizationEvent) && !releaseEvent },
    ];
    const stageRows = stages.map((stage, index) => `<li data-state="${stage.done ? "done" : stage.live ? "live" : index === stages.findIndex(item => !item.done && !item.live) ? "live" : "pending"}"><i>${stage.done ? "✓" : String(index + 1).padStart(2, "0")}</i><div><b>${escape(stage.label)}</b><span>${escape(stage.detail)}</span></div></li>`).join("");
    return `<section class="route-optimizer-live" data-route-optimizer aria-live="polite" data-ready="${Boolean(decision)}">
      <header><div><small>ACTUAL PERSISTED BACKEND DECISION</small><h3>${decision ? "ROUTE SELECTED. RELEASE AUTHORIZED." : "ROUTE OPTIMIZER IS RUNNING."}</h3><p>${decision ? `${candidates.length} provider paths were checked. Hard gates rejected unsafe routes before deterministic payout ranking.` : "The payment service is fetching fresh FX, requesting provider quotes and applying non-negotiable settlement constraints now."}</p></div><span>${decision ? "DECISION SEALED" : "DISCOVERING"}</span></header>
      <ol class="route-optimizer-path">${stageRows}</ol>
      ${decision ? settlementRouterPanel(timeline) : `<section class="route-provider-wait"><i></i><div><b>WAITING FOR PERSISTED PROVIDER QUOTES</b><p>No provider result is invented in the browser. This view advances only when the API stores the real comparison.</p></div></section>`}
      <footer><span><small>CORRIDOR</small><b>${escape(`${dealRoute().originCountry ?? "—"} → ${dealRoute().destinationCountry ?? "—"}`)}</b></span><span><small>DECIDED AT</small><b>${escape(formatInstant(decision?.decidedAt ?? routeEvent?.occurredAt))}</b></span><span><small>AUTHORIZATION</small><b>${escape(authorizationEvent ? `GENERATION ${authorizationEvent.detail?.generation ?? "—"}` : "PENDING")}</b></span></footer>
    </section>`;
  }

  function settlementReceipt() {
    const r = results();
    const timeline = r.settlementTimeline ?? {};
    const payment = timeline.payment ?? r.payment ?? {};
    const quote = timeline.quote ?? r.quote ?? {};
    const compliance = timeline.compliance ?? r.compliance ?? {};
    const corridor = timeline.corridor ?? {};
    const binding = timeline.binding ?? r.binding ?? {};
    const reconciliation = timeline.reconciliation ?? {};
    const regulation = r.regulation ?? {};
    const plan = r.regulatoryPlan ?? regulation.plan ?? regulation.regulatoryPlan ?? {};
    const categories = Array.isArray(plan.categories) ? plan.categories : [];
    const observations = Array.isArray(regulation.report?.observations) ? regulation.report.observations : [];
    const milestonePayments = Array.isArray(r.milestonePayments) ? r.milestonePayments : [];
    const milestoneTimelines = milestonePayments.map(entry => entry.timeline ?? {}).filter(Boolean);
    const events = milestoneTimelines.length
      ? milestoneTimelines.flatMap(item => Array.isArray(item.events) ? item.events : [])
      : Array.isArray(timeline.events) ? timeline.events : [];
    const commands = milestoneTimelines.length
      ? milestoneTimelines.flatMap(item => Array.isArray(item.commands) ? item.commands : [])
      : Array.isArray(timeline.commands) ? timeline.commands : [];
    const quoteSeries = (milestonePayments.length
      ? milestonePayments.map(entry => entry.timeline?.quote ?? entry.quote)
      : [quote]).filter(Boolean);
    const sumMinor = values => values.reduce((total, value) => total + BigInt(value ?? 0), 0n).toString();
    const aggregateAmount = (selector, fallback = {}) => {
      const values = quoteSeries.map(selector).filter(value => value?.amountMinor !== undefined);
      return values.length ? { ...values[0], amountMinor: sumMinor(values.map(value => value.amountMinor)) } : fallback;
    };
    const fundingAmount = aggregateAmount(item => item.fundingAmount, quote.fundingAmount);
    const settlementAmount = aggregateAmount(item => item.settlementAmount, quote.settlementAmount);
    const payoutAmount = aggregateAmount(item => item.payoutAmount, quote.payoutAmount);
    const grossSettlementAmount = aggregateAmount(item => item.grossSettlementAmount, quote.grossSettlementAmount);
    const grossPayoutAmount = aggregateAmount(item => item.grossPayoutAmount, quote.grossPayoutAmount);
    const fees = Array.isArray(quote.fees) ? quote.fees : [];
    const baseLegs = Array.isArray(quote.legs) ? quote.legs : [];
    const legs = baseLegs.map((leg, index) => ({
      ...leg,
      from: aggregateAmount(item => item.legs?.[index]?.from, leg.from),
      to: aggregateAmount(item => item.legs?.[index]?.to, leg.to),
    }));
    const aggregateFee = (code, fallback) => aggregateAmount(item => item.fees?.find(fee => fee.code === code)?.amount, fallback);
    const originFee = aggregateFee("ORIGIN_AND_PLATFORM", { amountMinor: "0", scale: 6, currency: "USD" });
    const destinationFee = aggregateFee("DESTINATION_OFFRAMP", { amountMinor: "0", scale: payoutAmount?.scale ?? 2, currency: payoutAmount?.currency ?? payment.payoutCurrency });
    const releaseEvent = events.findLast?.(event => event.kind === "USDC_RELEASED") ?? events.find(event => event.kind === "USDC_RELEASED");
    const regulationEvent = events.findLast?.(event => event.kind === "REGULATIONS_REFRESHED") ?? events.find(event => event.kind === "REGULATIONS_REFRESHED");
    const complianceEvent = events.findLast?.(event => event.kind === "COMPLIANCE_EVALUATED") ?? events.find(event => event.kind === "COMPLIANCE_EVALUATED");
    const fxEvent = events.findLast?.(event => event.kind === "FX_QUOTED") ?? events.find(event => event.kind === "FX_QUOTED");
    const expectedEscrow = settlementAmount?.amountMinor ?? binding.amountUsdcMinor ?? "0";
    const observedEscrow = milestoneTimelines.length
      ? sumMinor(milestoneTimelines.map(item => item.reconciliation?.observed?.amountUsdcMinor ?? item.binding?.amountUsdcMinor))
      : reconciliation.observed?.amountUsdcMinor ?? binding.amountUsdcMinor ?? "0";
    const releasedEscrow = milestoneTimelines.length
      ? sumMinor(milestoneTimelines.map(item => item.events?.findLast?.(event => event.kind === "USDC_RELEASED")?.detail?.releasedMinor ?? item.binding?.releasedMinor ?? item.binding?.amountUsdcMinor))
      : releaseEvent?.detail?.releasedMinor ?? binding.releasedMinor ?? expectedEscrow;
    const escrowDifference = absoluteMinorDifference(expectedEscrow, observedEscrow);
    const releaseDifference = absoluteMinorDifference(expectedEscrow, releasedEscrow);
    const originRemainder = minorRemainder(grossSettlementAmount?.amountMinor, originFee.amountMinor, settlementAmount?.amountMinor);
    const destinationRemainder = minorRemainder(grossPayoutAmount?.amountMinor, destinationFee.amountMinor, payoutAmount?.amountMinor);
    const reconciliationRecords = milestoneTimelines.length ? milestoneTimelines.map(item => item.reconciliation ?? {}) : [reconciliation];
    const fullyAccounted = reconciliationRecords.every(item => item.status === "MATCHED" && item.observed?.booksBalanced === true)
      && escrowDifference === 0n
      && releaseDifference === 0n
      && originRemainder === 0n
      && destinationRemainder === 0n;
    const route = dealRoute();
    const categoryRows = categories.length ? categories.map(category => `<article><header><b>${escape(String(category.category ?? "OBLIGATION").replaceAll("_", " "))}</b><em data-state="${escape(String(category.status ?? "PENDING").toLowerCase())}">${escape(category.status ?? "PENDING")}</em></header><p>${escape(category.requirements?.[0] ?? category.reasons?.[0] ?? category.reason ?? "Deal-derived rule evaluated.")}</p><small>${escape(category.moduleIds?.join(" · ") ?? `${category.sourceReferences?.length ?? 0} source references`)}</small></article>`).join("") : `<p class="settlement-empty">No obligation categories were projected.</p>`;
    const rules = Array.isArray(compliance.appliedRules) ? compliance.appliedRules : [];
    const auditEvents = events.filter(event => event.kind !== "DOCUMENT_RECORDED");
    const explorerBase = timeline.explorerBaseUrl;
    const commandRows = commands.length ? commands.map(command => {
      const transaction = command.transactionId
        ? explorerBase ? `<a href="${escape(`${explorerBase}/transaction/${command.transactionId}`)}" target="_blank" rel="noopener">${escape(shortRef(command.transactionId, 9))} ↗</a>` : `<code>${escape(shortRef(command.transactionId, 9))}</code>`
        : "—";
      return `<div><span><small>${escape(String(command.action ?? "COMMAND").toUpperCase())}</small><b>${escape(command.status ?? "UNKNOWN")}</b></span><span><small>TRANSACTION</small>${transaction}</span><span><small>CONFIRMED</small><b>${escape(command.confirmedRound ? `ROUND ${command.confirmedRound}` : formatInstant(command.updatedAt))}</b></span></div>`;
    }).join("") : `<p class="settlement-empty">No provider commands were projected.</p>`;
    const submissionEvent = events.findLast?.(event => event.kind === "WORK_SUBMITTED") ?? events.find(event => event.kind === "WORK_SUBMITTED");
    const approvalEvent = events.findLast?.(event => event.kind === "WORK_APPROVED") ?? events.find(event => event.kind === "WORK_APPROVED");
    const eventInstants = auditEvents
      .map(event => new Date(event.occurredAt).getTime())
      .filter(Number.isFinite)
      .sort((left, right) => left - right);
    const processingDuration = eventInstants.length > 1
      ? durationLabel(eventInstants.at(-1) - eventInstants[0])
      : "—";
    const confirmedCommands = commands.filter(command => command.transactionId || command.confirmedRound).length;
    const sourceCount = observations.length || categories.reduce((total, category) => total + (category.sourceReferences?.length ?? 0), 0);
    const milestoneSettlementRows = milestonePayments.map((entry, index) => {
      const entryTimeline = entry.timeline ?? {};
      const entryPayment = entryTimeline.payment ?? entry.payment ?? {};
      const entryBinding = entryTimeline.binding ?? entry.binding ?? {};
      const entryQuote = entryTimeline.quote ?? entry.quote ?? {};
      const release = entryTimeline.events?.findLast?.(event => event.kind === "USDC_RELEASED");
      return `<article data-state="${entryPayment.state === "COMPLETED" ? "completed" : "pending"}"><i>${entryPayment.state === "COMPLETED" ? "✓" : escape(String(index + 1).padStart(2, "0"))}</i><div><small>MILESTONE ${escape(entry.milestone?.ordinal ?? index + 1)} · ${escape(entryPayment.state ?? "PENDING")}</small><b>${escape(entry.milestone?.title ?? "Milestone release")}</b><p>${escape(money(entryQuote.fundingAmount?.amountMinor ?? entry.milestone?.amountMinor, entryQuote.fundingAmount?.scale ?? entry.milestone?.amountScale, entryQuote.fundingAmount?.currency ?? entry.milestone?.amountCurrency))} → ${escape(money(entryQuote.payoutAmount?.amountMinor, entryQuote.payoutAmount?.scale, entryQuote.payoutAmount?.currency))}</p><code>${escape(shortRef(entryBinding.dealId, 8))} · ${escape(shortRef(release?.detail?.transactionId, 8))}</code></div></article>`;
    }).join("");

    const fxLegRows = legs.map(leg => `<div><span><small>${escape(leg.pair ?? "FX LEG")}</small><b>× ${escape(rate(leg.rateUnits, leg.rateScale))}</b></span><span><small>FROM</small><b>${escape(money(leg.from?.amountMinor, leg.from?.scale, leg.from?.currency))}</b></span><span><small>TO</small><b>${escape(money(leg.to?.amountMinor, leg.to?.scale, leg.to?.currency))}</b></span></div>`).join("");

    return `<section class="settlement-receipt settlement-receipt-minimal" aria-label="Complete transaction summary">
      <section class="analytics-intelligence" data-analytics-section="intelligence">
        <header><div><small>END-TO-END SETTLEMENT INTELLIGENCE</small><h3>${escape(`${countryLabel(route.originCountry)} → ${countryLabel(route.destinationCountry)}`)}</h3><p>The exact policy, quote, escrow, evidence and payout generated by this completed deal.</p></div><span data-state="${fullyAccounted ? "matched" : "mismatched"}">${fullyAccounted ? "RECONCILED · 100% ACCOUNTED" : "MISMATCH FOUND"}</span></header>
        <div class="settlement-identifiers"><div><small>CONTRACT</small><b>${escape(r.contractId ?? binding.dealId)}</b></div><div><small>CORRIDOR</small><b>${escape(`${route.originCountry} → ${route.destinationCountry} · ${payment.direction ?? corridor.direction ?? "—"}`)}</b></div><div><small>BOOK</small><b>${escape(payment.bookId ?? "—")}</b></div><div><small>COMPLETED</small><b>${escape(formatInstant(payment.updatedAt))}</b></div></div>
      </section>
      <section class="settlement-command-center" data-analytics-section="at-a-glance">
        <div class="settlement-value-story"><small>THE SETTLEMENT, AT A GLANCE</small><div><span><em>COMPANY COMMITTED</em><b>${escape(money(fundingAmount?.amountMinor, fundingAmount?.scale, fundingAmount?.currency))}</b></span><i>→</i><span class="stable-value"><em>VALUE LOCKED</em><b>${escape(money(settlementAmount?.amountMinor, settlementAmount?.scale, "USDC"))}</b><small>ASA ${escape(binding.assetId ?? "—")}</small></span><i>→</i><span><em>FREELANCER RECEIVED</em><b>${escape(money(payoutAmount?.amountMinor, payoutAmount?.scale, payoutAmount?.currency))}</b></span></div><p>Both parties remain in local fiat; provider accounts handle the public TestNet settlement rail.</p></div>
        <div class="settlement-kpis" aria-label="Settlement analytics"><article><small>PROCESSING WINDOW</small><b>${escape(processingDuration)}</b><span>first to final event</span></article><article><small>POLICY COVERAGE</small><b>${escape(`${categories.length} modules`)}</b><span>${escape(`${sourceCount} official sources`)}</span></article><article><small>MILESTONE ESCROWS</small><b>${escape(String(Math.max(1, milestonePayments.length)))}</b><span>independently released</span></article><article><small>ON-CHAIN PROOF</small><b>${escape(`${confirmedCommands}/${commands.length} confirmed`)}</b><span>${escape(binding.network ?? "network pending")}</span></article></div>
      </section>
      <section class="settlement-panel blockchain-proof" data-analytics-section="trust-proof"><header><span>TRUST RAIL PROOF</span><b>${escape(`${binding.network ?? "—"} · ${commands.length} COMMANDS`)}</b></header><div class="trust-proof-grid"><article><small>HYPERLEDGER FABRIC</small><b>WORK EVIDENCE + BUYER DECISION</b><p>Submission tx ${escape(shortRef(submissionEvent?.detail?.fabricTxId, 10))}</p><p>Approval tx ${escape(shortRef(approvalEvent?.detail?.fabricTxId ?? r.fabricDecisionTxId, 10))}</p><code>${escape(shortRef(approvalEvent?.detail?.evidenceHash, 12))}</code></article><article><small>ALGORAND ARC-4</small><b>PROVIDER ESCROW + RELEASE</b><p>App ${escape(binding.applicationId)} · ASA ${escape(binding.assetId)}</p><p>${escape(shortRef(binding.originProviderAddress, 9))} → ${escape(shortRef(binding.destinationProviderAddress, 9))}</p><code>${escape(shortRef(binding.bindingHash, 12))}</code></article></div><div class="provider-command-list">${commandRows}</div>${milestoneSettlementRows ? `<div class="analytics-milestone-proof">${milestoneSettlementRows}</div>` : ""}</section>
      <section class="analytics-money-section" data-analytics-section="money-flow"><header class="settlement-section-title"><span>MONEY FLOW + DEDUCTIONS</span><p>Persisted amounts only; every deduction is disclosed.</p></header><div class="settlement-money-flow" aria-label="Money and fee flow"><article class="flow-value source-value"><small>01 · LOCAL FUNDING</small><b>${escape(money(fundingAmount?.amountMinor, fundingAmount?.scale, fundingAmount?.currency))}</b><p>Company fiat book debited</p></article><div class="flow-conversion"><span><small>${escape(legs[0]?.pair ?? "ORIGIN FX")}</small><b>${escape(legs[0] ? `× ${rate(legs[0].rateUnits, legs[0].rateScale)}` : "RATE PENDING")}</b></span><i>→</i><span class="flow-fee"><small>ORIGIN + PLATFORM FEE</small><b>${escape(money(originFee.amountMinor, originFee.scale, originFee.currency))}</b><em>${escape(`${fees.find(item => item.code === "ORIGIN_AND_PLATFORM")?.basisPoints ?? 0} bps`)}</em></span></div><article class="flow-value escrow-value"><small>02 · STABLE VALUE LOCK</small><b>${escape(money(settlementAmount?.amountMinor, settlementAmount?.scale, "USDC"))}</b><p>${escape(`${binding.network ?? "Algorand"} · App ${binding.applicationId ?? "—"}`)}</p></article><div class="flow-conversion"><span><small>${escape(legs[1]?.pair ?? "PAYOUT FX")}</small><b>${escape(legs[1] ? `× ${rate(legs[1].rateUnits, legs[1].rateScale)}` : "RATE PENDING")}</b></span><i>→</i><span class="flow-fee"><small>DESTINATION OFF-RAMP FEE</small><b>${escape(money(destinationFee.amountMinor, destinationFee.scale, destinationFee.currency))}</b><em>${escape(`${fees.find(item => item.code === "DESTINATION_OFFRAMP")?.basisPoints ?? 0} bps`)}</em></span></div><article class="flow-value payout-value"><small>03 · LOCAL PAYOUT</small><b>${escape(money(payoutAmount?.amountMinor, payoutAmount?.scale, payoutAmount?.currency))}</b><p>Beneficiary fiat book credited</p></article></div><div class="analytics-reconciliation"><span><small>QUOTE → ESCROW</small><b>${escape(escrowDifference === null ? "—" : money(escrowDifference.toString(), 6, "USDC"))}</b></span><span><small>ESCROW → RELEASE</small><b>${escape(releaseDifference === null ? "—" : money(releaseDifference.toString(), 6, "USDC"))}</b></span><span><small>UNEXPLAINED VALUE</small><b>${escape(fullyAccounted ? "0.00" : "INVESTIGATE")}</b></span><span><small>LEDGER CHECK</small><b>${escape(fullyAccounted ? "MATCHED" : reconciliation.status ?? "NOT CHECKED")}</b></span></div><p class="network-fee-note">Algorand network fees are paid separately in TestAlgo and are never removed from the USDC escrow or freelancer payout.</p></section>
      <div class="settlement-detail-grid"><section class="settlement-panel" data-analytics-section="corridor-rules"><header><span>CORRIDOR RULE DECISION</span><b>${escape(compliance.outcome ?? plan.outcome ?? "—")}</b></header><div class="receipt-time-grid"><span><small>REGULATIONS FETCHED</small><b>${escape(formatInstant(regulation.report?.checkedAt ?? regulationEvent?.detail?.checkedAt ?? regulationEvent?.occurredAt))}</b></span><span><small>COMPLIANCE DECIDED</small><b>${escape(formatInstant(compliance.evaluatedAt ?? complianceEvent?.occurredAt))}</b></span><span><small>RULESET</small><b>${escape(compliance.rulesVersion ?? "—")}</b></span><span><small>CORPUS HASH</small><b>${escape(shortRef(regulation.report?.approvedCorpusHash ?? regulationEvent?.detail?.approvedCorpusHash, 10))}</b></span></div><div class="receipt-obligations">${categoryRows}</div><div class="receipt-rule-tags">${rules.map(rule => `<span>${escape(rule)}</span>`).join("") || "<span>NO RULE IDS PROJECTED</span>"}</div></section><section class="settlement-panel" data-analytics-section="fx-provenance"><header><span>FX QUOTE PROVENANCE</span><b>${escape(quote.rateSource ?? "—")}</b></header><div class="receipt-time-grid"><span><small>RATE OBSERVED</small><b>${escape(formatInstant(quote.rateObservedAt))}</b></span><span><small>QUOTE CREATED</small><b>${escape(formatInstant(quote.quotedAt ?? fxEvent?.occurredAt))}</b></span><span><small>QUOTE EXPIRY</small><b>${escape(formatInstant(quote.expiresAt))}</b></span><span><small>QUOTE HASH</small><b>${escape(shortRef(quote.canonicalHash, 10))}</b></span></div><div class="analytics-fx-legs">${fxLegRows || '<p class="settlement-empty">No FX legs were projected.</p>'}</div></section></div>
      <footer class="analytics-minimal-footer">${role === "COMPANY" ? '<button type="button" data-start-new-deal>START A NEW DEAL <b>→</b></button>' : '<span>DEAL CLOSED · WAITING FOR THE NEXT COMPANY BRIEF</span>'}</footer>
    </section>`;
  }

  function settlementAnalyticsPage() {
    return `<section class="settlement-analytics-page" data-settlement-analytics aria-label="Completed deal analytics">
      ${settlementReceipt()}
    </section>`;
  }

  function moneyTransferScreen() {
    const timeline = (model.run?.phase !== "COMPLETED" && results().lastSettlementTimeline) || results().settlementTimeline || {};
    const payment = timeline.payment ?? results().payment;
    const binding = timeline.binding ?? results().binding;
    const quote = timeline.quote ?? results().quote;
    const completed = payment?.state === "COMPLETED";
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
      ${settlementRouterPanel(timeline, true)}
      ${completed ? `<section class="deal-complete-confirmation"><i>✓</i><div><small>PAYMENT CONFIRMATION</small><h4>DEAL COMPLETE.</h4><p>${escape(`${money(payoutAmount?.amountMinor, payoutAmount?.scale, payoutCurrency)} credited after Fabric-approved evidence released escrow ${shortRef(binding?.dealId, 8)}.`)}</p></div><span>COMPANY + FREELANCER OBLIGATIONS CLOSED</span></section><section class="analytics-transition-cue" role="status"><small>SETTLEMENT RECORD SEALED</small><b>OPENING TRANSACTION ANALYTICS…</b></section>` : ""}
      <p class="transfer-explainer">The characters visualize the real provider-mediated flow. The company and freelancer remain fiat-only; neither user receives cryptocurrency or signs a blockchain transaction.</p>
    </section>`;
  }

  function showRouteOptimizer(phase) {
    return phase === "RELEASING" || Date.now() < routeOptimizerUntil;
  }

  function showTransferScreen(phase) {
    return phase === "COMPLETED" || Date.now() < transferAnimationUntil;
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
    if (showRouteOptimizer(phase)) return stageScreen("06", "DYNAMIC SETTLEMENT ROUTER", "Watch Anchor choose the payout path", "Every provider quote, rejection and ranking result below comes from the persisted payment decision that is being bound into the release permit.", settlementRouteOptimizerScreen(), "LIVE OPTIMIZATION");
    if (showTransferScreen(phase)) return stageScreen("06", "SETTLEMENT RAIL", phase === "COMPLETED" ? "The payout has arrived" : "Approved value is moving", "This screen follows the actual release state after the company approval was recorded on Fabric.", moneyTransferScreen(), phase === "COMPLETED" ? "TRANSFER COMPLETE" : "LIVE TRANSFER");
    if (!r.submission) return stageScreen("06", "DELIVERY DESK", usesMilestoneReleases() ? `Milestone ${activeMilestone()?.ordinal ?? 1} escrow is secured` : "The full escrow is secured", usesMilestoneReleases() ? "This milestone's settlement value is locked. The selected freelancer can upload only the evidence required for this release." : "The complete project value is locked in one escrow and awaits the freelancer's final delivery.", payoutCard(), "WAITING FOR DELIVERY");
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
    if (showRouteOptimizer(phase)) return stageScreen("06", "DYNAMIC SETTLEMENT ROUTER", "Watch Anchor choose your payout path", "The provider comparison is read from the live payment record. Unsafe or inferior routes cannot authorize the escrow release.", settlementRouteOptimizerScreen(), "LIVE OPTIMIZATION");
    if (showTransferScreen(phase)) return stageScreen("06", "SETTLEMENT RAIL", phase === "COMPLETED" ? "Your local payout has arrived" : "Your payout is moving", "The release follows the approved Fabric evidence and confirmed Algorand escrow state.", moneyTransferScreen(), phase === "COMPLETED" ? "MONEY RECEIVED" : "LIVE TRANSFER");
    if (!r.submission) return stageScreen("06", "PRIVATE DELIVERY", usesMilestoneReleases() ? `Submit milestone ${activeMilestone()?.ordinal ?? 1} of ${milestones().length}` : "Submit the complete work", usesMilestoneReleases() ? "Your bytes go to private object storage. This evidence can unlock only the active milestone escrow." : "Your final delivery goes to private object storage. Its approved Fabric evidence can unlock the one full-value escrow.", pairedStage(submissionForm(), payoutCard()));
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
    const analyticsVisible = model.run?.phase === "COMPLETED" && completedView === "analytics" && !inspectedStage;
    const network = String(model.runtime?.network ?? results().binding?.network ?? "unknown").toLowerCase();
    const networkLabel = network === "testnet" ? "PUBLIC TESTNET" : network === "localnet" ? "REAL LOCALNET" : "NETWORK UNKNOWN";
    $("#portalWorkflow").dataset.role = role.toLowerCase();
    $("#portalWorkflow").dataset.view = analyticsVisible ? "analytics" : "workflow";
    $("#workspaceEyebrow").textContent = company ? "COMPANY / HIRING COMMAND" : "FREELANCER / OPPORTUNITY DESK";
    $("#workspaceTitle").textContent = company ? "HIRE WITH PROOF BUILT IN." : "FIND WORK. GET PAID LOCALLY.";
    $("#workspaceIntro").textContent = company ? "Publish a real brief, compare multiple proposals, define the agreement and release only against approved evidence." : "Discover verified work, submit your own terms, review the private agreement and deliver into secured escrow.";
    $("#workspaceRailTitle").textContent = company ? "COMPANY JOURNEY" : "YOUR JOURNEY";
    $("#railRoleHint").textContent = company ? "YOU CONTROL COMPANY DECISIONS" : "YOU CONTROL FREELANCER ACTIONS";
    $("#workspaceNetwork").textContent = networkLabel;
    $("#workspaceNetworkStack").textContent = network === "testnet"
      ? "POSTGRES · MINIO · FABRIC · CIRCLE TESTNET USDC"
      : "POSTGRES · MINIO · FABRIC · ALGORAND";
    $("#portalNetworkRoute").textContent = route.originCountry && route.destinationCountry
      ? `${networkLabel} · ${route.originCountry} → ${route.destinationCountry}`
      : route.originCountry ? `${networkLabel} · ${route.originCountry} → PAYEE PENDING` : `${networkLabel} · ROUTE PENDING`;
    const resetButton = $("#workflowReset");
    resetButton.hidden = !company || !model.run || model.run?.phase === "COMPLETED";
    resetButton.textContent = model.run?.phase === "COMPLETED" ? "START NEW DEAL" : "RESET CURRENT DEAL";
    $("#workspaceAction").innerHTML = analyticsVisible
      ? settlementAnalyticsPage()
      : inspectedStage ? renderInspection(inspectedStage) : company ? renderCompany() : renderFreelancer();
    renderRail();
    renderSnapshot();
    renderCompanion();
    bindActions();
  }

  function renderTimedWorkflowTransition() {
    const analyticsVisible = model.run?.phase === "COMPLETED" && completedView === "analytics" && !inspectedStage;
    if (!busy && !analyticsVisible) render();
  }

  function milestoneDraftsFromForm(form) {
    if (form.elements.namedItem("deliveryMode")?.value !== "MILESTONES") return [];
    const count = Number(form.elements.namedItem("milestoneCount")?.value ?? 1);
    return Array.from({ length: Math.max(1, Math.min(5, count)) }, (_, index) => {
      const ordinal = index + 1;
      return {
        title: form.elements.namedItem(`milestoneTitle${ordinal}`)?.value ?? "",
        description: form.elements.namedItem(`milestoneDescription${ordinal}`)?.value ?? "",
        deliverable: form.elements.namedItem(`milestoneDeliverable${ordinal}`)?.value ?? "",
        acceptanceCriteria: lines(form.elements.namedItem(`milestoneAcceptance${ordinal}`)?.value),
        amount: form.elements.namedItem(`milestoneAmount${ordinal}`)?.value ?? "",
        dueDate: form.elements.namedItem(`milestoneDueDate${ordinal}`)?.value ?? "",
      };
    });
  }

  function updateMilestoneTotal(form) {
    const milestoneBased = form.elements.namedItem("deliveryMode")?.value === "MILESTONES";
    const drafts = milestoneDraftsFromForm(form);
    const total = milestoneBased
      ? drafts.reduce((sum, item) => sum + (Number(item.amount) || 0), 0)
      : Number(form.elements.namedItem("singleBudget")?.value) || 0;
    const currency = form.elements.namedItem("fundingCurrency")?.value ?? "";
    const budget = form.elements.namedItem("budget");
    if (budget instanceof HTMLInputElement) budget.value = total.toFixed(2);
    const label = form.querySelector("[data-milestone-total]");
    if (label) label.textContent = `${total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
    const limit = testnetBudgetLimit(currency);
    const container = form.querySelector("[data-milestone-editor]");
    if (container) container.dataset.overLimit = String(Boolean(limit && total > limit));
    return total;
  }

  function setDeliveryMode(form, mode, drafts = []) {
    const milestoneBased = mode === "MILESTONES";
    const selected = form.querySelector(`[name="deliveryMode"][value="${milestoneBased ? "MILESTONES" : "SINGLE"}"]`);
    if (selected instanceof HTMLInputElement) selected.checked = true;
    const single = form.querySelector("[data-single-delivery]");
    const schedule = form.querySelector("[data-milestone-delivery]");
    if (single) single.hidden = milestoneBased;
    if (schedule) schedule.hidden = !milestoneBased;
    const singleBudget = form.elements.namedItem("singleBudget");
    if (singleBudget instanceof HTMLInputElement) {
      singleBudget.required = !milestoneBased;
      singleBudget.disabled = milestoneBased;
    }
    schedule?.querySelectorAll("input, select, textarea").forEach(control => { control.disabled = !milestoneBased; });
    const hint = form.querySelector("[data-delivery-mode-hint]");
    if (hint) hint.textContent = milestoneBased
      ? "Every allocation becomes an independently funded Algorand escrow. Each releases only against that milestone's approved Fabric evidence."
      : "One complete delivery creates one Algorand escrow and releases the full value only against the final approved Fabric evidence.";
    const editor = form.querySelector("[data-milestone-editor]");
    if (milestoneBased && (drafts.length || !editor?.querySelector(".milestone-input-card"))) {
      renderMilestoneEditor(form, drafts.length || form.elements.namedItem("milestoneCount")?.value || 2, drafts);
    }
    updateMilestoneTotal(form);
  }

  function renderMilestoneEditor(form, requestedCount, drafts = milestoneDraftsFromForm(form)) {
    const container = form.querySelector("[data-milestone-editor]");
    if (!container) return;
    const count = Math.max(1, Math.min(5, Number(requestedCount) || 1));
    const finalDate = form.elements.namedItem("deliveryDate")?.value ?? "";
    const currency = form.elements.namedItem("fundingCurrency")?.value ?? "";
    const control = form.elements.namedItem("milestoneCount");
    if (control) control.value = String(count);
    container.innerHTML = `<header><div><small>PROJECT RELEASE SCHEDULE</small><h3>${count} MILESTONE ESCROW${count === 1 ? "" : "S"}</h3></div><span>ALLOCATIONS MUST EQUAL PROJECT TOTAL</span></header><div>${Array.from({ length: count }, (_, index) => {
      const ordinal = index + 1;
      const item = drafts[index] ?? {};
      return `<article class="milestone-input-card"><header><i>${String(ordinal).padStart(2, "0")}</i><div><small>INDEPENDENT RELEASE</small><b>MILESTONE ${ordinal}</b></div></header><label><span>TITLE</span><input name="milestoneTitle${ordinal}" required minlength="3" value="${escape(item.title ?? "")}" placeholder="e.g. Architecture and acceptance tests"></label><label><span>WHAT MUST BE COMPLETED</span><textarea name="milestoneDescription${ordinal}" required minlength="10" placeholder="Describe the work completed in this milestone">${escape(item.description ?? "")}</textarea></label><label><span>DELIVERABLE / PROOF FILE</span><input name="milestoneDeliverable${ordinal}" required minlength="3" value="${escape(item.deliverable ?? "")}" placeholder="e.g. Signed architecture PDF and test report"></label><label><span>MILESTONE ACCEPTANCE CHECKS</span><textarea name="milestoneAcceptance${ordinal}" required minlength="5" placeholder="One objective check per line">${escape(Array.isArray(item.acceptanceCriteria) ? item.acceptanceCriteria.join("\n") : item.acceptanceCriteria ?? "")}</textarea></label><div class="field-grid"><label><span>ESCROW ALLOCATION · ${escape(currency)}</span><input name="milestoneAmount${ordinal}" data-milestone-amount type="number" min="0.01" step="0.01" required value="${escape(item.amount ?? "")}" placeholder="1.00"></label><label><span>DUE DATE</span><input name="milestoneDueDate${ordinal}" type="date" required value="${escape(item.dueDate ?? finalDate)}"></label></div></article>`;
    }).join("")}</div>`;
    container.querySelectorAll("[data-milestone-amount]").forEach(input => input.addEventListener("input", () => updateMilestoneTotal(form)));
    updateMilestoneTotal(form);
  }

  function jobBriefPayload(form) {
    return {
      title: form.elements.namedItem("title")?.value,
      description: form.elements.namedItem("description")?.value,
      acceptanceCriteria: lines(form.elements.namedItem("acceptanceCriteria")?.value),
      skills: String(form.elements.namedItem("skills")?.value ?? "").split(",").map(value => value.trim()).filter(Boolean),
      budget: updateMilestoneTotal(form),
      payerCountry: form.elements.namedItem("payerCountry")?.value,
      fundingCurrency: form.elements.namedItem("fundingCurrency")?.value,
      deliveryDate: form.elements.namedItem("deliveryDate")?.value,
      deliveryMode: form.elements.namedItem("deliveryMode")?.value,
      milestones: milestoneDraftsFromForm(form),
    };
  }

  async function downloadJobBrief(form) {
    if (!form.reportValidity()) return;
    const response = await fetch("/api/workflow/job-brief.pdf", {
      method: "POST",
      headers: { "content-type": "application/json", "x-anchor-role": role },
      body: JSON.stringify(jobBriefPayload(form)),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body?.error?.message ?? `PDF generation failed (${response.status})`);
    }
    const url = URL.createObjectURL(await response.blob());
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "anchor-company-job-brief.pdf";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
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
      const budget = country.form?.querySelector("[data-budget-input]");
      const hint = country.form?.querySelector("[data-testnet-budget-hint]");
      const limit = testnetBudgetLimit(expected);
      if (budget instanceof HTMLInputElement) {
        if (limit) {
          budget.max = String(limit);
          budget.placeholder = String(limit);
        } else {
          budget.removeAttribute("max");
        }
      }
      if (hint && limit) hint.textContent = `PUBLIC TESTNET FAUCET LIMIT · MAX ${limit} ${expected} FOR THIS LIVE ON-CHAIN DEMO. USE LOCALNET FOR LARGE NOTIONAL VALUES.`;
      const form = country.form;
      if (form?.dataset.workspaceForm === "job") {
        const singleBudget = form.elements.namedItem("singleBudget");
        if (singleBudget instanceof HTMLInputElement) {
          if (limit) singleBudget.max = String(limit);
          else singleBudget.removeAttribute("max");
        }
        if (form.elements.namedItem("deliveryMode")?.value === "MILESTONES") renderMilestoneEditor(form, form.elements.namedItem("milestoneCount")?.value);
        else updateMilestoneTotal(form);
      }
    }));
    document.querySelectorAll("[data-delivery-mode]").forEach(control => {
      const form = control.form;
      if (!form) return;
      control.addEventListener("change", () => setDeliveryMode(form, control.value));
    });
    document.querySelectorAll("[data-milestone-count]").forEach(control => {
      const form = control.form;
      if (!form) return;
      control.addEventListener("change", () => renderMilestoneEditor(form, control.value));
    });
    document.querySelectorAll('[data-workspace-form="job"]').forEach(form => setDeliveryMode(form, form.elements.namedItem("deliveryMode")?.value ?? "SINGLE"));
    document.querySelectorAll("[data-download-job-brief]").forEach(button => button.addEventListener("click", async () => {
      if (busy) return;
      busy = true;
      try {
        await downloadJobBrief(button.form);
        setStatus(`${button.form?.elements.namedItem("deliveryMode")?.value === "MILESTONES" ? "MILESTONE" : "SINGLE-DELIVERY"} JOB BRIEF PDF GENERATED · READY TO RE-UPLOAD_`, "success");
      } catch (error) {
        setStatus(`PDF GENERATION FAILED · ${error.message}`, "error");
      } finally { busy = false; }
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
        populate(form, "deliveryDate", fields.deliveryDate);
        populate(form, "payerCountry", fields.payerCountry ?? fields.companyCountry ?? fields.originCountry);
        populate(form, "fundingCurrency", fields.fundingCurrency ?? fields.currency);
        if (Array.isArray(fields.milestones) && fields.milestones.length > 1) {
          setDeliveryMode(form, "MILESTONES", fields.milestones);
        } else if (Array.isArray(fields.milestones) && fields.milestones.length === 1) {
          populate(form, "singleBudget", fields.milestones[0].amount ?? fields.budget ?? fields.budgetAmount ?? fields.budgetPln);
          setDeliveryMode(form, "SINGLE");
        } else if (fields.budget ?? fields.budgetAmount ?? fields.budgetPln) {
          const amount = fields.budget ?? fields.budgetAmount ?? fields.budgetPln;
          populate(form, "singleBudget", amount);
          setDeliveryMode(form, "SINGLE");
        }
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
      const publicLimit = testnetBudgetLimit(data.get("fundingCurrency"));
      if (publicLimit && Number(data.get("budget")) > publicLimit) {
        return setStatus(`PUBLIC TESTNET FAUCET LIMIT · USE ${publicLimit} ${data.get("fundingCurrency")} OR LESS, OR SWITCH TO LOCALNET FOR LARGE NOTIONALS_`, "error");
      }
      const milestoneDrafts = milestoneDraftsFromForm(event.currentTarget);
      const total = updateMilestoneTotal(event.currentTarget);
      if (publicLimit && total > publicLimit) return setStatus(`PUBLIC TESTNET FAUCET LIMIT · MILESTONE TOTAL MUST BE ${publicLimit} ${data.get("fundingCurrency")} OR LESS_`, "error");
      const milestonePayload = milestoneDrafts.map((item) => ({
        title: item.title,
        description: item.description,
        deliverable: item.deliverable,
        acceptanceCriteria: item.acceptanceCriteria,
        amount: { amountMinor: String(Math.round(Number(item.amount) * 100)), currency: data.get("fundingCurrency"), scale: 2 },
        dueDate: item.dueDate,
      }));
      return executeByIds(["job"], { title: data.get("title"), description: data.get("description"), acceptanceCriteria: data.get("acceptanceCriteria"), skills: String(data.get("skills")).split(",").map(value => value.trim()).filter(Boolean), deliveryDate: data.get("deliveryDate"), payerCountry: data.get("payerCountry"), fundingCurrency: data.get("fundingCurrency"), budget: { amountMinor: String(Math.round(total * 100)), currency: data.get("fundingCurrency"), scale: 2 }, ...(data.get("deliveryMode") === "MILESTONES" ? { milestones: milestonePayload } : {}) });
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
        routeOptimizerUntil = Date.now() + routeOptimizerHoldMilliseconds;
        transferAnimationUntil = Date.now() + routeOptimizerHoldMilliseconds + 6_000;
        clearTimeout(routeOptimizerTimer);
        routeOptimizerTimer = setTimeout(renderTimedWorkflowTransition, routeOptimizerHoldMilliseconds + 100);
        clearTimeout(transferAnimationTimer);
        transferAnimationTimer = setTimeout(renderTimedWorkflowTransition, routeOptimizerHoldMilliseconds + 6_100);
      }
      await refresh({ follow: true });
      setStatus(`${step.label} COMPLETE · RESULT PERSISTED_`, "success");
    } catch (error) {
      setStatus(`ACTION FAILED · ${error.message}`, "error");
      await refresh();
    } finally { busy = false; }
  }

  async function refresh({ follow = false } = {}) {
    const previousPhase = model.run?.phase;
    const nextModel = await request("/api/workspace/state");
    // A poll may start just before document extraction marks the UI busy. Do
    // not let that in-flight response replace the live form and detach the
    // controls that the extractor is about to populate.
    if (!follow && busy) return;
    if (!follow && (document.activeElement?.closest("[data-workspace-form]") || document.querySelector('[data-workspace-form][data-dirty="true"]'))) return;
    const modelChanged = JSON.stringify(nextModel) !== JSON.stringify(model);
    let visualStateChanged = false;
    model = nextModel;
    syncNotifications();
    const nextPhase = model.run?.phase;
    const paymentId = String(results().settlementTimeline?.payment?.id ?? results().payment?.id ?? model.run?.id ?? "completed-deal");
    const routeDecision = results().settlementTimeline?.settlementRoute;
    if (routeDecision?.routeHash && routeOptimizerPaymentId !== paymentId) {
      routeOptimizerPaymentId = paymentId;
      visualStateChanged = true;
      routeOptimizerUntil = Math.max(routeOptimizerUntil, Date.now() + routeOptimizerHoldMilliseconds);
      clearTimeout(routeOptimizerTimer);
      routeOptimizerTimer = setTimeout(renderTimedWorkflowTransition, routeOptimizerHoldMilliseconds + 100);
    }
    const releasedTimeline = results().lastSettlementTimeline ?? results().settlementTimeline;
    const releasedPayment = releasedTimeline?.payment;
    if (releasedPayment?.state === "COMPLETED" && releasedPayment.id !== transferVisualizationPaymentId) {
      transferVisualizationPaymentId = releasedPayment.id;
      visualStateChanged = true;
      routeOptimizerUntil = Math.max(routeOptimizerUntil, Date.now() + routeOptimizerHoldMilliseconds);
      transferAnimationUntil = Math.max(transferAnimationUntil, routeOptimizerUntil + 6_000);
      clearTimeout(routeOptimizerTimer);
      routeOptimizerTimer = setTimeout(renderTimedWorkflowTransition, Math.max(0, routeOptimizerUntil - Date.now()) + 100);
      clearTimeout(transferAnimationTimer);
      transferAnimationTimer = setTimeout(renderTimedWorkflowTransition, Math.max(0, transferAnimationUntil - Date.now()) + 100);
    }
    if (nextPhase !== "COMPLETED") {
      visualStateChanged ||= completedPaymentId !== null || completedView !== "workflow";
      completedPaymentId = null;
      completedView = "workflow";
      clearTimeout(analyticsRevealTimer);
    } else if (completedPaymentId !== paymentId) {
      completedPaymentId = paymentId;
      visualStateChanged = true;
      if (previousPhase && previousPhase !== "COMPLETED") {
        completedView = "completion";
        clearTimeout(analyticsRevealTimer);
        const routeDelay = Math.max(0, routeOptimizerUntil - Date.now());
        analyticsRevealTimer = setTimeout(() => {
          completedView = "analytics";
          render();
          document.querySelector(".portal-main")?.scrollTo({ top: 0, behavior: "smooth" });
        }, routeDelay + completionHoldMilliseconds);
      } else {
        completedView = "analytics";
      }
    }
    // Polling keeps both portals synchronized, but replacing identical markup
    // every three seconds restarts entrance effects and visibly flashes the
    // page. Render only when persisted data or an intentional view state moves.
    if (follow || modelChanged || visualStateChanged) render();
  }

  async function reset() {
    if (role !== "COMPANY" || busy || !confirm("Start a new deal? This clears the shared live workspace for both Company and Freelancer. Existing ledger records remain auditable.")) return;
    inspectedStage = null;
    completedPaymentId = null;
    completedView = "workflow";
    routeOptimizerPaymentId = null;
    transferVisualizationPaymentId = null;
    routeOptimizerUntil = 0;
    transferAnimationUntil = 0;
    clearTimeout(routeOptimizerTimer);
    clearTimeout(analyticsRevealTimer);
    await request("/api/workflow/reset", { method: "POST" });
    await refresh({ follow: true });
    setStatus("FRESH WORKSPACE READY · NO BLOCKCHAIN ACTIONS YET_", "success");
  }

  async function init() {
    if (!initialized) {
      initialized = true;
      $("#workflowReset")?.addEventListener("click", reset);
      $("#notificationButton")?.addEventListener("click", () => {
        const popover = $("#notificationPopover");
        if (popover?.hidden) openNotificationCenter();
        else closeNotificationCenter({ restoreFocus: true });
      });
      $("#notificationClose")?.addEventListener("click", () => closeNotificationCenter({ restoreFocus: true }));
      $("#notificationMarkRead")?.addEventListener("click", () => {
        const state = notificationState();
        state.readIds = [...new Set([...state.readIds, ...state.items.map(item => item.id)])];
        saveNotificationState(state);
        renderNotificationCenter();
      });
      $("#notificationToast")?.addEventListener("click", openNotificationCenter);
      document.addEventListener("click", event => {
        const popover = $("#notificationPopover");
        if (popover?.hidden || popover?.contains(event.target) || $("#notificationButton")?.contains(event.target)) return;
        closeNotificationCenter();
      });
      document.addEventListener("keydown", event => {
        if (event.key === "Escape" && !$("#notificationPopover")?.hidden) closeNotificationCenter({ restoreFocus: true });
      });
      setInterval(() => { if (!busy && $("#portalWorld")?.classList.contains("open")) refresh().catch(() => {}); }, 3000);
    }
    try {
      await refresh({ follow: true });
      setStatus(`${role === "COMPANY" ? "HIRING WORKSPACE" : "FREELANCER WORKSPACE"} READY · REAL SERVICES CONNECTED_`);
    } catch (error) { setStatus(`WORKSPACE UNAVAILABLE · ${error.message}`, "error"); }
  }

  window.OptiWorkWorkflow = { init, setRole(nextRole) { role = nextRole === "FREELANCER" ? "FREELANCER" : "COMPANY"; inspectedStage = null; closeNotificationCenter(); if (initialized) { syncNotifications(); render(); } } };
})();
