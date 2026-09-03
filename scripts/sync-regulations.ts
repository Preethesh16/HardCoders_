import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  explainRegulationRefresh,
  refreshOfficialRegulations,
} from '../apps/api/src/regulations/index.js';

async function main(): Promise<void> {
  const outputIndex = process.argv.indexOf('--output');
  const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
  if (outputIndex >= 0 && !output) throw new Error('--output requires a path.');

  const report = await refreshOfficialRegulations();
  const explanation = await explainRegulationRefresh(report);
  const payload = JSON.stringify({ report, explanation }, null, 2) + '\n';

  if (output) {
    const path = resolve(output);
    await writeFile(path, payload, { encoding: 'utf8', mode: 0o600 });
    process.stdout.write(`Regulation observation written to ${path}\n`);
  } else {
    process.stdout.write(payload);
  }

  if (report.requiresHumanReview) process.exitCode = 2;
}

void main();
