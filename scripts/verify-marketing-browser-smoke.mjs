import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const chrome = process.argv[2];
if (!chrome) throw new Error('usage: node scripts/verify-marketing-browser-smoke.mjs <chrome-binary>');

const origin = new URL(process.env.OPTIWORK_MARKETING_URL ?? 'http://127.0.0.1:4175');
const profile = await mkdtemp(join(tmpdir(), 'anchor-marketing-browser-smoke-'));
const processHandle = spawn(chrome, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-background-networking',
  '--disable-component-update', '--disable-default-apps', '--disable-extensions', '--disable-sync',
  '--metrics-recording-only', '--no-first-run', '--remote-debugging-address=127.0.0.1',
  '--remote-debugging-port=0', '--window-size=1600,1000', `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function debuggingPort() {
  const path = join(profile, 'DevToolsActivePort');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (processHandle.exitCode !== null) throw new Error(`Chrome exited with ${processHandle.exitCode}.`);
    try {
      const [port] = (await readFile(path, 'utf8')).trim().split('\n');
      if (/^[1-9][0-9]*$/u.test(port ?? '')) return Number(port);
    } catch {
      // Chrome writes this file when its DevTools endpoint is ready.
    }
    await sleep(50);
  }
  throw new Error('Chrome did not expose a DevTools endpoint.');
}

let socket;
try {
  const port = await debuggingPort();
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
  const target = targets.find((candidate) => candidate.type === 'page');
  if (typeof target?.webSocketDebuggerUrl !== 'string') throw new Error('Chrome exposed no page target.');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('Chrome DevTools connection failed.')), { once: true });
  });

  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
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
  const evaluate = async (expression) => {
    const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(`Browser evaluation failed: ${result.exceptionDetails.text}`);
    return result.result?.value;
  };
  const waitFor = async (expression, message, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await evaluate(expression)) return;
      await sleep(150);
    }
    throw new Error(message);
  };
  const click = async (selector) => {
    const clicked = await evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!(element instanceof HTMLElement)) return false; element.click(); return true; })()`);
    if (!clicked) throw new Error(`Could not click ${selector}.`);
  };
  const api = async (path, body = {}) => {
    const result = await evaluate(`(async () => { const response = await fetch(${JSON.stringify(path)}, { method: 'POST', headers: { 'content-type': 'application/json', 'x-anchor-role': ${JSON.stringify(path === '/api/workflow/reset' ? 'COMPANY' : 'TEST')} }, body: JSON.stringify(${JSON.stringify(body)}) }); return { status: response.status, body: await response.json().catch(() => ({})) }; })()`);
    if (result.status !== 200) throw new Error(`${path} failed: ${JSON.stringify(result)}`);
    return result.body;
  };
  const state = () => evaluate(`fetch('/api/workspace/state').then(response => response.json())`);

  await command('Page.enable');
  await command('Runtime.enable');
  const url = new URL('/', origin).href;
  const navigation = await command('Page.navigate', { url });
  if (navigation.errorText) throw new Error(`Navigation failed: ${navigation.errorText}`);
  await waitFor(`location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`, 'The product experience did not load.');
  const landing = await evaluate('({ title: document.title, text: document.body?.innerText ?? "" })');
  if (!/Anchor/u.test(landing?.title ?? '') || !/WORK WITHOUT\s+BORDERS/iu.test(landing?.text ?? '')) throw new Error('The landing page did not render.');

  await click('[data-open-demo]');
  await waitFor('document.querySelector("#demoModal")?.classList.contains("open")', 'Role selection did not open.');
  await click('#continueRole');
  await waitFor('document.querySelector("#loginWorld")?.classList.contains("open")', 'Demo login did not open.');
  await click('#loginForm .login-submit');
  await waitFor('document.querySelector("#portalWorld")?.classList.contains("open")', 'The portal did not open.', 10_000);
  await api('/api/workflow/reset');
  await evaluate('window.OptiWorkWorkflow.init()');
  await waitFor('document.querySelector("[data-workspace-form=job]") !== null', 'The empty company brief did not render.');
  const blankBrief = await evaluate(`Array.from(document.querySelectorAll('[data-workspace-form="job"] input:not([type="hidden"]), [data-workspace-form="job"] textarea')).every(element => element.value === '')`);
  if (!blankBrief) throw new Error('The company brief contains prefilled values.');

  await evaluate('window.OptiWorkWorkflow.setRole("FREELANCER")');
  const freelancerBeforeJob = await evaluate(`({ text: document.querySelector('#workspaceAction')?.innerText ?? '', companyForm: document.querySelector('[data-workspace-form="job"]') !== null })`);
  if (freelancerBeforeJob.companyForm || /POST A JOB|PUBLISH OPPORTUNITY/iu.test(freelancerBeforeJob.text)) throw new Error('The freelancer portal leaked company controls.');
  await evaluate('window.OptiWorkWorkflow.setRole("COMPANY")');

  await api('/api/workflow/action/job', {
    title: 'Build a cross-border settlement reconciliation service',
    description: 'Deliver an auditable TypeScript service, tests, operating guide, and reconciliation dashboard for the Poland to India corridor.',
    acceptanceCriteria: 'All integration tests pass\nBoth ledger references reconcile\nNo PII appears on public ledgers',
    skills: ['typescript', 'postgresql', 'fabric', 'algorand'], deliveryDate: '2026-10-31', destinationCountry: 'IN',
    budget: { amountMinor: '1200000', currency: 'PLN', scale: 2 },
  });
  await evaluate('window.OptiWorkWorkflow.setRole("FREELANCER")');
  await evaluate('window.OptiWorkWorkflow.init()');
  await waitFor('document.querySelector("[data-workspace-form=apply]") !== null', 'The freelancer proposal form did not render.');
  const freelancerAfterJob = await evaluate(`document.querySelector('#workspaceAction')?.innerText ?? ''`);
  if (/POST A JOB/iu.test(freelancerAfterJob) || !/SUBMIT PROPOSAL/iu.test(freelancerAfterJob)) throw new Error('The opportunity UI is not role-specific.');
  await api('/api/workflow/action/apply', {
    coverLetter: 'I have delivered TypeScript settlement services and evidence-led approval systems for regulated workflows.',
    approach: 'Start with acceptance tests, implement reconciliation invariants, then deliver the dashboard and operating evidence.',
    availability: 'Available immediately for 32 hours per week', deliveryDays: 16,
    proposedPrice: { amountMinor: '1180000', currency: 'PLN', scale: 2 },
  });
  await waitFor(`fetch('/api/workspace/state').then(value => value.json()).then(value => value.run?.screening?.status === 'COMPLETED')`, 'Automatic multi-applicant screening did not complete.', 60_000);
  const screened = await state();
  if (screened.run.results.applications.length !== 3) throw new Error('Expected three independent freelancer proposals.');
  await api('/api/workflow/action/select', { applicationId: screened.run.results.applications[0].id });
  await api('/api/workflow/action/terms', {
    commercialTerms: ['The selected proposal price is the complete milestone consideration.', 'One evidence-backed revision is included.'],
    acceptanceCriteria: ['All automated tests pass.', 'The reconciliation runbook and dashboard are delivered.'],
    policies: ['Repository access follows least privilege.', 'Confidential information remains private to both parties.'],
    legalClauses: ['Pre-existing IP remains with its original owner.', 'Accepted deliverables transfer under the signed statement of work.'],
  });
  const agreementProof = await evaluate(`(async () => { const current = await fetch('/api/workspace/state').then(response => response.json()); const expected = current.run.results.agreement.artifactHash; const checks = []; for (const role of ['company', 'freelancer']) { const response = await fetch('/api/workflow/agreement/download?role=' + role); const bytes = await response.arrayBuffer(); const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(value => value.toString(16).padStart(2, '0')).join(''); checks.push({ role, status: response.status, matches: expected === 'sha256:' + digest }); } return checks; })()`);
  if (agreementProof.some((item) => item.status !== 200 || !item.matches)) throw new Error(`Private agreement verification failed: ${JSON.stringify(agreementProof)}`);
  await api('/api/workflow/action/agreement-approve');
  await waitFor(`fetch('/api/workspace/state').then(value => value.json()).then(value => value.run?.phase === 'AWAITING_DELIVERY')`, 'Rules, FX, compliance, and escrow automation did not complete.', 120_000);
  const funded = await state();
  if (funded.run.automation.status !== 'COMPLETED' || !funded.run.results.binding?.dealId) throw new Error('No confirmed Algorand binding was returned.');

  await api('/api/workflow/action/submit', {
    fileName: 'reconciliation-proof.anchorbin', contentType: 'application/x-anchor-proof',
    contentBase64: 'AAH6+/z/', note: 'Binary reconciliation proof and test evidence for the accepted milestone.',
  });
  await waitFor(`fetch('/api/workspace/state').then(value => value.json()).then(value => value.run?.phase === 'AWAITING_WORK_APPROVAL')`, 'Fabric commitment and advisory validation did not complete.', 60_000);
  const deliverableProof = await evaluate(`(async () => { const response = await fetch('/api/workflow/submission/download'); const bytes = Array.from(new Uint8Array(await response.arrayBuffer())); return { status: response.status, contentType: response.headers.get('content-type'), bytes }; })()`);
  if (deliverableProof.status !== 200 || deliverableProof.contentType !== 'application/x-anchor-proof' || deliverableProof.bytes.join(',') !== '0,1,250,251,252,255') throw new Error(`Deliverable round-trip failed: ${JSON.stringify(deliverableProof)}`);
  await api('/api/workflow/action/approve-work', { decision: 'APPROVED', comment: 'Verified against every accepted criterion.' });
  await waitFor(`fetch('/api/workspace/state').then(value => value.json()).then(value => value.run?.phase === 'COMPLETED')`, 'Fabric-authorized Algorand release did not complete.', 120_000);

  await evaluate('window.OptiWorkWorkflow.setRole("COMPANY")');
  await evaluate('window.OptiWorkWorkflow.init()');
  await waitFor('document.querySelectorAll("#workspaceStages [data-state=done]").length === 5', 'The company journey rail did not complete.');
  const companyResult = await evaluate(`({ text: document.querySelector('#workspaceAction')?.innerText ?? '', snapshot: document.querySelector('#workspaceSnapshot')?.innerText ?? '' })`);
  if (!/COMPLETED/iu.test(companyResult.text) || !/ARC-4 APP/u.test(companyResult.snapshot) || !/FABRIC EVIDENCE/u.test(companyResult.snapshot)) throw new Error(`Company proof is incomplete: ${JSON.stringify(companyResult)}`);
  await evaluate('window.OptiWorkWorkflow.setRole("FREELANCER")');
  await waitFor('document.querySelectorAll("#workspaceStages [data-state=done]").length === 6', 'The freelancer journey rail did not complete.');
  const finalFreelancerText = await evaluate(`document.querySelector('#workspaceAction')?.innerText ?? ''`);
  if (/POST A JOB/iu.test(finalFreelancerText) || !/COMPLETED/iu.test(finalFreelancerText)) throw new Error('The completed freelancer portal is not differentiated.');

  if (process.env.OPTIWORK_SCREENSHOT_PATH) {
    const captured = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(process.env.OPTIWORK_SCREENSHOT_PATH, Buffer.from(captured.data, 'base64'));
  }
  process.stdout.write(`${JSON.stringify({ status: 'passed', origin: origin.href, humanActions: 7, proposals: 3, roleViews: ['company', 'freelancer'], privateAgreementHashesVerified: 2, arbitraryDeliverableVerified: true, finalPhase: 'COMPLETED' }, null, 2)}\n`);
} finally {
  socket?.close();
  processHandle.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => processHandle.once('exit', resolve)), sleep(2_000)]);
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
