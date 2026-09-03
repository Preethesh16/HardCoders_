// Fetches the real OptiWork demo state (same-origin, via serve.mjs's proxy —
// see that file for why the API token never reaches the browser directly)
// and reshapes it into the exact data shape script.js's mock `portalData`
// already uses, so the pixel-art portal renders real numbers through the
// same DOM-update code path as the mock. Classic script (not a module):
// script.js calls window.OptiWorkPortalData.hydrate() directly.
window.OptiWorkPortalData = (() => {
  // "PLN"/"GBP" as text, not symbols: matches how the rest of this page
  // already denotes them (its own PLN -> USD -> INR corridor labels are
  // plain text too), and "Press Start 2P" renders the Polish ł in "zł" badly.
  const CURRENCY_SYMBOL = { INR: "₹", USD: "$" };

  function money(minor, scale, currency) {
    const value = Number(minor) / 10 ** scale;
    const formatted = value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const symbol = CURRENCY_SYMBOL[currency];
    return symbol ? `${symbol}${formatted}` : `${formatted} ${currency}`;
  }

  function relativeTime(iso) {
    const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return new Date(iso).toLocaleDateString();
  }

  const EVENT_LABEL = {
    CONTRACT_DRAFTED: "CONTRACT DRAFTED", CONTRACT_APPROVED: "CONTRACT APPROVED",
    DOCUMENT_RECORDED: "DOCUMENT RECORDED", CORRIDOR_RESOLVED: "CORRIDOR RESOLVED",
    FX_QUOTED: "FX QUOTED", COMPLIANCE_EVALUATED: "COMPLIANCE PASSED",
    PAYMENT_CREATED: "PAYMENT CREATED", FIAT_FUNDED: "ESCROW FUNDED",
    ESCROW_CREATED: "ESCROW CREATED", USDC_LOCKED: "FUNDS LOCKED",
    WORK_SUBMITTED: "WORK SUBMITTED", WORK_ACCESS_GRANTED: "ACCESS GRANTED",
    WORK_APPROVED: "WORK APPROVED", RELEASE_AUTHORIZED: "RELEASE AUTHORIZED",
    USDC_RELEASED: "FUNDS RELEASED", PAYOUT_CREDITED: "PAYOUT CREDITED",
    PAYMENT_COMPLETED: "PAYMENT COMPLETED"
  };

  function glyphFor(kind) {
    if (/FUNDED|CREDITED|RELEASED|PAYOUT/.test(kind)) return "₹";
    if (/APPROVED|COMPLETED|PASSED|GRANTED/.test(kind)) return "✓";
    return "⌁";
  }

  function label(kind) {
    return EVENT_LABEL[kind] ?? kind.replace(/_/g, " ");
  }

  async function fetchState() {
    const res = await fetch("/api/state", { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`state fetch failed: ${res.status}`);
    return res.json();
  }

  async function runWalkthrough() {
    const res = await fetch("/api/run", { method: "POST" });
    return res.ok;
  }

  // Builds both role portals from the Poland-company/India-freelancer
  // journey (WC-000001 / PAY-000001) — the deal the pixel-art page's own
  // COMPANY/FREELANCER characters and role-select flow are built around. The
  // demo's second journey (India importer -> UK supplier) has no matching
  // character art here; its numbers still count toward the AUDIT tab below.
  function buildRolePortals(state) {
    const contract = state.contracts.find(c => c.id === "WC-000001");
    const job = state.jobs.find(j => j.id === contract?.jobId);
    const payment = state.payments.find(p => p.contractId === contract?.id);
    if (!contract || !job || !payment) return null;

    const timeline = (state.timelines[payment.id] ?? []).slice().sort((a, b) => a.sequence - b.sequence);
    const recentActivity = timeline.slice(-3).reverse().map(e => [glyphFor(e.kind), label(e.kind), relativeTime(e.occurredAt)]);
    const funded = money(payment.fundingAmountMinor, payment.fundingScale, payment.fundingCurrency);
    const paidOut = money(payment.payoutAmountMinor, payment.payoutScale, payment.payoutCurrency);
    const complete = contract.state === "COMPLETED";
    const activeJobs = String(state.jobs.filter(j2 => j2.organizationId === job.organizationId).length).padStart(2, "0");

    const company = {
      mode: "COMPANY COMMAND", user: "NORTHSTAR", nav: "PROJECTS",
      eyebrow: "COMPANY HQ / OVERVIEW",
      welcome: "READY TO<br>MOVE WORK?",
      copy: `${job.title} is ${contract.state.toLowerCase().replace(/_/g, " ")}. Latest settlement: ${paidOut} sent to your freelancer.`,
      primary: "CREATE NEW PROJECT",
      stats: [
        ["ACTIVE PROJECTS", activeJobs, job.status.replace(/_/g, " ")],
        ["CONTRACT VALUE", funded, `Funded in ${payment.fundingCurrency}`],
        ["PAID OUT", paidOut, `${timeline.length} ledger events`]
      ],
      mission: [job.title, contract.state, "COMPANY · POLAND", "NORTHSTAR", "FREELANCER · INDIA", "ARJUN STUDIO", "SETTLEMENT VALUE", paidOut, complete ? "VIEW RECORD" : "REVIEW WORK"],
      quick: [
        ["NEW PROJECT", "Start a global contract"],
        ["REVIEW WORK", complete ? "Contract completed" : "1 submission waiting"],
        ["PAYMENTS", `${paidOut} settled`]
      ],
      activity: recentActivity
    };

    const freelancer = {
      mode: "FREELANCER COMMAND", user: "ARJUN STUDIO", nav: "MY WORK",
      eyebrow: "FREELANCER HQ / OVERVIEW",
      welcome: "READY TO<br>SHIP WORK?",
      copy: `${job.title} is ${contract.state.toLowerCase().replace(/_/g, " ")}. You were paid ${paidOut}.`,
      primary: "FIND NEW PROJECT",
      stats: [
        ["ACTIVE CONTRACTS", "01", contract.state.replace(/_/g, " ")],
        ["EXPECTED PAYOUT", paidOut, `Payment ${payment.state.toLowerCase()}`],
        ["EARNED THIS MONTH", paidOut, `${timeline.length} ledger events`]
      ],
      mission: [job.title, contract.state, "FREELANCER · INDIA", "ARJUN STUDIO", "COMPANY · POLAND", "NORTHSTAR", "EXPECTED PAYOUT", paidOut, complete ? "VIEW RECORD" : "SUBMIT WORK"],
      quick: [
        ["FIND PROJECT", "Browse verified work"],
        ["SUBMIT WORK", complete ? "Milestone delivered" : "1 milestone ready"],
        ["PAYOUTS", `${paidOut} received`]
      ],
      activity: recentActivity
    };

    const allEvents = Object.values(state.timelines).flat();
    const ledger = {
      stats: [
        ["CONTRACTS", String(state.contracts.length).padStart(2, "0"), `${state.jobs.length} jobs total`],
        ["PAYMENTS", String(state.payments.length).padStart(2, "0"), "All completed"],
        ["LEDGER EVENTS", String(allEvents.length), `${Object.keys(state.timelines).length} payments tracked`]
      ],
      books: state.books.map(b => [b.balanced ? "✓" : "✕", b.bookId, b.balanced ? "Balanced" : "Out of balance"]),
      compliance: state.compliance.map(c => [c.outcome === "PASSED" ? "✓" : "✕", `${c.corridorId} · ${c.outcome}`, (c.appliedRules ?? []).join(", ")]),
      timeline: timeline.map(e => [glyphFor(e.kind), label(e.kind), `${new Date(e.occurredAt).toLocaleTimeString()} · ${(e.actorRole ?? "").replace(/_/g, " ")}`])
    };

    return { COMPANY: company, FREELANCER: freelancer, ledger };
  }

  async function hydrate({ autorun = true } = {}) {
    try {
      let state = await fetchState();
      const hasData = Array.isArray(state.jobs) && state.jobs.length > 0;
      if (!hasData && autorun) {
        await runWalkthrough();
        state = await fetchState();
      }
      return buildRolePortals(state);
    } catch {
      return null;
    }
  }

  return { hydrate, money };
})();
