import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { MODEL_SDKS } from '../src/types.ts';
import bundledCatalogGzip from '../src/data/models-dev-api.ts';
import { modelProviderPresets } from '../src/agent/model-limits.ts';
import { analyzeSdkCoverage, sdkCoverageFailures } from './sdk-coverage.mjs';

it('keeps unsupported excluded routes visible and rejects every unsupported agent-eligible route', () => {
  const catalog = { provider: { npm: '@ai-sdk/openai-compatible', models: {
    video: { tool_call: false, modalities: { output: ['video'] }, provider: { npm: 'unsupported-video' } },
    videoWithTools: { tool_call: true, modalities: { output: ['video'] }, provider: { npm: 'unsupported-video' } },
    textWithoutTools: { modalities: { output: ['text'] }, provider: { npm: 'unsupported-text' } },
    chat: { tool_call: true, modalities: { output: ['text'] } },
    unspecifiedOutput: { tool_call: true },
  } }, overridden: { npm: 'unused-provider-sdk', models: {
    chat: { tool_call: true, provider: { npm: '@ai-sdk/openai-compatible' } },
  } } };
  const report = analyzeSdkCoverage(catalog, MODEL_SDKS);
  expect(sdkCoverageFailures(report)).toEqual([]);
  expect(report).toMatchObject({ coverageComplete: true, catalogCoverageComplete: false, agentModels: 3,
    missing: ['unsupported-text', 'unsupported-video', 'unused-provider-sdk'], missingAgentSdks: [],
    excludedOnlySdks: ['unsupported-text', 'unsupported-video', 'unused-provider-sdk'],
    unsupportedRoutes: [
      { modelId: 'textWithoutTools', eligible: false, exclusionReasons: ['tool-calling not advertised'] },
      { modelId: 'video', eligible: false, exclusionReasons: ['tool-calling not advertised', 'text output not advertised'] },
      { modelId: 'videoWithTools', eligible: false, exclusionReasons: ['text output not advertised'] },
    ],
  });
  expect(modelProviderPresets(catalog).find(preset => preset.id === 'provider').models.map(model => model.id)).toEqual(['chat', 'unspecifiedOutput']);
  for (const model of [
    { tool_call: true, modalities: { output: ['text'] } },
    { tool_call: true },
  ]) {
    for (const route of [
      { npm: 'future-sdk', models: { chat: model } },
      { npm: '@ai-sdk/openai-compatible', models: { chat: { ...model, provider: { npm: 'future-sdk' } } } },
    ]) {
      const failed = analyzeSdkCoverage({ future: route }, MODEL_SDKS);
      expect(failed).toMatchObject({ coverageComplete: false, missingAgentSdks: ['future-sdk'], excludedOnlySdks: [],
        unsupportedRoutes: [{ providerId: 'future', modelId: 'chat', sdk: 'future-sdk', eligible: true, exclusionReasons: [] }] });
      expect(sdkCoverageFailures(failed)).toEqual(['Unsupported agent-eligible Models.dev SDKs: future-sdk']);
    }
  }
  const gitlab = analyzeSdkCoverage({ gitlab: { npm: 'gitlab-ai-provider', models: {
    excluded: { tool_call: false }, eligible: { tool_call: true },
  } } }, MODEL_SDKS);
  expect(gitlab.gitlab).toMatchObject({ missingMetadata: ['eligible', 'excluded'], missingAgentMetadata: ['eligible'] });
  expect(sdkCoverageFailures(gitlab)).toEqual(['Agent-eligible GitLab Duo models missing Models.dev routing metadata: eligible']);
  const frozen = JSON.parse(gunzipSync(Buffer.from(bundledCatalogGzip, 'base64')).toString('utf8'));
  const frozenReport = analyzeSdkCoverage(frozen, MODEL_SDKS);
  expect(sdkCoverageFailures(frozenReport)).toEqual([]);
  expect(modelProviderPresets(frozen).reduce((count, preset) => count + preset.models.length, 0)).toBe(frozenReport.agentModels);
});
