import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const chrome = [process.argv[2], process.env.CHROME_BIN, '/opt/google/chrome/google-chrome', '/usr/bin/google-chrome', '/usr/bin/chromium']
  .find(candidate => candidate && existsSync(candidate));
if (!chrome) throw new Error('Chrome was not found. Pass its path as the first argument or CHROME_BIN.');

const origin = new URL(process.env.ANCHOR_URL ?? 'http://127.0.0.1:4175');
const deliverable = process.env.ANCHOR_DELIVERABLE
  ?? resolve(process.cwd(), 'README.md');
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const draftDirectory = await mkdtemp(join(tmpdir(), 'anchor-form-drafts-'));
const jobDraft = join(draftDirectory, 'company-brief.txt');
const proposalDraft = join(draftDirectory, 'freelancer-proposal.txt');
const agreementDraft = join(draftDirectory, 'commercial-terms.txt');
await writeFile(jobDraft, [
  'Title: Build an auditable cross-border reconciliation engine',
  'Description: Deliver a production-shaped TypeScript reconciliation engine, automated tests, operating guide, and proof dashboard for the Poland to India corridor.',
  'Acceptance criteria: All integration tests pass; Fabric and Algorand references reconcile; No personal data appears on either ledger',
  'Skills: TypeScript, PostgreSQL, Hyperledger Fabric, Algorand',
  'Budget PLN: 12000',
  'Delivery date: 2026-10-31',
].join('\n'));
await writeFile(proposalDraft, [
  'Proposed price PLN: 11800',
  'Delivery days: 16',
  'Availability: Available immediately for 32 hours per week',
  'Approach: Start with executable acceptance tests, implement reconciliation invariants, and provide signed evidence for every milestone.',
  'Cover letter: I build TypeScript settlement services and evidence-led approval systems for regulated cross-border workflows.',
].join('\n'));
await writeFile(agreementDraft, [
  'Commercial terms: The selected proposal price is the complete milestone consideration; one evidence-backed revision is included',
  'Acceptance criteria: All automated tests pass; Fabric and Algorand references reconcile; the runbook and dashboard are delivered',
  'Company policies: Repository access follows least privilege; confidential data remains private to the contracting parties',
  'Legal clauses: Pre-existing IP remains with its owner; accepted deliverables transfer under the signed statement of work',
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
  await click('#loginForm .login-submit');
  await waitFor('document.querySelector("#portalWorld")?.classList.contains("open")', 'portal did not open.', 12_000);
  await waitFor('document.querySelector("#workflowStatus")?.textContent.includes("READY")', 'workspace did not initialize.', 12_000);
  return { role, command, evaluate, waitFor, click, submit, uploadFile, state, screenshot, close };
}

const resetResponse = await fetch(new URL('/api/workflow/reset', origin), {
  method: 'POST', headers: { 'x-anchor-role': 'COMPANY' },
});
if (!resetResponse.ok) throw new Error(`Could not prepare a clean Company workspace (HTTP ${resetResponse.status}).`);

const company = await launch('COMPANY');
const freelancer = await launch('FREELANCER');

try {
  const initial = await company.state();
  if (!initial.run || initial.run.phase !== 'JOB_DRAFT') throw new Error(`Expected a clean JOB_DRAFT workspace, got ${initial.run?.phase}.`);
  const startedAt = initial.run.startedAt;
  await sleep(3_600);
  const afterPolling = await freelancer.state();
  if (afterPolling.run?.startedAt !== startedAt) throw new Error('Background polling reset the shared deal.');

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

  await company.waitFor('document.querySelector("[data-workspace-form=job]") !== null', 'Company brief form is missing.');
  await company.uploadFile('[data-extract-purpose="JOB_BRIEF"]', jobDraft);
  await company.waitFor('["success", "warning", "error"].includes(document.querySelector("[data-extraction-status]")?.dataset.tone)', 'Company brief extraction returned no final status.', 45_000);
  const companyExtraction = await company.evaluate('({ tone: document.querySelector("[data-extraction-status]")?.dataset.tone, text: document.querySelector("[data-extraction-status]")?.textContent })');
  if (!["success", "warning"].includes(companyExtraction.tone)) throw new Error(`Company brief was not extracted: ${JSON.stringify(companyExtraction)}`);
  await sleep(3_600);
  const extractedTitle = await company.evaluate('document.querySelector("[data-workspace-form=job] [name=title]")?.value');
  if (!/auditable cross-border reconciliation engine/iu.test(extractedTitle)) throw new Error(`Company brief title was not autofilled: ${extractedTitle}`);
  const retainedCompanyFile = await company.evaluate('document.querySelector("[data-draft-file-name]")?.textContent');
  if (retainedCompanyFile !== 'company-brief.txt') throw new Error(`Company brief selection was not retained: ${retainedCompanyFile}`);
  await company.submit('[data-workspace-form="job"]', {
    title: 'Build an auditable cross-border reconciliation engine',
    description: 'Deliver a production-shaped TypeScript reconciliation engine, automated tests, operating guide, and proof dashboard for the Poland to India corridor.',
    acceptanceCriteria: 'All integration tests pass\nFabric and Algorand references reconcile\nNo personal data appears on either ledger',
    skills: 'TypeScript, PostgreSQL, Hyperledger Fabric, Algorand',
    budget: '12000.00', deliveryDate: '2026-10-31', destinationCountry: 'IN',
  });
  await freelancer.waitFor('document.querySelector("[data-workspace-form=apply]") !== null', 'Published job did not appear for the Freelancer.', 20_000);
  const visibleOpportunity = await freelancer.evaluate(`document.querySelector('#workspaceAction')?.innerText ?? ''`);
  if (!/AUDITABLE CROSS-BORDER RECONCILIATION ENGINE/iu.test(visibleOpportunity)) throw new Error('Freelancer did not receive the Company job title.');

  await freelancer.uploadFile('[data-extract-purpose="FREELANCER_PROPOSAL"]', proposalDraft);
  await freelancer.waitFor('["success", "warning", "error"].includes(document.querySelector("[data-extraction-status]")?.dataset.tone)', 'Freelancer proposal extraction returned no final status.', 45_000);
  const freelancerExtraction = await freelancer.evaluate('({ tone: document.querySelector("[data-extraction-status]")?.dataset.tone, text: document.querySelector("[data-extraction-status]")?.textContent })');
  if (!["success", "warning"].includes(freelancerExtraction.tone)) throw new Error(`Freelancer proposal was not extracted: ${JSON.stringify(freelancerExtraction)}`);
  await sleep(3_600);
  const extractedPrice = await freelancer.evaluate('document.querySelector("[data-workspace-form=apply] [name=proposedPrice]")?.value');
  if (extractedPrice !== '11800') throw new Error(`Freelancer proposal price was not autofilled: ${extractedPrice}`);
  const retainedProposalFile = await freelancer.evaluate('document.querySelector("[data-draft-file-name]")?.textContent');
  if (retainedProposalFile !== 'freelancer-proposal.txt') throw new Error(`Freelancer proposal selection was not retained: ${retainedProposalFile}`);
  await freelancer.submit('[data-workspace-form="apply"]', {
    proposedPrice: '11800.00', deliveryDays: '16',
    availability: 'Available immediately for 32 hours per week',
    approach: 'Start with executable acceptance tests, implement reconciliation invariants, and provide signed evidence for every milestone.',
    coverLetter: 'I build TypeScript settlement services and evidence-led approval systems for regulated cross-border workflows.',
  });
  await company.waitFor(`fetch('/api/workspace/state').then(response => response.json()).then(value => value.run?.screening?.status === 'COMPLETED')`, 'Screening did not complete.', 60_000);
  await company.waitFor('document.querySelectorAll("[data-select-application]").length === 3', 'Three selectable freelancer proposals did not render.', 15_000);
  const screenedState = await company.state();
  const signedInApplication = screenedState.run.results.applications.find(application => application.applicantUserId === 'USER-IN-FREELANCER');
  if (!signedInApplication) throw new Error('The authenticated Freelancer proposal is missing from screening.');
  const selected = await company.evaluate(`(() => {
    const button = document.querySelector('[data-select-application=${JSON.stringify(signedInApplication.id)}]');
    if (!(button instanceof HTMLElement)) return false;
    button.click(); return true;
  })()`);
  if (!selected) throw new Error('Company could not select the signed-in Freelancer proposal.');

  await company.waitFor('document.querySelector("[data-workspace-form=terms]") !== null', 'Company terms form did not render.', 15_000);
  await company.uploadFile('[data-extract-purpose="AGREEMENT_TERMS"]', agreementDraft);
  await company.waitFor('["success", "warning", "error"].includes(document.querySelector("[data-extraction-status]")?.dataset.tone)', 'Agreement terms extraction returned no final status.', 45_000);
  const agreementExtraction = await company.evaluate('({ tone: document.querySelector("[data-extraction-status]")?.dataset.tone, text: document.querySelector("[data-extraction-status]")?.textContent })');
  if (!["success", "warning"].includes(agreementExtraction.tone)) throw new Error(`Agreement terms were not extracted: ${JSON.stringify(agreementExtraction)}`);
  await sleep(3_600);
  const extractedCommercialTerms = await company.evaluate('document.querySelector("[data-workspace-form=terms] [name=commercialTerms]")?.value');
  if (!/complete milestone consideration/iu.test(extractedCommercialTerms)) throw new Error(`Commercial terms were not autofilled or retained: ${extractedCommercialTerms}`);
  await company.submit('[data-workspace-form="terms"]', {
    commercialTerms: 'The selected proposal price is the complete milestone consideration. One evidence-backed revision is included.',
    acceptanceCriteria: 'All automated tests pass. Fabric and Algorand references reconcile. The runbook and dashboard are delivered.',
    policies: 'Repository access follows least privilege. Confidential data remains private to the two contracting parties.',
    legalClauses: 'Pre-existing IP remains with its owner. Accepted deliverables transfer under the signed statement of work.',
  });
  await freelancer.waitFor('document.querySelector("[data-approve-agreement]") !== null', 'Private agreement did not reach the selected Freelancer.', 20_000);
  await freelancer.click('[data-approve-agreement]');
  await freelancer.waitFor(`fetch('/api/workspace/state').then(response => response.json()).then(value => value.run?.phase === 'AWAITING_DELIVERY')`, 'Policy, FX, compliance, and escrow automation did not finish.', 150_000);
  const funded = await freelancer.state();
  if (!funded.run?.results?.binding?.dealId || funded.run?.automation?.status !== 'COMPLETED') throw new Error('No confirmed Algorand escrow binding was returned.');

  await freelancer.waitFor('document.querySelector("[data-workspace-form=submit]") !== null', 'Deliverable form did not render.', 15_000);
  const documentNode = await freelancer.command('DOM.getDocument', { depth: -1, pierce: true });
  const fileNode = await freelancer.command('DOM.querySelector', { nodeId: documentNode.root.nodeId, selector: '[data-workspace-form="submit"] input[type="file"]' });
  if (!fileNode.nodeId) throw new Error('Freelancer file input was not found.');
  await freelancer.command('DOM.setFileInputFiles', { nodeId: fileNode.nodeId, files: [deliverable] });
  await freelancer.submit('[data-workspace-form="submit"]', {
    note: 'Complete reconciliation engine, automated test evidence, deployment notes, and reviewer walkthrough.',
  });
  await company.waitFor(`fetch('/api/workspace/state').then(response => response.json()).then(value => value.run?.phase === 'AWAITING_WORK_APPROVAL')`, 'Fabric submission and validation did not reach Company approval.', 90_000);
  await company.waitFor('document.querySelector("[data-approve-work]") !== null', 'Company approval control did not render.', 15_000);
  await company.click('[data-approve-work]');
  await company.waitFor('document.querySelector("[data-transfer-screen]") !== null', 'Post-approval money transfer screen did not render.', 15_000);
  const transferScene = await company.evaluate(`({
    company: document.querySelector('[data-transfer-screen] img[alt="Company representative"]') !== null,
    freelancer: document.querySelector('[data-transfer-screen] img[alt="Freelancer"]') !== null,
    packets: document.querySelectorAll('[data-transfer-screen] .transfer-lane i').length,
    text: document.querySelector('[data-transfer-screen]')?.innerText ?? ''
  })`);
  if (!transferScene.company || !transferScene.freelancer || transferScene.packets !== 9 || !/ALGORAND ESCROW/iu.test(transferScene.text)) {
    throw new Error(`Money transfer scene is incomplete: ${JSON.stringify(transferScene)}`);
  }
  await company.waitFor(`fetch('/api/workspace/state').then(response => response.json()).then(value => value.run?.phase === 'COMPLETED')`, 'Fabric-authorized Algorand release did not complete.', 150_000);

  await company.waitFor('document.querySelectorAll("#workspaceStages [data-state=done]").length === 5', 'Company journey rail did not complete.', 15_000);
  await freelancer.waitFor('document.querySelectorAll("#workspaceStages [data-state=done]").length === 6', 'Freelancer journey rail did not complete.', 15_000);
  await company.waitFor('document.querySelector(".payout-card")?.classList.contains("complete") === true', 'Company payout card did not render the completed release.', 15_000);
  await freelancer.waitFor('document.querySelector(".payout-card")?.classList.contains("complete") === true', 'Freelancer payout card did not render the completed release.', 15_000);
  const finalState = await company.state();
  if (!finalState.run?.results?.fabricDecisionTxId || !finalState.run?.results?.binding?.dealId) throw new Error('Final ledger proofs are incomplete.');
  await company.click('[data-inspect-stage="04"]');
  await company.waitFor('document.querySelector(".automation-workspace") !== null', 'Completed decision trace did not open.', 15_000);
  await company.click('[data-automation-focus="compliance"]');
  await company.waitFor('document.querySelector(".reasoning-card")?.textContent.includes("PASSED") === true', 'Compliance reasoning did not expose the persisted outcome.', 15_000);
  await company.click('[data-automation-focus="fx"]');
  await company.waitFor('document.querySelector(".reasoning-card")?.textContent.includes("FRANKFURTER") === true', 'FX reasoning did not expose the persisted rate source.', 15_000);
  await company.screenshot('/home/infinity/Documents/Codex/2026-09-03/cr/work/anchor-company-decision-trace.png');
  await company.click('[data-return-live]');
  await company.screenshot('/home/infinity/Documents/Codex/2026-09-03/cr/work/anchor-company-completed.png');
  await freelancer.screenshot('/home/infinity/Documents/Codex/2026-09-03/cr/work/anchor-freelancer-completed.png');

  process.stdout.write(`${JSON.stringify({
    status: 'passed',
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
