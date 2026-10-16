import { generateReport } from '../qa/summary.mjs';
import { appendFileSync } from 'node:fs';
const { summary, markdown } = generateReport();
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
console.log(markdown.split('\n').slice(0, 14).join('\n'));
if (process.argv.includes('--gate') && summary.overall !== 'passed') process.exitCode = 1;
