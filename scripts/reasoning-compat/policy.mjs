/** Provider/model reasoning policy, shared by the patched Host and Client. */
export function nativeReasoningPolicy(thinking, effort) {
  const allowedIds = thinking === 'disabled' ? ['off'] : ['off', 'low', 'high', 'max'];
  return {
    allowedIds,
    inheritedDefault: thinking === 'disabled' ? 'off' : effort ?? 'high',
    capability: { status: 'known', source: 'adapter', efforts: allowedIds.map(id => ({ id, name: id, wireValue: id })) },
  };
}

export function reasoningCandidates(config, fallback = []) {
  return config?.manualEfforts ?? config?.capability?.efforts ?? fallback;
}

/** Saved endpoint evidence applies only to the connection that supplied it. */
export function reasoningConfigForConnection(config, endpoint, api) {
  const capability = config?.capability;
  if (capability?.endpoint === undefined || endpoint === undefined) return config;
  if (capability.endpoint.replace(/\/+$/, '') === endpoint.replace(/\/+$/, '')
    && (capability.api === undefined || api === undefined || capability.api === api)) return config;
  return { ...config, capability: { status: 'unknown', source: 'endpoint', efforts: [], endpoint, api } };
}

export function reasoningManualConflict(config) {
  if (!config?.capability?.authoritative || config.manualEfforts === undefined) return false;
  return config.manualEfforts.some(effort => !config.capability.efforts.some(declared =>
    declared.id === effort.id && (declared.wireValue === undefined ? declared.id : declared.wireValue)
      === (effort.wireValue === undefined ? effort.id : effort.wireValue)));
}

/** A refresh adopts evidence while retaining the user's range and corrections. */
export function refreshReasoningConfig(config, capability) {
  if (capability === undefined) return config;
  if (capability.status === 'unknown') return config ?? { capability, selected: [] };
  if (config?.capability?.source === 'endpoint' && config.capability.authoritative && capability.source !== 'endpoint') return config;
  if (capability.status === 'unsupported' && !capability.authoritative && config !== undefined) return config;
  if (config === undefined) return { capability, selected: capability.efforts.map(effort => effort.id) };
  if (config.capability?.status === 'unknown' && config.manualEfforts === undefined && config.selected.length === 0
    && capability.status === 'known') return { ...config, capability, selected: capability.efforts.map(effort => effort.id), manualAcknowledged: false };
  const changed = JSON.stringify(config.capability) !== JSON.stringify(capability);
  const old = config.capability?.efforts ?? [];
  const retained = capability.authoritative
    ? capability.efforts
    : [...capability.efforts, ...old.filter(effort => !capability.efforts.some(next => next.id === effort.id))];
  return {
    ...config,
    capability: { ...capability, efforts: retained },
    ...(changed ? { manualAcknowledged: false } : {}),
  };
}

/** Diagnose configuration without making the rest of Provider management fail. */
export function reasoningConfigError(config, allowedIds, inheritedDefault) {
  if (config === undefined) return undefined;
  if (config.manualEfforts === undefined && config.capability?.status !== 'known'
    && !config.capability?.authoritative) return undefined;
  const efforts = reasoningCandidates(config);
  if (!Array.isArray(config.selected) || !Array.isArray(efforts)) return 'Invalid reasoning configuration';
  const supported = new Set(efforts.map(effort => effort.id));
  if (supported.size !== efforts.length) return 'Reasoning efforts must have distinct IDs';
  for (const effort of efforts) {
    if (typeof effort.id !== 'string' || !effort.id || typeof effort.name !== 'string' || !effort.name
      || (allowedIds !== undefined && !allowedIds.includes(effort.id))) return 'The adapter cannot express this reasoning effort';
    if (effort.wireValue !== undefined && effort.wireValue !== null
      && (typeof effort.wireValue !== 'string' || !effort.wireValue)) return 'A reasoning wire value must be nonempty';
    if (effort.wireValue === null && effort.id !== 'off') return 'Only off may omit its wire value';
  }
  const configured = config.manualEfforts !== undefined || config.capability?.status === 'known';
  if (configured && allowedIds?.includes('minimal') && efforts.length > 0 && efforts.every(effort => effort.id === 'off'))
    return 'This adapter requires a thinking effort alongside off; leave non-reasoning models unconfigured';
  if (configured && config.selected.length === 0) return 'Select at least one reasoning effort';
  if (new Set(config.selected).size !== config.selected.length
    || config.selected.some(id => !supported.has(id))) return 'An enabled reasoning effort is no longer supported; correct this model';
  if (reasoningManualConflict(config) && !config.manualAcknowledged)
    return 'Endpoint capabilities conflict with manual declarations; resolve the conflict';
  if (config.capability?.status === 'unsupported' && config.manualEfforts === undefined && config.selected.length)
    return 'The endpoint no longer supports reasoning; correct this model';
  if (config.capability?.status === 'unsupported' && config.manualEfforts === undefined && config.defaultEffort === undefined) return undefined;
  const defaultEffort = config.defaultEffort ?? inheritedDefault;
  if (defaultEffort !== undefined && !config.selected.includes(defaultEffort)) return 'The default reasoning effort is outside the enabled range';
  return undefined;
}

/** Preserve adapter-owned metadata and defaults, exposing only the chosen range. */
export function selectedReasoningInfo(config, reasoning) {
  if (config === undefined) return reasoning;
  if (config.capability?.status === 'unsupported' && config.manualEfforts === undefined) return undefined;
  const candidates = reasoningCandidates(config, reasoning?.efforts);
  if (config.capability?.status !== 'known' && config.manualEfforts === undefined) return reasoning;
  const valid = candidates.filter(effort => config.selected.includes(effort.id));
  if (valid.length === 0) return undefined;
  const defaultEffort = config.defaultEffort ?? reasoning?.defaultEffort;
  return {
    efforts: valid.map(({ id, name }) => ({ id, name })),
    ...(defaultEffort === undefined || !valid.some(effort => effort.id === defaultEffort) ? {} : { defaultEffort }),
  };
}

/** Resolve every explicit/default request through the same model policy. */
export function configuredReasoningEffort(config, inheritedDefault, explicit, provider, model, allowedIds) {
  if (config === undefined || config.manualEfforts === undefined && config.capability?.status !== 'known'
    && !config.capability?.authoritative) return explicit ?? inheritedDefault;
  const error = reasoningConfigError(config, allowedIds, config.defaultEffort === undefined ? inheritedDefault : undefined);
  if (error !== undefined) throw new Error(`Provider "${provider}" model "${model}": ${error}. Open model settings to correct it.`);
  const effort = explicit ?? config.defaultEffort ?? inheritedDefault;
  if (effort !== undefined && !config.selected.includes(effort)) {
    throw new Error(`Provider "${provider}" model "${model}" reasoning effort "${effort}" is outside the enabled range. Choose an enabled effort in model settings.`);
  }
  return effort;
}

/** Read explicit endpoint effort lists/maps, never infer them from model names. */
export function endpointReasoningCapability(entry, allowedIds) {
  const declared = entry?.reasoningEfforts ?? entry?.reasoning_efforts;
  if (declared === false) return { status: 'unsupported', source: 'endpoint', authoritative: true, efforts: [] };
  if (declared === undefined || declared === null) return { status: 'unknown', source: 'endpoint', efforts: [] };
  let efforts;
  if (Array.isArray(declared)) {
    efforts = declared.map(value => typeof value === 'string'
      ? { id: value, name: value, wireValue: value === 'off' ? null : value }
      : value !== null && typeof value === 'object' ? { id: value.id, name: value.name ?? value.id, wireValue: Object.hasOwn(value, 'wireValue') ? value.wireValue : value.id } : {});
  } else if (typeof declared === 'object') {
    efforts = Object.entries(declared).map(([id, wireValue]) => ({ id, name: id, wireValue }));
  } else return { status: 'unknown', source: 'endpoint', efforts: [] };
  if (efforts.length === 0 || reasoningConfigError({ manualEfforts: efforts, selected: efforts.map(effort => effort.id) }, allowedIds)) {
    return { status: 'unknown', source: 'endpoint', efforts: [] };
  }
  return { status: 'known', source: 'endpoint', authoritative: true, efforts };
}
