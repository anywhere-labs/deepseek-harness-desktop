/** Native Messages capability discovery; no generation requests are made. */
export async function discoverNativeReasoningModels(request, signal, dependencies, parseCapability, apiRoot) {
  const connection = dependencies.options();
  const allowed = connection.defaults.thinking === 'disabled' ? ['off'] : ['off', 'low', 'high', 'max'];
  const adapterCapability = {
    status: 'known', source: 'adapter',
    efforts: allowed.map(id => ({ id, name: id, wireValue: id })),
  };
  const fallback = () => connection.models.map(model => ({
    id: model.id, name: model.name ?? model.id, reasoningCapability: adapterCapability,
  }));
  if (!request.baseURL) return fallback();
  const headers = request.apiKey !== undefined ? { 'x-api-key': request.apiKey }
    : request.baseURL.replace(/\/+$/, '') === connection.baseURL.replace(/\/+$/, '')
      ? (await dependencies.resolveAuth(connection)).headers : {};
  const response = await fetch(`${apiRoot(request.baseURL)}/models`, {
    headers: { ...headers, 'anthropic-version': '2023-06-01' }, signal, redirect: 'error',
  });
  if (response.status === 404 || response.status === 405) return fallback();
  if (!response.ok) throw new Error(`Model capability lookup failed (${response.status}); retry in model settings.`);
  const body = await response.json();
  const listing = Array.isArray(body) ? body : body?.data ?? body?.models;
  if (!Array.isArray(listing)) throw new Error('The endpoint returned an invalid model listing; retry in model settings.');
  return listing.filter(model => typeof model?.id === 'string').map(model => {
    const explicit = model.reasoningEfforts !== undefined || model.reasoning_efforts !== undefined;
    const declared = model.reasoningEfforts ?? model.reasoning_efforts;
    const nativeModel = Array.isArray(declared) ? { ...model, reasoningEfforts: declared.map(value =>
      typeof value === 'string' ? { id: value, name: value, wireValue: value } : value) } : model;
    let capability = explicit ? parseCapability(nativeModel, allowed) : adapterCapability;
    if (capability.efforts.some(effort => effort.wireValue !== undefined && effort.wireValue !== effort.id))
      capability = { status: 'unknown', source: 'endpoint', efforts: [] };
    return { id: model.id, name: model.name ?? model.id,
      reasoningCapability: { ...capability, endpoint: request.baseURL, api: 'anthropic-messages' },
    };
  });
}
