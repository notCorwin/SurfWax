import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile, symlink, access, readdir, rm } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';

// Audit experiments never mutate the shared checkout or its running Vite server.
const root = resolve(import.meta.dirname, '..');
const stage = process.env.SURFWAX_AUDIT_STAGE;
if (stage && !/^[a-z0-9-]+$/.test(stage)) throw new Error('SURFWAX_AUDIT_STAGE must be a simple directory name.');
const directory = resolve(root, '.dev/test-audit', ...(stage ? [stage] : []));
const source = resolve(directory, 'source');
const hash = value => createHash('sha256').update(value).digest('hex');
const files = () => execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const writeJSON = async (path, value) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(value, null, 2) + '\n'); };

// Only generated outputs and the explicitly shared dependency tree are mutable.
const generatedSnapshotRoots = new Set(['.dev', 'node_modules', 'test-results', 'playwright-report']);
async function verifySnapshot(manifest) {
  const actual = [];
  async function visit(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!prefix && generatedSnapshotRoots.has(entry.name)) continue;
      const path = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Frozen source contains an unexpected symlink (${path}).`);
      if (entry.isDirectory()) await visit(resolve(directory, entry.name), path + '/');
      else if (entry.isFile()) actual.push(path);
      else throw new Error(`Frozen source contains an unexpected filesystem entry (${path}).`);
    }
  }
  await visit(source);
  const expected = new Set(manifest.files.map(entry => entry.path));
  const actualSet = new Set(actual);
  const added = actual.filter(path => !expected.has(path));
  const missing = [...expected].filter(path => !actualSet.has(path));
  if (added.length || missing.length) throw new Error(`Frozen source file set changed; refuse a contaminated experiment: ${JSON.stringify({ added, missing })}`);
  for (const entry of manifest.files) {
    if (hash(await readFile(resolve(source, entry.path))) !== entry.sha256) throw new Error(`Frozen source changed (${entry.path}); refuse to run a contaminated experiment.`);
  }
}

async function inventory() {
  const workflow = await readFile(resolve(root, '.github/workflows/capability-tests.yml'), 'utf8');
  const browser = workflow.slice(workflow.indexOf('node scripts/run-browser-tests.mjs e2e'));
  const ciPaths = [...browser.matchAll(/\be2e\/[\w/.-]+\.spec\.ts/g)].map(match => match[0]);
  const ciGrep = browser.match(/--grep '([^']+)'/)?.[1];
  const unitCommand = workflow.slice(workflow.indexOf('npm test --'), workflow.indexOf('--reporter=default --reporter=junit'));
  const unitSelectors = [...unitCommand.matchAll(/\bsrc\/[\w/.-]+/g)].map(match => match[0]);
  const rows = [];
  for (const path of files().filter(path => /(?:\.test\.[cm]?[jt]sx?|\.spec\.ts)$/.test(path))) {
    const text = await readFile(resolve(root, path), 'utf8');
    const signals = {
      scriptedProvider: /startProvider\(|commandResponse\(/.test(text),
      mockModules: /vi\.mock\(/.test(text), mockFunctions: /vi\.fn\(|MockLanguageModel|mock(?:ResolvedValue|Implementation)/.test(text),
      mockChrome: /stubGlobal\(["']chrome|globalThis\.chrome\s*=/.test(text),
      directStorage: /chrome\.storage.*\.set\(|indexedDB\.open\(/.test(text),
      realModelOptIn: /SURFWAX_REAL_MODEL_EVAL/.test(text),
      conditionalSkip: /test\.skip\(/.test(text),
      toleratesSnapshotFailure: /observed\?\.ok === false|if \(.*snapshot.*unavailable/i.test(text),
      independentPageRead: /target\.locator\(|target\.evaluate\(|fixture\.evidence\(|businessVerified/.test(text),
      nativePanel: /nativePanel\(|openNativeSidePanel\(|Extensions\.triggerAction/.test(text),
    };
    rows.push({ path, sha256: hash(text), lines: text.split('\n').length, environment: path.startsWith('e2e/') ? 'Chrome or fixture; inspect imports' : /@vitest-environment node/.test(text) ? 'node' : 'jsdom (default)',
      ciBrowserPathSelected: path.startsWith('e2e/') ? ciPaths.includes(path) : null,
      ciUnitSelected: path.startsWith('src/') ? unitSelectors.some(selector => path === selector || path.startsWith(`${selector}/`)) : null,
      signals, dependencies: [...text.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map(match => match[1]),
      assertionLines: text.split('\n').flatMap((line, index) => /\bexpect\b|\bassert\./.test(line) ? [{ line: index + 1, text: line.trim() }] : []),
      declarations: [...text.matchAll(/\b(?:test|it)\s*\(\s*(["'`])([^\n]*?)\1/g)].map(match => ({ title: match[2], line: text.slice(0, match.index).split('\n').length })) });
  }
  await writeJSON(resolve(directory, 'inventory.json'), { generatedAt: new Date().toISOString(), gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    caveat: 'Signals are search aids, not a verdict on assertion quality. CI title filtering requires Playwright collection.', ciPaths, ciGrep, unitSelectors, files: rows });
  process.stdout.write(JSON.stringify({ files: rows.length, e2eFiles: rows.filter(row => row.path.startsWith('e2e/')).length, ciBrowserPaths: ciPaths.length, output: resolve(directory, 'inventory.json') }) + '\n');
}

async function collect(project = root) {
  project = resolve(project);
  const workflow = await readFile(resolve(project, '.github/workflows/capability-tests.yml'), 'utf8');
  const browser = workflow.slice(workflow.indexOf('node scripts/run-browser-tests.mjs e2e'));
  const ciPaths = [...browser.matchAll(/\be2e\/[\w/.-]+\.spec\.ts/g)].map(match => match[0]);
  const grep = browser.match(/--grep '([^']+)'/)?.[1];
  if (!ciPaths.length || !grep) throw new Error('Cannot find the CI browser selection. Update the audit collector for the new workflow.');
  const rows = new Map();
  const receipts = new Map();
  const projectName = browser.match(/--project=([^\s]+)/)?.[1];
  if (!projectName) throw new Error('Cannot find the CI project selection.');
  for (const [name, args] of [['all', []], ['ci', [...ciPaths, '--grep', grep, '--grep-invert', '@performance', `--project=${projectName}`]], ['user-journey', ['--grep', '@user-journey', `--project=${projectName}`]]]) {
    const result = JSON.parse(execFileSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--list', '--reporter=json', ...args], { cwd: project, encoding: 'utf8', maxBuffer: 20_000_000 }));
    const walk = (suites, parents = []) => suites.flatMap(suite => [...(suite.specs ?? []).map(spec => ({ file: suite.file, testTitle: spec.title, title: [...parents, suite.title, spec.title].filter(Boolean).join(' > '),
      annotations: spec.tests.flatMap(test => test.annotations ?? []) })), ...walk(suite.suites ?? [], [...parents, suite.title].filter(Boolean))]);
    if (result.errors?.length) throw new Error(`Collection failed: ${JSON.stringify(result.errors)}`);
    const tests = walk(result.suites);
    if (!tests.length) throw new Error(`The ${name} selection is empty; this is not a passing gate.`);
    rows.set(name, tests);
    receipts.set(name, { generatedAt: new Date().toISOString(), project, workflowSha256: hash(workflow), args, rows: tests });
  }
  const key = row => JSON.stringify([row.file, row.testTitle ?? row.title]);
  const requiredText = await readFile(resolve(project, 'scripts/required-user-journeys.json'), 'utf8');
  const required = JSON.parse(requiredText);
  if (!Array.isArray(required) || !required.length || required.some(row => typeof row.file !== 'string' || typeof row.title !== 'string') || new Set(required.map(key)).size !== required.length)
    throw new Error('The independent required user journey list must contain unique file/title pairs.');
  const requiredKeys = new Set(required.map(key));
  const taggedKeys = new Set(rows.get('user-journey').map(key));
  const untagged = required.filter(row => !taggedKeys.has(key(row)));
  const unlisted = rows.get('user-journey').filter(row => !requiredKeys.has(key(row)));
  if (untagged.length || unlisted.length) throw new Error(`Required user journey declarations changed: ${JSON.stringify({ untagged, unlisted })}`);
  const ci = new Set(rows.get('ci').map(key));
  const missing = required.filter(row => !ci.has(key(row)));
  if (missing.length) throw new Error(`User journeys excluded from CI: ${JSON.stringify(missing)}`);
  const skipped = rows.get('all').filter(row => requiredKeys.has(key(row)) && row.annotations.some(annotation => annotation.type === 'skip' || annotation.type === 'fixme'));
  if (skipped.length) throw new Error(`Required user journeys are statically skipped: ${JSON.stringify(skipped)}`);
  // A failed probe must not overwrite the last validated CI collection.
  const output = project === root ? directory : resolve(directory, 'collection-probes', hash(project).slice(0, 12));
  for (const name of ['all', 'ci', 'user-journey']) await writeJSON(resolve(output, `collection-${name}.json`), { ...receipts.get(name), requiredJourneysSha256: hash(requiredText) });
  console.log(JSON.stringify({ all: rows.get('all').length, ci: ci.size, userJourneys: rows.get('user-journey').length, missing }));
}

async function summarize() {
  const experiments = resolve(directory, 'experiments');
  const reports = [];
  for (const name of await readdir(experiments)) {
    const receipt = JSON.parse(await readFile(resolve(experiments, name, 'receipt.json'), 'utf8'));
    const cases = [];
    for (const baseline of receipt.receipts.filter(item => item.mode === 'baseline')) {
      const mutant = receipt.receipts.find(item => item.mode === 'mutant' && item.case === baseline.case);
      let verdict = baseline.code !== 0 || !baseline.stats.expected ? 'invalid-baseline' : !mutant ? 'incomplete'
        : mutant.code === 0 && mutant.stats.expected ? baseline.case === 'screenshot-fallback' ? 'expected-independent-recovery' : 'survived'
          : mutant.stats.unexpected ? 'failed-under-mutation' : 'inconclusive';
      const raw = mutant ? JSON.parse(await readFile(mutant.results, 'utf8')) : null;
      const errors = [];
      const observations = [];
      const visit = suites => { for (const suite of suites ?? []) { for (const spec of suite.specs ?? []) for (const test of spec.tests ?? []) for (const result of test.results ?? []) {
        errors.push(...(result.errors ?? []).map(error => error.message));
        for (const attachment of result.attachments ?? []) if (attachment.name === 'dynamic-observation' && attachment.body)
          observations.push(JSON.parse(Buffer.from(attachment.body, 'base64').toString('utf8')));
      } visit(suite.suites); } };
      visit(raw?.suites);
      if (baseline.case === 'dynamic-geometry' && verdict === 'survived') {
        verdict = observations.some(value => value.observed?.limitations?.startsWith('Read-only')) ? 'expected-readonly-recovery' : 'survived-branch-unobserved';
      }
      if (raw?.testResults) errors.push(...raw.testResults.flatMap(suite => suite.assertionResults.flatMap(result => result.failureMessages)));
      cases.push({ case: baseline.case, verdict, baseline: { code: baseline.code, stats: baseline.stats }, mutant: mutant ? { code: mutant.code, stats: mutant.stats } : null,
        errors: errors.map(message => message.replace(/\x1b\[[0-9;]*m/g, '').slice(0, 2400)), observations });
    }
    reports.push({ run: name, mutation: receipt.id, file: receipt.file, originalSha256: receipt.originalSha256, mutantSha256: receipt.mutantSha256, cases });
  }
  await writeJSON(resolve(directory, 'mutation-summary.json'), { note: 'failed-under-mutation requires manual error review; setup failures and timeouts are not automatically counted as caught product defects.', reports });
  console.log(JSON.stringify(reports.map(report => ({ run: report.run, cases: report.cases.map(item => ({ case: item.case, verdict: item.verdict })) })), null, 2));
}

async function snapshot() {
  try { await access(resolve(directory, 'snapshot.json')); throw new Error('Snapshot already exists. Reuse it, or archive .dev/test-audit before taking a new baseline.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const entries = [];
  for (const path of files()) {
    if (!/^(src\/|e2e\/|scripts\/|manifests\/|public\/|\.github\/|[^/]+\.(?:json|html|ts|mjs))/.test(path)) continue;
    const data = await readFile(resolve(root, path));
    await mkdir(dirname(resolve(source, path)), { recursive: true });
    await cp(resolve(root, path), resolve(source, path));
    entries.push({ path, sha256: hash(data) });
  }
  await symlink(resolve(root, 'node_modules'), resolve(source, 'node_modules'), 'dir');
  await writeJSON(resolve(directory, 'snapshot.json'), { createdAt: new Date().toISOString(), head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), files: entries });
  console.log(`Frozen ${entries.length} files in ${source}; dependencies reused; Vite cache and Chrome profiles are independent.`);
}

const experiments = {
  'click-noop': {
    file: 'src/chrome/automation.ts',
    anchor: 'private async nativeClick(debuggee: Debuggee, params: Record<string, unknown>) {',
    injection: '\n    return {}; // audit mutant: acknowledge a valid click without dispatching input\n',
    cases: [
      { id: 'page-independent', spec: 'e2e/page-independent-tools.spec.ts', grep: 'runs page-independent tools' },
      { id: 'actual-order-control', spec: 'e2e/complex-task-evaluation.spec.ts', grep: 'scripted complex task: cross-frame order recovery \\(seed 17\\)$' },
    ],
  },
  'snapshot-unavailable': {
    file: 'src/chrome/automation.ts',
    anchor: /  private async captureSnapshot\(session: Session, region\?: LocatorSpec\): Promise<[^\n]+\{\n/,
    injection: '    throw automationError("snapshot-unavailable", { reason: "dom-unstable", auditMutant: true });\n',
    cases: [
      { id: 'dynamic-geometry', spec: 'e2e/snapshot-dynamic-dom.spec.ts', grep: 'handles dynamic geometry without exposing stale evidence$' },
      { id: 'visible-market-control', spec: 'e2e/live-market-regression.spec.ts', grep: 'captures a page with hidden layoutless and zero-sized iframe documents$' },
    ],
  },
  'review-accept': {
    file: 'src/agent/goal-review.ts',
    anchor: '    return verdict;', replace: '    return { accept: true, reason: "audit mutant bypasses rejection", remaining: [] };',
    cases: [
      { id: 'goal-mode', spec: 'e2e/goal-mode.spec.ts', grep: 'goal mode recovers after progress text' },
      { id: 'runner-rejection-control', spec: 'src/agent/goal-review-runner.test.ts', kind: 'unit', grep: 'reviews a self-declared answer' },
    ],
  },
  'script-restore-noop': {
    file: 'src/userscripts/persistence.ts',
    anchor: 'export async function restoreUserScripts(options: { chromeApi?: UserScriptsChrome; logger?: EventLogger } = {}): Promise<boolean> {',
    injection: '\n  return false; // audit mutant: saved declarations are never restored\n',
    cases: [
      { id: 'scripts-after-restart', spec: 'e2e/userscripts.spec.ts', grep: 'restores saved user scripts after the MV3 worker restarts' },
    ],
  },
};

async function command(args, log, env = {}) {
  await mkdir(dirname(log), { recursive: true });
  const { createWriteStream } = await import('node:fs');
  const output = createWriteStream(log);
  return await new Promise((accept, reject) => {
    const child = spawn(process.execPath, args, { cwd: source, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(output, { end: false }); child.stderr.pipe(output, { end: false });
    child.once('error', reject);
    child.once('exit', (code, signal) => output.end(() => accept({ code, signal })));
  });
}

async function experiment(id, caseId) {
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Use Node 24 for audit experiments.');
  const mutant = experiments[id];
  if (!mutant) throw new Error(`Choose ${Object.keys(experiments).join(', ')}`);
  try { await access(resolve(directory, 'snapshot.json')); }
  catch (cause) { throw new Error('No frozen source for this stage. Run snapshot with the same SURFWAX_AUDIT_STAGE before experimenting.', { cause }); }
  const lock = resolve(directory, 'experiment.lock');
  try { await mkdir(lock); } catch (cause) {
    throw new Error(cause.code === 'EEXIST' ? 'This audit stage is locked. Finish its active experiment before starting another; inspect a leftover lock after an interrupted process.' : `Cannot lock the audit stage at ${directory}. Check its filesystem permissions.`, { cause });
  }
  let original;
  const path = resolve(source, mutant.file);
  try {
  const manifest = JSON.parse(await readFile(resolve(directory, 'snapshot.json'), 'utf8'));
  await verifySnapshot(manifest);
  original = await readFile(path, 'utf8');
  const anchor = mutant.anchor instanceof RegExp ? original.match(mutant.anchor)?.[0] : mutant.anchor;
  if (!anchor || original.split(anchor).length !== 2) throw new Error('Mutation anchor must match exactly once.');
  const changed = original.replace(anchor, mutant.replace ?? anchor + mutant.injection);
  const run = resolve(directory, 'experiments', `${Date.now()}-${id}`);
  let cases = [...mutant.cases];
  if (id === 'review-accept' && manifest.files.some(entry => entry.path === 'e2e/completion-review-boundary.spec.ts'))
    cases.push({ id: 'completion-boundary', spec: 'e2e/completion-review-boundary.spec.ts', grep: 'completion review rejection keeps the task open' });
  if (id === 'snapshot-unavailable' && manifest.files.some(entry => entry.path === 'e2e/screenshot-dynamic.spec.ts'))
    cases.push({ id: 'screenshot-fallback', spec: 'e2e/screenshot-dynamic.spec.ts', grep: 'captures viewport pixels independently of changing semantic content' });
  if (caseId) cases = cases.filter(item => item.id === caseId);
  if (!cases.length) throw new Error('The requested experiment case is not present in this frozen source.');
  const receipts = [];
  try {
    for (const mode of ['baseline', 'mutant']) {
      await writeFile(path, mode === 'baseline' ? original : changed);
      for (const item of cases) {
        const log = resolve(run, `${mode}-${item.id}.log`), results = resolve(run, `${mode}-${item.id}.json`);
        const args = item.kind === 'unit'
          ? ['node_modules/vitest/vitest.mjs', 'run', item.spec, '-t', item.grep, '--reporter=default', '--reporter=json', `--outputFile.json=${results}`]
          : ['scripts/run-browser-tests.mjs', 'e2e', item.spec, '--grep', item.grep, '--retries=0', '--reporter=list,json'];
        console.log(`${id} ${mode} ${item.id}`);
        const started = Date.now();
        const result = await command(args, log, { PLAYWRIGHT_JSON_OUTPUT_FILE: results });
        const collected = JSON.parse(await readFile(results, 'utf8'));
        const stats = item.kind === 'unit' ? { expected: collected.numPassedTests, unexpected: collected.numFailedTests, skipped: collected.numPendingTests } : collected.stats;
        receipts.push({ mode, case: item.id, args, ...result, durationMs: Date.now() - started, stats, log, results });
        await writeJSON(resolve(run, 'receipt.json'), { id, file: mutant.file, originalSha256: hash(original), mutantSha256: hash(changed), receipts });
        if (stats.expected + stats.unexpected === 0) throw new Error(`No executed tests: ${log}. This is not mutation evidence.`);
        const artifactPath = collected.config?.projects[0]?.outputDir;
        if (artifactPath) await cp(dirname(artifactPath), resolve(run, `${mode}-${item.id}-evidence`), { recursive: true });
      }
    }
  } finally { await writeFile(path, original); }
  console.log(JSON.stringify({ run, receipts }, null, 2));
  } finally { await rm(lock, { recursive: true }); }
}

const [action, id, caseId] = process.argv.slice(2);
if (action === 'inventory') await inventory();
else if (action === 'collect') await collect(id);
else if (action === 'summarize') await summarize();
else if (action === 'verify-snapshot') {
  await verifySnapshot(JSON.parse(await readFile(resolve(directory, 'snapshot.json'), 'utf8')));
  console.log('Frozen source file set and contents match the manifest.');
}
else if (action === 'snapshot') await snapshot();
else if (action === 'experiment') await experiment(id, caseId);
else throw new Error('Usage: node scripts/audit-tests.mjs inventory|collect [project]|snapshot|verify-snapshot|experiment <id> [case]|summarize');
