import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const chrome = [process.argv[2], process.env.CHROME_BIN, '/opt/google/chrome/google-chrome', '/usr/bin/google-chrome', '/usr/bin/chromium']
  .find(candidate => candidate && existsSync(candidate));
if (!chrome) throw new Error('Chrome was not found. Pass its path as the first argument or CHROME_BIN.');

const origin = new URL(process.env.ANCHOR_URL ?? 'http://127.0.0.1:4175');
const companyCountry = process.env.ANCHOR_COMPANY_COUNTRY ?? 'GB';
const fundingCurrency = process.env.ANCHOR_FUNDING_CURRENCY ?? 'GBP';
const freelancerCountry = process.env.ANCHOR_FREELANCER_COUNTRY ?? 'IN';
const payoutCurrency = process.env.ANCHOR_PAYOUT_CURRENCY ?? 'INR';
const jobBudget = process.env.ANCHOR_JOB_BUDGET ?? '10';
const proposalPriceAmount = process.env.ANCHOR_PROPOSAL_PRICE ?? '9.80';
const milestoneOneAmount = (Math.round(Number(jobBudget) * 40) / 100).toFixed(2);
const milestoneTwoAmount = (Number(jobBudget) - Number(milestoneOneAmount)).toFixed(2);
const freelancerUserId = process.env.ANCHOR_FREELANCER_USER_ID ?? 'USER-IN-FREELANCER';
const orderedRoute = `${companyCountry} → ${freelancerCountry}`;
const countryNames = { PL: 'Poland', IN: 'India', GB: 'United Kingdom', DE: 'Germany', RU: 'Russia', KP: 'North Korea' };
const supportedCountryCodes = Object.keys(countryNames).sort();
const renderedRoute = `${countryNames[companyCountry] ?? companyCountry} → ${countryNames[freelancerCountry] ?? freelancerCountry}`;
const artifactSuffix = `${companyCountry.toLowerCase()}-${freelancerCountry.toLowerCase()}`;
const deliverable = process.env.ANCHOR_DELIVERABLE
  ?? resolve(process.cwd(), 'README.md');
const captureDirectory = process.env.ANCHOR_CAPTURE_DIR ? resolve(process.env.ANCHOR_CAPTURE_DIR) : undefined;
if (captureDirectory) await mkdir(captureDirectory, { recursive: true });
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const draftDirectory = await mkdtemp(join(tmpdir(), 'anchor-form-drafts-'));
const jobDraft = join(draftDirectory, 'company-brief.txt');
const proposalDraft = join(draftDirectory, 'freelancer-proposal.txt');
const policyDraft = join(draftDirectory, 'company-policy.txt');
const identityDraft = join(draftDirectory, 'company-onboarding.txt');
await writeFile(identityDraft, [
  'Legal name: WISE PAYMENTS LIMITED',
  'Country: United Kingdom',
  'Registry authority: COMPANIES_HOUSE',
  'Registration number: 07209813',
  'LEI: 213800U4GNTXRFYZKG18',
  'Tax identifier: DEMO-PRIVATE-TAX-REF',
  'Registered address: 1st Floor, Worship Square, 65 Clifton Street, London, England, EC2A 4JE',
  'Director / officer sample: Jane Fahey',
  'PSC / beneficial owner: Wise Financial Holdings Ltd | PERSON_WITH_SIGNIFICANT_CONTROL',
  'Representative email: demo@anchor.dev',
  'Representative role: Anchor demo contracting representative',
  'Authority basis: Tenant administrator approved this representative for the local demonstration.',
  'Mandate reference: ANCHOR-DEMO-MANDATE-GB-001',
].join('\n'));
await writeFile(policyDraft, [
  `Company country: ${countryNames[companyCountry] ?? companyCountry}`,
  `Funding currency: ${fundingCurrency}`,
  'Company policies: Confidential information remains private to authorized contract participants; Repository access follows least privilege',
  'Legal clauses: Governing law follows the verified company jurisdiction; Disputes follow written escalation before the agreed forum',
  'Commercial standards: One evidence-backed revision is included; Invoices are issued after milestone acceptance',
  'Authorized approvers: Procurement Director; Engineering Director',
].join('\n'));
await writeFile(jobDraft, [
  'Title: Build an auditable cross-border reconciliation engine',
  `Description: Deliver a production-shaped TypeScript reconciliation engine, automated tests, operating guide, and proof dashboard for the ${companyCountry} to ${freelancerCountry} corridor.`,
  'Acceptance criteria: All integration tests pass; Fabric and Algorand references reconcile; No personal data appears on either ledger',
  'Skills: TypeScript, PostgreSQL, Hyperledger Fabric, Algorand',
  `Budget ${fundingCurrency}: ${jobBudget}`,
  'Delivery date: 2026-10-31',
  `Payer country: ${countryNames[companyCountry] ?? companyCountry}`,
  `Funding currency: ${fundingCurrency}`,
  'Milestone 1 title: Architecture and proof model',
  'Milestone 1 description: Define the reconciliation invariants, ledger boundaries and executable acceptance plan.',
  'Milestone 1 deliverable: Architecture PDF and acceptance-test specification',
  'Milestone 1 acceptance criteria: Trust boundaries are documented; test cases map to every invariant',
  `Milestone 1 amount: ${milestoneOneAmount}`,
  'Milestone 1 due date: 2026-10-15',
  'Milestone 2 title: Working engine and evidence pack',
  'Milestone 2 description: Implement the approved design and prove restart-safe cross-ledger reconciliation.',
  'Milestone 2 deliverable: Source archive, test report and operations guide',
  'Milestone 2 acceptance criteria: All integration tests pass; Fabric and Algorand references reconcile',
  `Milestone 2 amount: ${milestoneTwoAmount}`,
  'Milestone 2 due date: 2026-10-31',
].join('\n'));
await writeFile(proposalDraft, [
  `Proposed price ${fundingCurrency}: ${proposalPriceAmount}`,
  'Delivery days: 16',
  `Tax residence: ${countryNames[freelancerCountry] ?? freelancerCountry}`,
  `Payout country: ${countryNames[freelancerCountry] ?? freelancerCountry}`,
  `Payout currency: ${payoutCurrency}`,
  'Availability: Available immediately for 32 hours per week',
  'Approach: Start with executable acceptance tests, implement reconciliation invariants, and provide signed evidence for every milestone.',
  'Cover letter: I build TypeScript settlement services and evidence-led approval systems for regulated cross-border workflows.',
].join('\n'));

async function launch(role) {
  const profile = await mkdtemp(join(tmpdir(), `anchor-${role.toLowerCase()}-browser-`));
  const processHandle = spawn(chrome, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-background-networking',
    '--disable-component-update', '--disable-default-apps', '--disable-extensions', '--disable-sync',
    '--metrics-recording-only', '--no-first-run', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0', '--window-size=1600,1000', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });

  let port;
  const portFile = join(profile, 'DevToolsActivePort');
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (processHandle.exitCode !== null) throw new Error(`${role} Chrome exited with ${processHandle.exitCode}.`);
    try {
      const [value] = (await readFile(portFile, 'utf8')).trim().split('\n');
      if (/^[1-9][0-9]*$/u.test(value ?? '')) { port = Number(value); break; }
    } catch { /* Chrome creates the file once CDP is ready. */ }
    await sleep(50);
  }
  if (!port) throw new Error(`${role} Chrome did not expose a DevTools port.`);

  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json());
  const target = targets.find(candidate => candidate.type === 'page');
  if (typeof target?.webSocketDebuggerUrl !== 'string') throw new Error(`${role} Chrome exposed no page target.`);
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error(`${role} DevTools connection failed.`)), { once: true });
  });

  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    sequence += 1;
    pending.set(sequence, { resolve, reject });
    socket.send(JSON.stringify({ id: sequence, method, params }));
  });
  const evaluate = async expression => {
    const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      throw new Error(`${role} browser evaluation failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    }
    return result.result?.value;
  };
  const waitFor = async (expression, message, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await sleep(200);
    }
    throw new Error(`${role}: ${message}`);
  };
  const click = async selector => {
    const clicked = await evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!(element instanceof HTMLElement)) return false; element.click(); return true; })()`);
    if (!clicked) throw new Error(`${role}: could not click ${selector}.`);
  };
  const submit = async (selector, fields) => {
    const submitted = await evaluate(`(() => {
      const form = document.querySelector(${JSON.stringify(selector)});
      if (!(form instanceof HTMLFormElement)) return false;
      const values = ${JSON.stringify(fields)};
      for (const [name, value] of Object.entries(values)) {
        const element = form.elements.namedItem(name);
        if (!(element instanceof HTMLElement) || !('value' in element)) throw new Error('Missing form field ' + name);
        element.value = value;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }
      form.requestSubmit();
      return true;
    })()`);
    if (!submitted) throw new Error(`${role}: could not submit ${selector}.`);
  };
  const state = () => evaluate(`fetch('/api/workspace/state').then(response => response.json())`);
  const uploadFile = async (selector, path) => {
    const documentNode = await command('DOM.getDocument', { depth: -1, pierce: true });
    const fileNode = await command('DOM.querySelector', { nodeId: documentNode.root.nodeId, selector });
    if (!fileNode.nodeId) throw new Error(`${role}: file input ${selector} was not found.`);
    await command('DOM.setFileInputFiles', { nodeId: fileNode.nodeId, files: [path] });
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new Event('change', { bubbles: true }))`);
  };
  const screenshot = async path => {
    const captured = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(path, Buffer.from(captured.data, 'base64'));
  };
  const close = async () => {
    socket.close();
    processHandle.kill('SIGTERM');
    await Promise.race([new Promise(resolve => processHandle.once('exit', resolve)), sleep(2_000)]);
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };

  await command('Page.enable');
  await command('Runtime.enable');
  await command('DOM.enable');
  const url = new URL(`/?role=${role.toLowerCase()}`, origin).href;
  const navigation = await command('Page.navigate', { url });
  if (navigation.errorText) throw new Error(`${role} navigation failed: ${navigation.errorText}`);
  await waitFor(`location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`, 'role login did not load.');
  if (captureDirectory && role === 'COMPANY') {
    await screenshot(join(captureDirectory, '01-landing.png'));
  }
  if (role === 'COMPANY') {
    await uploadFile('#companyIdentityFile', identityDraft);
    await waitFor('document.querySelector("#companyIdentityFileStatus")?.dataset.tone === "success"', 'company identity document did not autofill.', 45_000);
    const onboardingSurface = await evaluate(`({
      visibleDetailFields: Array.from(document.querySelectorAll('#companyOnboarding .company-onboarding-grid input, #companyOnboarding .company-onboarding-grid select, #companyOnboarding .company-onboarding-grid textarea')).filter(element => element.offsetParent !== null).length,
      submitUnlocked: document.querySelector('#loginForm .login-submit')?.disabled === false
    })`);
    if (onboardingSurface.visibleDetailFields !== 0 || !onboardingSurface.submitUnlocked) throw new Error(`COMPANY: onboarding is not upload-only: ${JSON.stringify(onboardingSurface)}`);
  }
  await click('#loginForm .login-submit');
  await waitFor('document.querySelector("#portalWorld")?.classList.contains("open")', 'portal did not open.', 35_000);
  await waitFor('document.querySelector("#workflowStatus")?.textContent.includes("READY")', 'workspace did not initialize.', 12_000);
  if (captureDirectory) {
    await evaluate(`(() => { document.querySelector('#portalGuide')?.classList.remove('open'); document.querySelector('.portal-main')?.scrollTo(0, 0); return true; })()`);
    await screenshot(join(captureDirectory, role === 'COMPANY' ? '02-company-portal.png' : '03-freelancer-portal.png'));
  }
  return { role, command, evaluate, waitFor, click, submit, uploadFile, state, screenshot, close };
}

async function capture(browser, name) {
  if (!captureDirectory) return;
  await browser.evaluate(`(() => { document.querySelector('.portal-main')?.scrollTo(0, 0); return true; })()`);
  await sleep(500);
  await browser.screenshot(join(captureDirectory, `${name}.png`));
}

const resetResponse = await fetch(new URL('/api/workflow/reset', origin), {
  method: 'POST', headers: { 'x-anchor-role': 'COMPANY' },
});
if (!resetResponse.ok) throw new Error(`Could not prepare a clean Company workspace (HTTP ${resetResponse.status}).`);

const company = await launch('COMPANY');
const freelancer = await launch('FREELANCER');

try {
  const initial = await company.state();
  if (!initial.run || !['COMPANY_ONBOARDING', 'JOB_DRAFT'].includes(initial.run.phase)) throw new Error(`Expected onboarding or a clean JOB_DRAFT workspace, got ${initial.run?.phase}.`);
  const startedAt = initial.run.startedAt;
  await sleep(3_600);
  const afterPolling = await freelancer.state();
  if (afterPolling.run?.startedAt !== startedAt) throw new Error('Background polling reset the shared deal.');
  for (const browser of [company, freelancer]) {
    const dashboardControl = await browser.evaluate(`({
      visible: document.querySelector('#portalDashboard')?.offsetParent !== null,
      label: document.querySelector('#portalDashboard')?.textContent?.trim(),
      current: document.querySelector('#portalDashboard')?.getAttribute('aria-current')
    })`);
    if (!dashboardControl.visible || dashboardControl.label !== 'HOME PAGE' || dashboardControl.current !== 'page') {
      throw new Error(`${browser.role}: dashboard control is missing or inactive: ${JSON.stringify(dashboardControl)}`);
    }
    await browser.click('#portalDashboard');
    const afterDashboard = await browser.state();
    if (afterDashboard.run?.startedAt !== startedAt) throw new Error(`${browser.role}: dashboard navigation replaced the active deal.`);
  }

  const roleSeparation = await freelancer.evaluate(`({
    hasCompanyForm: document.querySelector('[data-workspace-form="job"]') !== null,
    hasReset: document.querySelector('#workflowReset')?.offsetParent !== null,
    text: document.querySelector('#workspaceAction')?.innerText ?? ''
  })`);
  if (roleSeparation.hasCompanyForm || roleSeparation.hasReset || /POST A JOB|PUBLISH OPPORTUNITY/iu.test(roleSeparation.text)) {
    throw new Error(`Freelancer portal leaked Company controls: ${JSON.stringify(roleSeparation)}`);
  }
  const forbiddenReset = await freelancer.evaluate(`fetch('/api/workflow/reset', { method: 'POST', headers: { 'x-anchor-role': 'FREELANCER' } }).then(async response => ({ status: response.status, body: await response.json() }))`);
  if (forbiddenReset.status !== 403) throw new Error(`Freelancer reset was not rejected: ${JSON.stringify(forbiddenReset)}`);

  if (initial.run.phase === 'COMPANY_ONBOARDING') {
    await company.waitFor('document.querySelector("[data-workspace-form=onboard]") !== null', 'Company onboarding form is missing.');
    await company.uploadFile('[data-extract-purpose="COMPANY_POLICY"]', policyDraft);
    await company.waitFor('document.querySelector("[data-workspace-form=onboard] [data-extraction-status]")?.dataset.tone === "success"', 'Company policy extraction did not complete.', 45_000);
    await company.submit('[data-workspace-form="onboard"]', {
      companyCountry, fundingCurrency,
      policies: 'Confidential information remains private to authorized contract participants.\nRepository access follows least privilege.',
      legalClauses: 'Governing law follows the verified company jurisdiction.\nDisputes follow written escalation before the agreed forum.',
      commercialStandards: 'One evidence-backed revision is included.\nInvoices are issued after milestone acceptance.',
      authorizedApprovers: 'Procurement Director\nEngineering Director',
    });
  }
  await company.waitFor('document.querySelector("[data-workspace-form=job]") !== null', 'Company brief form is missing.');
  await capture(company, '04-company-policy-authorized');
  const jobRouteControls = await company.evaluate(`({
    countries: document.querySelectorAll('[data-workspace-form="job"] [name="payerCountry"] option').length,
    currencies: document.querySelectorAll('[data-workspace-form="job"] [name="fundingCurrency"] option').length
  })`);
  if (jobRouteControls.countries !== 6 || jobRouteControls.currencies !== 6) throw new Error(`Company job route controls are incomplete: ${JSON.stringify(jobRouteControls)}`);
  const defaultReleaseMode = await company.evaluate(`({
    selected: document.querySelector('[data-workspace-form="job"] [name="deliveryMode"]:checked')?.value,
    singleVisible: document.querySelector('[data-single-delivery]')?.hidden === false,
    milestoneHidden: document.querySelector('[data-milestone-delivery]')?.hidden === true,
    milestoneFields: document.querySelectorAll('[data-milestone-editor] .milestone-input-card').length,
    singleBudgetRequired: document.querySelector('[name="singleBudget"]')?.required === true,
    singleBudgetValue: document.querySelector('[name="singleBudget"]')?.value,
    singleBudgetPlaceholder: document.querySelector('[name="singleBudget"]')?.placeholder
  })`);
  if (defaultReleaseMode.selected !== 'SINGLE' || !defaultReleaseMode.singleVisible || !defaultReleaseMode.milestoneHidden
    || defaultReleaseMode.milestoneFields !== 0 || !defaultReleaseMode.singleBudgetRequired
    || defaultReleaseMode.singleBudgetValue !== '' || defaultReleaseMode.singleBudgetPlaceholder !== 'Enter the amount') {
    throw new Error(`Single-delivery mode is not the clean default: ${JSON.stringify(defaultReleaseMode)}`);
  }
  await company.click('[name="deliveryMode"][value="MILESTONES"]');
  const milestoneReleaseMode = await company.evaluate(`({
    selected: document.querySelector('[data-workspace-form="job"] [name="deliveryMode"]:checked')?.value,
    singleHidden: document.querySelector('[data-single-delivery]')?.hidden === true,
    milestoneVisible: document.querySelector('[data-milestone-delivery]')?.hidden === false,
    milestoneFields: document.querySelectorAll('[data-milestone-editor] .milestone-input-card').length,
    singleBudgetDisabled: document.querySelector('[name="singleBudget"]')?.disabled === true,
    amountValues: Array.from(document.querySelectorAll('[data-milestone-amount]')).map(element => element.value),
    amountPlaceholders: Array.from(document.querySelectorAll('[data-milestone-amount]')).map(element => element.placeholder)
  })`);
  if (milestoneReleaseMode.selected !== 'MILESTONES' || !milestoneReleaseMode.singleHidden || !milestoneReleaseMode.milestoneVisible
    || milestoneReleaseMode.milestoneFields !== 2 || !milestoneReleaseMode.singleBudgetDisabled
    || milestoneReleaseMode.amountValues.some(value => value !== '')
    || milestoneReleaseMode.amountPlaceholders.some(value => value !== 'Enter the amount')) {
    throw new Error(`Milestone release mode did not activate explicitly: ${JSON.stringify(milestoneReleaseMode)}`);
  }
  await company.uploadFile('[data-extract-purpose="JOB_BRIEF"]', jobDraft);
  await company.waitFor('["success", "warning", "error"].includes(document.querySelector("[data-extraction-status]")?.dataset.tone)', 'Company brief extraction returned no final status.', 45_000);
  const companyExtraction = await company.evaluate('({ tone: document.querySelector("[data-extraction-status]")?.dataset.tone, text: document.querySelector("[data-extraction-status]")?.textContent })');
  if (!["success", "warning"].includes(companyExtraction.tone)) throw new Error(`Company brief was not extracted: ${JSON.stringify(companyExtraction)}`);
  await sleep(3_600);
  const extractedTitle = await company.evaluate('document.querySelector("[data-workspace-form=job] [name=title]")?.value');
  if (!/auditable cross-border reconciliation engine/iu.test(extractedTitle)) throw new Error(`Company brief title was not autofilled: ${extractedTitle}`);
  const retainedCompanyFile = await company.evaluate('document.querySelector("[data-draft-file-name]")?.textContent');
  if (retainedCompanyFile !== 'company-brief.txt') throw new Error(`Company brief selection was not retained: ${retainedCompanyFile}`);
  await capture(company, '05-ai-document-extraction');
  await company.submit('[data-workspace-form="job"]', {
    title: 'Build an auditable cross-border reconciliation engine',
    description: `Deliver a production-shaped TypeScript reconciliation engine, automated tests, operating guide, and proof dashboard for the ${companyCountry} to ${freelancerCountry} corridor.`,
    acceptanceCriteria: 'All integration tests pass\nFabric and Algorand references reconcile\nNo personal data appears on either ledger',
    skills: 'TypeScript, PostgreSQL, Hyperledger Fabric, Algorand',
    milestoneCount: '2',
    milestoneTitle1: 'Architecture and proof model',
    milestoneDescription1: 'Define the reconciliation invariants, ledger boundaries and executable acceptance plan.',
    milestoneDeliverable1: 'Architecture PDF and acceptance-test specification',
    milestoneAcceptance1: 'Trust boundaries are documented\nTest cases map to every invariant',
    milestoneAmount1: milestoneOneAmount, milestoneDueDate1: '2026-10-15',
    milestoneTitle2: 'Working engine and evidence pack',
    milestoneDescription2: 'Implement the approved design and prove restart-safe cross-ledger reconciliation.',
    milestoneDeliverable2: 'Source archive, test report and operations guide',
    milestoneAcceptance2: 'All integration tests pass\nFabric and Algorand references reconcile',
    milestoneAmount2: milestoneTwoAmount, milestoneDueDate2: '2026-10-31',
    deliveryDate: '2026-10-31', payerCountry: companyCountry, fundingCurrency,
  });
  await freelancer.waitFor('document.querySelector("[data-workspace-form=apply]") !== null', 'Published job did not appear for the Freelancer.', 20_000);
  await capture(freelancer, '06-freelancer-opportunity');
  await freelancer.waitFor('document.querySelector("#notificationList")?.innerText.includes("NEW OPPORTUNITY") === true && Number(document.querySelector("#notificationBadge")?.textContent) > 0', 'Freelancer did not receive the new-opportunity notification.', 15_000);
  const payoutCountryOptions = await freelancer.evaluate(`Array.from(document.querySelector('[name="payoutCountry"]')?.options ?? []).map(option => option.value).filter(Boolean).sort()`);
  if (JSON.stringify(payoutCountryOptions) !== JSON.stringify(supportedCountryCodes)) throw new Error(`Freelancer country selector is incomplete: ${JSON.stringify(payoutCountryOptions)}`);
  const visibleOpportunity = await freelancer.evaluate(`document.querySelector('#workspaceAction')?.innerText ?? ''`);
  if (!/AUDITABLE CROSS-BORDER RECONCILIATION ENGINE/iu.test(visibleOpportunity)) throw new Error('Freelancer did not receive the Company job title.');
  const emptyProposalPrice = await freelancer.evaluate(`({ value: document.querySelector('[name="proposedPrice"]')?.value, placeholder: document.querySelector('[name="proposedPrice"]')?.placeholder })`);
  if (emptyProposalPrice.value !== '' || emptyProposalPrice.placeholder !== 'Enter the amount') throw new Error(`Freelancer price was prefilled: ${JSON.stringify(emptyProposalPrice)}`);

  await freelancer.uploadFile('[data-extract-purpose="FREELANCER_PROPOSAL"]', proposalDraft);
  await freelancer.waitFor('["success", "warning", "error"].includes(document.querySelector("[data-extraction-status]")?.dataset.tone)', 'Freelancer proposal extraction returned no final status.', 45_000);
  const freelancerExtraction = await freelancer.evaluate('({ tone: document.querySelector("[data-extraction-status]")?.dataset.tone, text: document.querySelector("[data-extraction-status]")?.textContent })');
  if (!["success", "warning"].includes(freelancerExtraction.tone)) throw new Error(`Freelancer proposal was not extracted: ${JSON.stringify(freelancerExtraction)}`);
  await sleep(3_600);
  const extractedPrice = await freelancer.evaluate('document.querySelector("[data-workspace-form=apply] [name=proposedPrice]")?.value');
  if (Number(extractedPrice) !== Number(proposalPriceAmount)) {
    const extractionDebug = await freelancer.evaluate(`({
      phase: document.querySelector('[data-workspace-form=apply]') ? 'FORM_VISIBLE' : 'FORM_MISSING',
      tone: document.querySelector('[data-workspace-form=apply] [data-extraction-status]')?.dataset.tone,
      status: document.querySelector('[data-workspace-form=apply] [data-extraction-status]')?.textContent,
      dirty: document.querySelector('[data-workspace-form=apply]')?.dataset.dirty,
      file: document.querySelector('[data-workspace-form=apply] [data-draft-file-name]')?.textContent
    })`);
    throw new Error(`Freelancer proposal price was not autofilled: ${extractedPrice}; ${JSON.stringify(extractionDebug)}`);
  }
  const retainedProposalFile = await freelancer.evaluate('document.querySelector("[data-draft-file-name]")?.textContent');
  if (retainedProposalFile !== 'freelancer-proposal.txt') throw new Error(`Freelancer proposal selection was not retained: ${retainedProposalFile}`);
  await freelancer.submit('[data-workspace-form="apply"]', {
    proposedPrice: proposalPriceAmount, deliveryDays: '16',
    residenceCountry: freelancerCountry, payoutCountry: freelancerCountry, payoutCurrency,
    availability: 'Available immediately for 32 hours per week',
    approach: 'Start with executable acceptance tests, implement reconciliation invariants, and provide signed evidence for every milestone.',
    coverLetter: 'I build TypeScript settlement services and evidence-led approval systems for regulated cross-border workflows.',
  });
  await company.waitFor('document.querySelector("#notificationList")?.innerText.includes("NEW FREELANCER PROPOSAL") === true && Number(document.querySelector("#notificationBadge")?.textContent) > 0', 'Company did not receive the new-proposal notification.', 15_000);
  await company.waitFor(`fetch('/api/workspace/state').then(response => response.json()).then(value => value.run?.screening?.status === 'COMPLETED')`, 'Screening did not complete.', 60_000);
  await company.waitFor('document.querySelectorAll("[data-select-application]").length === 3', 'Three selectable freelancer proposals did not render.', 15_000);
  await capture(company, '07-ai-ranked-proposals');
  const screenedState = await company.state();
  const signedInApplication = screenedState.run.results.applications.find(application => application.applicantUserId === freelancerUserId);
  if (!signedInApplication) throw new Error('The authenticated Freelancer proposal is missing from screening.');
  const selected = await company.evaluate(`(() => {
    const button = document.querySelector('[data-select-application=${JSON.stringify(signedInApplication.id)}]');
    if (!(button instanceof HTMLElement)) return false;
    button.click(); return true;
  })()`);
  if (!selected) throw new Error('Company could not select the signed-in Freelancer proposal.');
  await freelancer.waitFor('document.querySelector("#notificationList")?.innerText.includes("YOU WERE SELECTED") === true', 'Freelancer did not receive the selection notification.', 15_000);

  await company.waitFor('document.querySelector("[data-workspace-form=terms]") !== null', 'Sourced agreement generation control did not render.', 15_000);
  await company.submit('[data-workspace-form="terms"]', {});
  await company.waitFor('document.querySelector("[data-approve-company-agreement]") !== null', 'Generated agreement did not reach Company review.', 20_000);
  await capture(company, '08-company-agreement');
  await company.click('[data-approve-company-agreement]');
  await freelancer.waitFor('document.querySelector("[data-approve-agreement]") !== null', 'Private agreement did not reach the selected Freelancer.', 20_000);
  await capture(freelancer, '09-freelancer-agreement');
  await freelancer.click('[data-approve-agreement]');
  await freelancer.waitFor(`fetch('/api/workspace/state').then(response => response.json()).then(value => value.run?.phase === 'AWAITING_DELIVERY')`, 'Policy, FX, compliance, and escrow automation did not finish.', 150_000);
  await capture(freelancer, '10-compliance-fx-escrow');
  const funded = await freelancer.state();
  if (!funded.run?.results?.binding?.dealId || funded.run?.automation?.status !== 'COMPLETED') throw new Error('No confirmed Algorand escrow binding was returned.');
  if (funded.run?.results?.milestonePayments?.length !== 2
    || new Set(funded.run.results.milestonePayments.map(entry => entry.binding?.dealId ?? entry.timeline?.binding?.dealId)).size !== 2) {
    throw new Error(`Two independent milestone escrows were not funded: ${JSON.stringify(funded.run?.results?.milestonePayments)}`);
  }
  await company.waitFor('document.querySelector("#notificationList")?.innerText.includes("MONEY DEDUCTED & ESCROWED") === true', 'Company did not receive the funding-debit notification.', 15_000);
  await freelancer.waitFor('document.querySelector("#notificationList")?.innerText.includes("ESCROW SECURED") === true', 'Freelancer did not receive the secured-escrow notification.', 15_000);
  if (funded.run?.results?.regulatoryPlan?.orderedRoute !== orderedRoute
    || funded.run?.results?.regulatoryPlan?.outcome !== 'PASSED'
    || funded.run?.results?.regulatoryPlan?.categories?.length !== 5
    || !String(funded.run?.results?.quote?.rateSource ?? '').startsWith('FRANKFURTER_ECB_')) {
    throw new Error(`Deal-derived regulation/FX trace is incomplete: ${JSON.stringify(funded.run?.results?.regulatoryPlan)}`);
  }

  for (let milestoneIndex = 0; milestoneIndex < 2; milestoneIndex += 1) {
    await freelancer.waitFor('document.querySelector("[data-workspace-form=submit]") !== null', `Milestone ${milestoneIndex + 1} deliverable form did not render.`, 35_000);
    await capture(freelancer, `11-milestone-${milestoneIndex + 1}-delivery`);
    await freelancer.uploadFile('[data-workspace-form="submit"] input[type="file"]', deliverable);
    await freelancer.submit('[data-workspace-form="submit"]', {
      note: `Complete evidence pack for milestone ${milestoneIndex + 1}, including tests and reviewer instructions.`,
    });
    await company.waitFor(`document.querySelector("#notificationList")?.innerText.includes("WORK SUBMITTED") === true`, `Company did not receive the milestone ${milestoneIndex + 1} delivery notification.`, 15_000);
    await company.waitFor(`fetch('/api/workspace/state').then(response => response.json()).then(value => value.run?.phase === 'AWAITING_WORK_APPROVAL')`, `Milestone ${milestoneIndex + 1} did not reach Company approval.`, 90_000);
    await company.waitFor('document.querySelector("[data-approve-work]") !== null', `Milestone ${milestoneIndex + 1} approval control did not render.`, 20_000);
    await capture(company, `12-milestone-${milestoneIndex + 1}-fabric-review`);
    await company.click('[data-approve-work]');
    await company.waitFor('document.querySelector("[data-route-optimizer]") !== null', 'Live settlement router screen did not render after Fabric approval.', 15_000);
    await company.waitFor('document.querySelector("[data-route-optimizer][data-ready=true]") !== null', 'Persisted provider decision did not reach the live route screen.', 45_000);
    await capture(company, `13-milestone-${milestoneIndex + 1}-route-optimizer`);
    if (milestoneIndex === 0) {
      const routeScene = await company.evaluate(`({
        stages: document.querySelectorAll('[data-route-optimizer] .route-optimizer-path li').length,
        candidates: document.querySelectorAll('[data-route-optimizer] .settlement-router-panel article').length,
        selected: document.querySelectorAll('[data-route-optimizer] .settlement-router-panel article[data-selected="true"]').length,
        rejected: document.querySelectorAll('[data-route-optimizer] .settlement-router-panel article[data-eligible="false"]').length,
        text: document.querySelector('[data-route-optimizer]')?.innerText ?? ''
      })`);
      if (routeScene.stages !== 6 || routeScene.candidates !== 3 || routeScene.selected !== 1 || routeScene.rejected < 1 || !/AUTHORIZED ROUTE HASH/iu.test(routeScene.text)) {
        throw new Error(`Live route optimizer scene is incomplete: ${JSON.stringify(routeScene)}`);
      }
      // Public TestNet confirmation can take longer than a normal block window
      // when the algod provider is under load. The route view remains visible
      // while release is pending and hands off to the transfer scene only after
      // the persisted completion record reaches the browser.
      await company.waitFor('document.querySelector("[data-transfer-screen]") !== null', 'Post-routing money transfer screen did not render.', 75_000);
      await company.waitFor(`fetch('/api/workspace/state').then(response => response.json()).then(value => value.run?.phase === 'AWAITING_DELIVERY' && value.run?.results?.activeMilestoneIndex === 1)`, 'The first release did not advance to milestone two.', 150_000);
    } else {
      await company.waitFor(`fetch('/api/workspace/state').then(response => response.json()).then(value => value.run?.phase === 'COMPLETED')`, 'The final milestone release did not complete the deal.', 150_000);
    }
  }

  const finalMilestones = await company.state();
  if (finalMilestones.run?.results?.completedMilestoneCount !== 2
    || finalMilestones.run?.results?.milestonePayments?.some(entry => (entry.timeline?.payment ?? entry.payment)?.state !== 'COMPLETED')) {
    throw new Error(`Not every milestone reached a confirmed release: ${JSON.stringify(finalMilestones.run?.results?.milestonePayments)}`);
  }

  await company.waitFor('document.querySelectorAll("#workspaceStages [data-state=done]").length === 6', 'Company journey rail did not complete.', 15_000);
  await freelancer.waitFor('document.querySelectorAll("#workspaceStages [data-state=done]").length === 6', 'Freelancer journey rail did not complete.', 15_000);
  await company.waitFor('document.querySelector("[data-transfer-screen][data-state=completed] .deal-complete-confirmation") !== null', 'Company payment confirmation did not render the completed release.', 15_000);
  await freelancer.waitFor('document.querySelector("[data-transfer-screen][data-state=completed] .deal-complete-confirmation") !== null', 'Freelancer payment confirmation did not render the completed release.', 15_000);
  await company.waitFor('document.querySelector("[data-settlement-analytics] .settlement-receipt")?.textContent.includes("100% ACCOUNTED") === true', 'Company did not advance from payment confirmation to the fresh reconciled analytics page.', 15_000);
  await freelancer.waitFor('document.querySelector("[data-settlement-analytics] .settlement-receipt")?.textContent.includes("100% ACCOUNTED") === true', 'Freelancer did not advance from payment confirmation to the fresh reconciled analytics page.', 15_000);
  await capture(company, '14-completed-settlement');
  await capture(freelancer, '15-freelancer-paid');
  await company.waitFor('document.querySelector("#freelancerRatingModal")?.classList.contains("open") === true', 'The completed company deal did not open the freelancer rating prompt.', 15_000);
  const ratingPrompt = await Promise.all([company, freelancer].map(browser => browser.evaluate(`({
    visible: document.querySelector('#freelancerRatingModal')?.hidden === false,
    name: document.querySelector('#freelancerRatingName')?.textContent,
    job: document.querySelector('#freelancerRatingJob')?.textContent
  })`)));
  if (!ratingPrompt[0].visible || ratingPrompt[1].visible || !ratingPrompt[0].name || ratingPrompt[0].job !== 'Build an auditable cross-border reconciliation engine') {
    throw new Error(`The post-deal rating prompt is not company-only or deal-derived: ${JSON.stringify(ratingPrompt)}`);
  }
  await company.evaluate(`(() => {
    const star = document.querySelector('#ratingStar5');
    const review = document.querySelector('#freelancerRatingForm textarea[name="review"]');
    const form = document.querySelector('#freelancerRatingForm');
    if (!(star instanceof HTMLInputElement) || !(review instanceof HTMLTextAreaElement) || !(form instanceof HTMLFormElement)) return false;
    star.checked = true;
    review.value = 'Excellent delivery, clear evidence and dependable milestone communication.';
    form.requestSubmit();
    return true;
  })()`);
  await company.waitFor(`fetch('/api/workspace/state').then(response => response.json()).then(value => value.run?.results?.freelancerRating?.stars === 5 && value.run?.results?.freelancerRating?.ratingCount >= 1)`, 'The freelancer rating was not persisted with the completed deal.', 15_000);
  await company.waitFor('document.querySelector(".analytics-rating-result")?.textContent.includes("5.0/5") === true', 'The company did not receive the updated freelancer rating summary.', 15_000);
  await freelancer.waitFor('document.querySelector(".analytics-rating-result")?.textContent.includes("RATED 5.0/5") === true', 'The freelancer portal did not receive the company rating.', 15_000);
  await company.waitFor('document.querySelector("#notificationList")?.innerText.includes("PAYMENT RELEASED") === true', 'Company did not receive the payment-release notification.', 15_000);
  await freelancer.waitFor('document.querySelector("#notificationList")?.innerText.includes("MILESTONE PAYMENT RECEIVED") === true', 'Freelancer did not receive the milestone payout notification.', 15_000);
  await freelancer.waitFor('document.querySelector("#notificationList")?.innerText.includes("NEW COMPANY RATING") === true', 'The freelancer did not receive the persisted rating notification.', 15_000);
  const notificationInteraction = await freelancer.evaluate(`(() => {
    const button = document.querySelector('#notificationButton');
    if (!(button instanceof HTMLButtonElement)) return null;
    const unreadBefore = Number(document.querySelector('#notificationBadge')?.textContent ?? 0);
    button.click();
    return {
      unreadBefore,
      expanded: button.getAttribute('aria-expanded'),
      panelOpen: document.querySelector('#notificationPopover')?.hidden === false,
      badgeCleared: document.querySelector('#notificationBadge')?.hidden === true,
      alertCount: document.querySelectorAll('#notificationList article').length,
    };
  })()`);
  if (!notificationInteraction?.unreadBefore || notificationInteraction.expanded !== 'true' || !notificationInteraction.panelOpen
    || !notificationInteraction.badgeCleared || notificationInteraction.alertCount < 4) {
    throw new Error(`Notification inbox interaction is incomplete: ${JSON.stringify(notificationInteraction)}`);
  }
  const analyticsLayout = await company.evaluate(`({
    view: document.querySelector('#portalWorkflow')?.dataset.view,
    transferStillVisible: document.querySelector('[data-transfer-screen]') !== null,
    railVisible: document.querySelector('.stage-rail')?.offsetParent !== null,
    workspaceHeadingVisible: document.querySelector('.workspace-heading')?.offsetParent !== null,
    newDealAtBottom: document.querySelector('.settlement-receipt > .analytics-minimal-footer:last-child [data-start-new-deal]') !== null
  })`);
  if (analyticsLayout.view !== 'analytics' || analyticsLayout.transferStillVisible || analyticsLayout.railVisible || analyticsLayout.workspaceHeadingVisible || !analyticsLayout.newDealAtBottom) {
    throw new Error(`Completed deal did not become a clean analytics destination: ${JSON.stringify(analyticsLayout)}`);
  }
  const settlementReceipt = await company.evaluate(`({
    sections: Array.from(document.querySelectorAll('[data-settlement-analytics] [data-analytics-section]')).map(element => ({ id: element.dataset.analyticsSection, text: element.innerText })),
    analyticsCards: document.querySelectorAll('.settlement-kpis article').length,
    reconciliationChecks: document.querySelectorAll('.analytics-reconciliation > span').length,
    milestoneProofs: document.querySelectorAll('.analytics-milestone-proof > article').length,
    fxLegs: document.querySelectorAll('.analytics-fx-legs > div').length,
    commands: document.querySelectorAll('.provider-command-list > div').length,
    atAGlance: document.querySelector('[data-analytics-section="at-a-glance"]')?.innerText ?? '',
    removedSections: document.querySelectorAll('.settlement-journey, .settlement-router-panel, .fee-impact, .conservation-proof, .settlement-audit, .milestone-settlement-summary, .settlement-next-deal').length,
    text: document.querySelector('.settlement-receipt')?.innerText ?? ''
  })`);
  const requiredAnalyticsHeadings = [
    'END-TO-END SETTLEMENT INTELLIGENCE', 'THE SETTLEMENT, AT A GLANCE', 'TRUST RAIL PROOF',
    'MONEY FLOW + DEDUCTIONS', 'CORRIDOR RULE DECISION', 'FX QUOTE PROVENANCE',
  ];
  if (settlementReceipt.sections.length !== 6
    || requiredAnalyticsHeadings.some(heading => !settlementReceipt.sections.some(section => section.text.includes(heading)))
    || settlementReceipt.analyticsCards !== 4
    || settlementReceipt.reconciliationChecks !== 4
    || settlementReceipt.milestoneProofs !== 2
    || settlementReceipt.fxLegs !== 2
    || settlementReceipt.commands < 8
    || !settlementReceipt.atAGlance.includes(`${Number(proposalPriceAmount).toFixed(2)} ${fundingCurrency}`)
    || settlementReceipt.removedSections !== 0
    || !/REGULATIONS FETCHED/iu.test(settlementReceipt.text)
    || !/RATE OBSERVED/iu.test(settlementReceipt.text)
    || !/HYPERLEDGER FABRIC/iu.test(settlementReceipt.text)
    || !/ALGORAND ARC-4/iu.test(settlementReceipt.text)) {
    throw new Error(`Completed settlement receipt is incomplete: ${JSON.stringify(settlementReceipt)}`);
  }
  const roleAnalytics = await Promise.all([company, freelancer].map(browser => browser.evaluate(`Array.from(document.querySelectorAll('[data-settlement-analytics] [data-analytics-section]')).map(element => element.innerText)`)));
  if (JSON.stringify(roleAnalytics[0]) !== JSON.stringify(roleAnalytics[1])) throw new Error('Company and Freelancer analytics sections do not show the same persisted facts.');
  await Promise.all([company, freelancer].map(browser => browser.evaluate(`(() => { const receipt = document.querySelector('.settlement-receipt'); if (!receipt) return false; receipt.dataset.pollingProbe = 'stable'; return true; })()`)));
  await sleep(3_600);
  const stableAcrossPoll = await Promise.all([company, freelancer].map(browser => browser.evaluate(`document.querySelector('.settlement-receipt')?.dataset.pollingProbe === 'stable'`)));
  if (stableAcrossPoll.some(value => value !== true)) throw new Error(`An unchanged polling response rebuilt the analytics page: ${JSON.stringify(stableAcrossPoll)}`);
  const companyGuide = await company.evaluate(`({ title: document.querySelector('#dealCompanionTitle')?.textContent, copy: document.querySelector('#dealCompanionCopy')?.textContent, image: document.querySelector('#dealCompanionCharacter')?.getAttribute('src') })`);
  const freelancerGuide = await freelancer.evaluate(`({ title: document.querySelector('#dealCompanionTitle')?.textContent, copy: document.querySelector('#dealCompanionCopy')?.textContent, image: document.querySelector('#dealCompanionCharacter')?.getAttribute('src') })`);
  if (companyGuide.title !== 'DEAL COMPLETE' || !companyGuide.copy?.includes(payoutCurrency) || !companyGuide.image?.includes('company')) throw new Error(`Company live guide is not transaction-derived: ${JSON.stringify(companyGuide)}`);
  if (freelancerGuide.title !== 'DEAL COMPLETE' || !freelancerGuide.copy?.includes(payoutCurrency) || !freelancerGuide.image?.includes('freelancer')) throw new Error(`Freelancer live guide is not role-aware: ${JSON.stringify(freelancerGuide)}`);
  const finalState = await company.state();
  if (!finalState.run?.results?.fabricDecisionTxId || !finalState.run?.results?.binding?.dealId) throw new Error('Final ledger proofs are incomplete.');
  await company.click('[data-inspect-stage="05"]');
  await company.waitFor('document.querySelector(".automation-workspace") !== null', 'Completed decision trace did not open.', 15_000);
  await company.waitFor('document.querySelector(".automation-workspace")?.textContent.includes("ACTIVE") === true', 'Compliance trace did not expose the active backend outcome.', 15_000);
  await company.waitFor('document.querySelector(".hard-gate")?.textContent.includes("QUOTE + FUNDING AUTHORIZED") === true', 'Backend hard-gate authorization did not render.', 15_000);
  await company.waitFor('document.querySelector(".automation-workspace")?.textContent.includes("FRANKFURTER") === true', 'FX trace did not expose the persisted rate source.', 15_000);
  await company.waitFor(`document.querySelector(".corridor-trace h4")?.textContent.includes(${JSON.stringify(renderedRoute)}) === true`, 'Ordered participant-derived corridor did not render.', 15_000);
  await company.waitFor(`document.querySelector("#portalNetworkRoute")?.textContent.includes(${JSON.stringify(orderedRoute)}) === true`, 'Portal network badge did not follow the active deal route.', 15_000);
  await company.screenshot(`/home/infinity/Documents/Codex/2026-09-03/cr/work/anchor-company-decision-trace-${artifactSuffix}.png`);
  await company.click('[data-return-live]');
  await company.screenshot(`/home/infinity/Documents/Codex/2026-09-03/cr/work/anchor-company-completed-${artifactSuffix}.png`);
  await freelancer.screenshot(`/home/infinity/Documents/Codex/2026-09-03/cr/work/anchor-freelancer-completed-${artifactSuffix}.png`);

  process.stdout.write(`${JSON.stringify({
    status: 'passed',
    orderedRoute: finalState.run.results.regulatoryPlan?.orderedRoute,
    regulatoryPlanHash: finalState.run.results.regulatoryPlan?.planHash,
    regulatoryOutcome: finalState.run.results.regulatoryPlan?.outcome,
    officialSourcesChecked: finalState.run.results.regulation?.report?.observations?.length,
    jobVisibleAcrossSessions: true,
    freelancerResetRejected: true,
    proposalsRendered: finalState.run.results.applications.length,
    agreementHash: finalState.run.results.agreement?.artifactHash,
    fabricEvidenceId: finalState.run.results.submission?.evidenceId,
    fabricDecisionTxId: finalState.run.results.fabricDecisionTxId,
    algorandDealId: finalState.run.results.binding.dealId,
    finalPhase: finalState.run.phase,
  }, null, 2)}\n`);
} finally {
  await Promise.allSettled([company.close(), freelancer.close(), rm(draftDirectory, { recursive: true, force: true })]);
}
