import { isAgentEligibleModel } from '../src/types.ts';

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isName = value => typeof value === 'string' && value.trim().length > 0;
const sortedUnique = values => [...new Set(values)].sort();

/** Inventory all SDK names; gate names and aliases only for agent-eligible routes. */
export function analyzeSdkCoverage(catalog, supportedSdks) {
  if (!isRecord(catalog) || !Object.keys(catalog).length) {
    throw new Error('Models.dev catalog must be a non-empty provider object');
  }
  if (!Array.isArray(supportedSdks) || !supportedSdks.length || !supportedSdks.every(isName)) {
    throw new Error('SDK registry must be a non-empty array of SDK names');
  }

  const providerSdks = [];
  const modelOverrideSdks = [];
  const modelOverrides = [];
  const gitlabModels = [];
  const agentSdks = [];
  const unsupportedRoutes = [];
  const supported = sortedUnique(supportedSdks);
  let agentModels = 0;
  let models = 0;
  for (const [providerId, provider] of Object.entries(catalog)) {
    if (!isRecord(provider) || !isName(provider.npm) || !isRecord(provider.models)) {
      throw new Error(`Invalid Models.dev provider: ${providerId} (expected npm and models)`);
    }
    providerSdks.push(provider.npm);
    for (const [key, model] of Object.entries(provider.models)) {
      if (!isRecord(model)) throw new Error(`Invalid Models.dev model: ${providerId}/${key}`);
      const modelId = model.id ?? key;
      if (!isName(modelId)) throw new Error(`Invalid Models.dev model ID: ${providerId}/${key}`);
      const override = model.provider;
      if (override !== undefined && !isRecord(override)) {
        throw new Error(`Invalid model provider override: ${providerId}/${modelId}`);
      }
      if (override?.npm !== undefined) {
        if (!isName(override.npm)) throw new Error(`Invalid model SDK override: ${providerId}/${modelId}`);
        modelOverrideSdks.push(override.npm);
      }
      if (override) {
        // Preserve routing evidence, never credentials or raw request defaults.
        modelOverrides.push({ providerId, modelId, sdk: override.npm ?? provider.npm,
          ...(override.api !== undefined ? { api: override.api } : {}),
          ...(override.shape !== undefined ? { shape: override.shape } : {}),
          ...(override.body !== undefined ? { bodyKeys: Object.keys(override.body) } : {}),
          ...(override.headers !== undefined ? { headerNames: Object.keys(override.headers) } : {}) });
      }
      const sdk = override?.npm ?? provider.npm;
      const eligible = isAgentEligibleModel(model);
      if (eligible) { agentSdks.push(sdk); agentModels += 1; }
      if (!supported.includes(sdk)) unsupportedRoutes.push({ providerId, modelId, sdk, eligible,
        exclusionReasons: eligible ? [] : [
          ...(model.tool_call !== true ? ['tool-calling not advertised'] : []),
          ...(model.modalities?.output && !model.modalities.output.includes('text') ? ['text output not advertised'] : []),
        ] });
      if (sdk === 'gitlab-ai-provider') gitlabModels.push({ id: modelId, family: model.family, canonicalModelId: model.canonical_model_id, eligible });
      models += 1;
    }
  }

  const listed = sortedUnique([...providerSdks, ...modelOverrideSdks]);
  const gitlabModelIds = sortedUnique(gitlabModels.map(({ id }) => id));
  const missing = listed.filter(sdk => !supported.includes(sdk));
  const listedAgentSdks = sortedUnique(agentSdks);
  const missingAgentSdks = listedAgentSdks.filter(sdk => !supported.includes(sdk));
  const missingGitlabMetadata = gitlabModels.filter(model => !isName(model.family) && !isName(model.canonicalModelId)).map(({ id }) => id).sort();
  const missingAgentGitlabMetadata = gitlabModels.filter(model => model.eligible && !isName(model.family) && !isName(model.canonicalModelId)).map(({ id }) => id).sort();
  return {
    scope: 'agent-eligible text/tool routes',
    providers: Object.keys(catalog).length,
    models,
    providerSdks: sortedUnique(providerSdks),
    modelOverrideSdks: sortedUnique(modelOverrideSdks),
    catalogSdks: listed,
    supportedSdks: supported,
    missing,
    agentModels,
    agentSdks: listedAgentSdks,
    missingAgentSdks,
    excludedOnlySdks: missing.filter(sdk => !listedAgentSdks.includes(sdk)),
    unsupportedRoutes: unsupportedRoutes.sort((a, b) => `${a.providerId}/${a.modelId}`.localeCompare(`${b.providerId}/${b.modelId}`)),
    modelOverrides: modelOverrides.sort((a, b) => `${a.providerId}/${a.modelId}`.localeCompare(`${b.providerId}/${b.modelId}`)),
    gitlab: { catalogModelIds: gitlabModelIds, missingMetadata: missingGitlabMetadata,
      agentModelIds: sortedUnique(gitlabModels.filter(model => model.eligible).map(({ id }) => id)), missingAgentMetadata: missingAgentGitlabMetadata },
    catalogCoverageComplete: missing.length === 0 && missingGitlabMetadata.length === 0,
    coverageComplete: missingAgentSdks.length === 0 && missingAgentGitlabMetadata.length === 0,
    limitations: 'Gates SDK name registration and GitLab routing metadata for models advertising tool calls and text output (omitted output modalities are accepted, matching presets). Full unsupported catalog names and routes remain in the inventory. Does not prove protocol, authentication, tool-call or account-level model compatibility.',
  };
}

export function sdkCoverageFailures(report) {
  return [
    ...(report.missingAgentSdks.length ? [`Unsupported agent-eligible Models.dev SDKs: ${report.missingAgentSdks.join(', ')}`] : []),
    ...(report.gitlab.missingAgentMetadata.length ? [`Agent-eligible GitLab Duo models missing Models.dev routing metadata: ${report.gitlab.missingAgentMetadata.join(', ')}`] : []),
  ];
}
