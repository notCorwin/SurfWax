import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { analyzeSdkCoverage, sdkCoverageFailures } from '../sdk-coverage.mjs';

const bedrock = '@ai-sdk/amazon-bedrock';
const mantle = '@ai-sdk/amazon-bedrock/mantle';
const gitlab = 'gitlab-ai-provider';
const provider = (npm, models = {}) => ({ npm, models });
const analyze = (catalog, supported = [bedrock, mantle, gitlab]) => analyzeSdkCoverage(catalog, supported);

test('includes model-level SDK overrides in the full SDK union', () => {
  const report = analyze({ aws: provider(bedrock, {
    converse: { id: 'converse' },
    mantle: { id: 'openai.gpt-6.1-sol', provider: { npm: mantle,
      api: 'https://bedrock-mantle.${AWS_REGION}.api.aws/openai/v1', shape: 'responses' } },
  }) }, [bedrock]);
  assert.deepEqual(report.providerSdks, [bedrock]);
  assert.deepEqual(report.modelOverrideSdks, [mantle]);
  assert.deepEqual(report.catalogSdks, [bedrock, mantle]);
  assert.deepEqual(report.missing, [mantle]);
  assert.equal(report.models, 2);
  assert.equal(report.coverageComplete, false);
  assert.match(sdkCoverageFailures(report)[0], /Unsupported Models.dev SDKs/);
  assert.equal(report.modelOverrides[0].shape, 'responses');
});

test('retains provider SDKs even when every model overrides the SDK', () => {
  const report = analyze({ aws: provider(bedrock, { only: { provider: { npm: mantle } } }) }, [mantle]);
  assert.deepEqual(report.missing, [bedrock]);
});

test('deduplicates SDK names and handles providers with no models', () => {
  const report = analyze({ one: provider(bedrock, { a: { provider: { npm: bedrock } } }), two: provider(bedrock) });
  assert.deepEqual(report.catalogSdks, [bedrock]);
  assert.equal(report.providers, 2);
  assert.equal(report.coverageComplete, true);
});

test('records override routing without dumping request body or header values', () => {
  const report = analyze({ aws: provider(bedrock, { a: { provider: {
    api: 'https://example.com', shape: 'responses', body: { service_tier: 'priority' },
    headers: { 'x-test': 'private-value' },
  } } }) });
  assert.deepEqual(report.modelOverrides[0], { providerId: 'aws', modelId: 'a', sdk: bedrock,
    api: 'https://example.com', shape: 'responses', bodyKeys: ['service_tier'], headerNames: ['x-test'] });
  assert.equal(JSON.stringify(report).includes('private-value'), false);
});

test('requires GitLab routing metadata from Models.dev', () => {
  const report = analyze({ gitlab: provider(gitlab, { 'duo-chat-new': {} }) });
  assert.deepEqual(report.gitlab.missingMetadata, ['duo-chat-new']);
  assert.equal(report.coverageComplete, false);
  assert.match(sdkCoverageFailures(report)[0], /missing Models.dev routing metadata/);
});

test('checks effective model SDKs and model IDs rather than object keys', () => {
  const report = analyze({ relay: provider(bedrock, {
    displayKey: { id: 'duo-chat-new', family: 'gpt', provider: { npm: gitlab } },
  }), gitlab: provider(gitlab, { bypass: { provider: { npm: mantle } } }) });
  assert.deepEqual(report.gitlab.catalogModelIds, ['duo-chat-new']);
});

test('accepts Models.dev family or canonical model identifiers for GitLab', () => {
  const report = analyze({ gitlab: provider(gitlab, {
    alias: { family: 'claude-sonnet' }, canonical: { canonical_model_id: 'openai/gpt-6-sol' },
  }) });
  assert.deepEqual(report.gitlab.missingMetadata, []);
  assert.equal(report.coverageComplete, true);
});

test('fails closed for empty or malformed catalogs instead of reporting zero-SDK success', () => {
  for (const catalog of [null, [], {}, { broken: null }, { broken: { npm: bedrock } },
    { broken: provider(bedrock, { model: null }) },
    { broken: provider(bedrock, { model: { provider: { npm: '' } } }) }]) {
    assert.throws(() => analyze(catalog));
  }
});

test('CLI writes failure evidence and never labels a local snapshot live', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'surfwax-sdk-coverage-'));
  try {
    const catalogPath = join(directory, 'catalog.json');
    await writeFile(catalogPath, JSON.stringify({ gitlab: provider(gitlab, { 'duo-chat-new': {} }) }));
    const scriptPath = fileURLToPath(new URL('../check-sdk-coverage.mjs', import.meta.url));
    const run = spawnSync(process.execPath, [scriptPath, '--catalog', catalogPath], { cwd: directory, encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /missing Models.dev routing metadata/);
    const report = JSON.parse(await readFile(join(directory, '.dev/verification/sdk-coverage.json'), 'utf8'));
    assert.equal(report.sourceKind, 'snapshot');
    assert.equal(report.coverageComplete, false);
    assert.match(report.limitations, /Does not prove protocol/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
