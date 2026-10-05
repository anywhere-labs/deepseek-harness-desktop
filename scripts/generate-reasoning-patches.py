"""Build Desktop compatibility patches from the pinned runtime artifacts.

The vendored archives and upstream checkout stay unchanged. Maintained patch
sources live beside this generator; both runtime channels use the same policy.
"""

import difflib
import json
import pathlib
import tarfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCES = ROOT / "scripts" / "reasoning-compat"
VERSIONS = ("0.2.1-alpha.1", "0.2.0-rc.2")


def read_package(version, package):
    archive = ROOT / "vendor" / "dsh-runtime" / version / f"deepseek-ai-dsh-{package}-{version}.tgz"
    with tarfile.open(archive) as source:
        return {
            member.name.removeprefix("package/"): source.extractfile(member).read().decode("utf-8")
            for member in source.getmembers()
            if member.isfile() and member.name.endswith((".js", ".d.ts"))
        }


def replace_once(files, path, before, after):
    count = files[path].count(before)
    if count != 1:
        raise ValueError(f"{path}: expected one patch anchor, found {count}: {before[:80]!r}")
    files[path] = files[path].replace(before, after, 1)


def write_patch(version, package, original, updated):
    changes = []
    for path in sorted(set(original) | set(updated)):
        before, after = original.get(path, ""), updated.get(path, "")
        if before == after:
            continue
        changes.append(f"diff --git a/{path} b/{path}\n")
        if path not in original:
            changes.append("new file mode 100644\n")
        for line in difflib.unified_diff(
            before.splitlines(keepends=True), after.splitlines(keepends=True),
            fromfile=f"a/{path}" if path in original else "/dev/null", tofile=f"b/{path}",
        ):
            changes.append(line if line.endswith("\n") else line + "\n\\ No newline at end of file\n")
    target = ROOT / "patches" / f"dsh-{package}@{version}.patch"
    target.write_text("".join(changes), encoding="utf-8", newline="\n")


def generate():
    for version in VERSIONS:
        for package, transform in (("llm", patch_llm), ("llm-pi-ai", patch_pi_ai), ("llm-deepseek", patch_deepseek), ("api-remotes", patch_api_remotes), ("client-ui-settings-models", patch_settings), ("client-ui-model-selection", patch_selection)):
            original = read_package(version, package)
            updated = dict(original)
            transform(updated)
            write_patch(version, package, original, updated)


def inline_source(name):
    return (SOURCES / name).read_text(encoding="utf-8").replace("export ", "")


def patch_llm(files):
    policy = inline_source("policy.mjs") + "\n" + inline_source("schema.mjs")
    names = ["reasoningCandidates", "reasoningConfigForConnection", "reasoningManualConflict", "refreshReasoningConfig", "reasoningConfigError", "selectedReasoningInfo", "configuredReasoningEffort", "endpointReasoningCapability", "modelReasoningSchema"]
    files["lib/index.js"] += "\n" + policy + "\nexport { " + ", ".join(names) + " };\n"
    files["lib/types/reasoning-config.d.ts"] = (SOURCES / "types.d.ts").read_text(encoding="utf-8")
    files["lib/types/reasoning-config.d.ts"] += "export declare function modelReasoningSchema(z: typeof import('@deepseek-ai/schemastery').default): import('@deepseek-ai/schemastery').default<ModelReasoningConfig>;\n"
    files["lib/types/index.d.ts"] += "\nexport * from './reasoning-config.js';\n"
    replace_once(files, "lib/types/types.d.ts", "export interface LlmDiscoveredModel {", "export interface LlmDiscoveredModel {\n    reasoningCapability?: import('./reasoning-config.js').ModelReasoningCapability;")
    replace_once(files, "lib/types/types.d.ts", "export interface LlmModelInfo {", "export interface LlmModelInfo {\n    reasoningConfigurationError?: string;")
    replace_once(files, "lib/index.js", "\t\t\tconst reasoning = resolved.reasoning;", "\t\t\tif (resolved.reasoningConfigurationError !== undefined) info.reasoningConfigurationError = resolved.reasoningConfigurationError;\n\t\t\tconst reasoning = resolved.reasoning;")
    replace_once(files, "lib/index.js", "\t\tresolveCallWithInfo(config, info) {", "\t\tresolveCallWithInfo(config, info) {\n\t\t\tif (info.reasoningConfigurationError !== undefined) throw new LlmError(`Provider \"${config.provider}\" model \"${config.model}\": ${info.reasoningConfigurationError}. Open model settings to correct it.`, 'UNSUPPORTED_REASONING_EFFORT');")
    replace_once(files, "lib/index.js", "\t\t\t\t\t...model.inputModalities === void 0 ? {} : { inputModalities: [...model.inputModalities] }", "\t\t\t\t\t...model.inputModalities === void 0 ? {} : { inputModalities: [...model.inputModalities] },\n\t\t\t\t\t...model.reasoningCapability === undefined ? {} : { reasoningCapability: structuredClone(model.reasoningCapability) }")
    for path in ("lib/typert.host.js", "lib/typert.remote-client.js"):
        anchor = "  'inputModalities': z.array(z.union([z.literal(\"text\"), z.literal(\"image\")])).optional(),"
        # Only the discovery result schema owns this exact line in these carriers.
        replace_once(files, path, anchor, anchor + "\n  'reasoningCapability': " + capability_wire_schema("z.") + ",")


def patch_pi_ai(files):
    path = "lib/index.js"
    files[path] = 'import { modelReasoningSchema, reasoningCandidates, reasoningConfigForConnection, reasoningConfigError, selectedReasoningInfo, configuredReasoningEffort, endpointReasoningCapability } from "@deepseek-ai/dsh-llm";\n' + files[path]
    replace_once(files, path, '\t\tconst contextWindow = entry.contextWindow ?? base?.contextWindow ?? request.defaultContextWindow;', '\t\tentry = { ...entry, reasoningConfig: reasoningConfigForConnection(entry.reasoningConfig, baseUrl, api) };\n\t\tconst contextWindow = entry.contextWindow ?? base?.contextWindow ?? request.defaultContextWindow;')
    replace_once(files, path, "\treasoningEfforts: z.union([z.const(false), reasoningEfforts]),", "\treasoningEfforts: z.union([z.const(false), reasoningEfforts]),\n\treasoningConfig: modelReasoningSchema(z),")
    replace_once(files, path, "\tconst efforts = entry.reasoningEfforts;", """\tconst configured = entry.reasoningConfig;
\tif (configured !== undefined && reasoningConfigError(configured, THINKING_LEVELS) !== undefined) return { reasoning: false };
\tconst candidates = reasoningCandidates(configured);
\tconst efforts = configured?.manualEfforts !== undefined || configured?.capability?.status === 'known'
\t\t? Object.fromEntries(candidates.map(effort => [effort.id, effort.wireValue ?? (effort.id === 'off' ? null : effort.id)]))
\t\t: configured?.capability?.status === 'unsupported' ? false : entry.reasoningEfforts;""")
    replace_once(files, path, "\t\t\t...resolveModelReasoning(provider, entry, base),", "\t\t\t...resolveModelReasoning(provider, entry, base),\n\t\t\t...entry.reasoningConfig === undefined ? {} : { reasoningConfig: structuredClone(entry.reasoningConfig) },")
    replace_once(files, path, "\t\t\t...reasoningInfo(resolvedModel, defaultLevel)", "\t\t\treasoningConfigurationError: reasoningConfigError(resolvedModel.reasoningConfig, THINKING_LEVELS, profile.reasoning),\n\t\t\t...(() => { const reasoning = selectedReasoningInfo(resolvedModel.reasoningConfig, reasoningInfo(resolvedModel, defaultLevel).reasoning); return reasoning === undefined ? {} : { reasoning }; })()")
    replace_once(files, path, "\t\t\tconst reasoning = resolveReasoningLevel(model, options.reasoningEffort ?? profile.reasoning);", """\t\t\tlet configured;
\t\t\ttry { configured = configuredReasoningEffort(model.reasoningConfig, profile.reasoning, options.reasoningEffort, options.provider, options.model, THINKING_LEVELS); }
\t\t\tcatch (error) { throw new LlmError(error.message, 'UNSUPPORTED_REASONING_EFFORT', { cause: error }); }
\t\t\tconst reasoning = resolveReasoningLevel(model, configured);""")
    type_path = "lib/types/catalog.d.ts"
    replace_once(files, type_path, "    reasoningEfforts?: false | PiAiReasoningEfforts;", "    reasoningEfforts?: false | PiAiReasoningEfforts;\n    reasoningConfig?: import('@deepseek-ai/dsh-llm').ModelReasoningConfig;")
    replace_once(files, path, '\t\t\t\tif (options.signal?.aborted) throw new LlmError("pi-ai request aborted by caller", "ABORTED", { cause: error });', '''\t\t\t\tif (options.signal?.aborted) throw new LlmError("pi-ai request aborted by caller", "ABORTED", { cause: error });
\t\t\t\tif (error instanceof LlmError && error.code === 'INVALID_REQUEST' && /reasoning|thinking|effort/i.test(error.message)) throw new LlmError(`Provider "${options.provider}" model "${options.model}" rejected reasoning effort "${options.reasoningEffort ?? 'service default'}": ${error.message}. Open model settings to correct it.`, 'UNSUPPORTED_REASONING_EFFORT', { cause: error });''')
    replace_once(files, path, '\t\t\t\t\t\tyield result.value;', '''\t\t\t\t\t\tconst chunk = result.value;
\t\t\t\t\t\tif (chunk.type === 'finish' && chunk.reason.kind === 'error' && chunk.reason.failure.code === 'INVALID_REQUEST' && /reasoning|thinking|effort/i.test(chunk.reason.failure.message)) {
\t\t\t\t\t\t\tyield { ...chunk, reason: { ...chunk.reason, failure: { ...chunk.reason.failure, code: 'UNSUPPORTED_REASONING_EFFORT', message: `Provider "${options.provider}" model "${options.model}" rejected reasoning effort "${options.reasoningEffort ?? 'service default'}": ${chunk.reason.failure.message}. Open model settings to correct it.` } } };
\t\t\t\t\t\t} else yield chunk;''')
    replace_once(files, path, "\t\t\t...maxTokens === void 0 ? {} : { maxTokens }\n\t\t});", "\t\t\t...maxTokens === void 0 ? {} : { maxTokens },\n\t\t\treasoningCapability: endpointReasoningCapability(entry, THINKING_LEVELS)\n\t\t});")
    replace_once(files, path, "\tif (request.provider !== void 0) {\n\t\tconst installed = catalogModels(request.provider);", "\tif (request.provider !== void 0 && !request.baseURL) {\n\t\tconst installed = catalogModels(request.provider);")
    replace_once(files, path, "\t\t\tinputModalities: [...model.input]\n\t\t}));", "\t\t\tinputModalities: [...model.input],\n\t\t\treasoningCapability: piReasoningCapability(model)\n\t\t}));")
    replace_once(files, path, "\treturn readListing(body);", """\tconst found = readListing(body);
\tconst installed = request.provider === undefined ? new Map() : catalogModels(request.provider);
\tconst catalogURL = request.provider === undefined ? undefined : catalogProvider(request.provider)?.baseUrl;
\tconst exactEndpoint = catalogURL !== undefined && request.baseURL.replace(/\\/+$/, '') === catalogURL.replace(/\\/+$/, '');
\treturn found.map(model => {
\t\tconst known = exactEndpoint ? installed.get(model.id) : undefined;
\t\tconst result = known !== undefined && (request.api === undefined || request.api === known.api) && model.reasoningCapability?.status === 'unknown'
\t\t\t? { ...model, reasoningCapability: piReasoningCapability(known) } : model;
\t\treturn { ...result, reasoningCapability: { ...result.reasoningCapability, endpoint: request.baseURL, ...request.api === undefined ? {} : { api: request.api } } };
\t});""")
    files[path] += """
function piReasoningCapability(model) {
  if (!model.reasoning) return { status: 'unsupported', source: 'catalog', efforts: [], endpoint: model.baseUrl, api: model.api };
  return { status: 'known', source: 'catalog', endpoint: model.baseUrl, api: model.api, efforts: getSupportedThinkingLevels(model).map(id => ({
    id, name: id.charAt(0).toUpperCase() + id.slice(1),
    wireValue: model.thinkingLevelMap?.[id] ?? (id === 'off' ? null : id),
  })) };
}
"""


def capability_wire_schema(prefix):
    return (
        prefix + "object({status: " + prefix + "enum(['known','unknown','unsupported']), source: " + prefix + "enum(['endpoint','catalog','adapter']), authoritative: " + prefix + "boolean().optional(), endpoint: " + prefix + "string().optional(), api: " + prefix + "string().optional(), efforts: "
        + prefix + "array(" + prefix + "object({id: " + prefix + "string(), name: " + prefix + "string(), wireValue: " + prefix + "union([" + prefix + "string(), " + prefix + "literal(null)]).optional()}))}).optional()"
    )


def patch_api_remotes(files):
    path = "lib/client.js"
    start = files[path].index("const _deepseek_ai_dsh_llm_llm_discoverModels_result$schema =")
    end = files[path].index("let _deepseek_ai_dsh_llm_llm_listConfigurableProviders", start)
    block = files[path][start:end]
    anchor = '\t\t\t"inputModalities": array(union([literal("text"), literal("image")])).optional()'
    if block.count(anchor) != 1:
        raise ValueError("unexpected API discovery result schema")
    # The bundled zod constructor is named _enum; avoid JS's reserved enum keyword.
    schema = capability_wire_schema("").replace("enum(", "_enum(")
    block = block.replace(anchor, anchor + ',\n\t\t\t"reasoningCapability": ' + schema)
    files[path] = files[path][:start] + block + files[path][end:]


def patch_deepseek(files):
    path = "lib/index.js"
    files[path] = 'import { modelReasoningSchema, selectedReasoningInfo, reasoningConfigError, configuredReasoningEffort } from "@deepseek-ai/dsh-llm";\n' + files[path]
    replace_once(files, path, "const catalogModel = z.object({", "const catalogModel = z.object({\n\treasoningConfig: modelReasoningSchema(z),")
    replace_once(files, path, "\t\t\tinputModalities: [...inputModalities],", "\t\t\tinputModalities: [...inputModalities],\n\t\t\t...model.reasoningConfig === undefined ? {} : { reasoningConfig: structuredClone(model.reasoningConfig) },")
    start = files[path].index("\t\t...connection.defaults.thinking === \"disabled\" ? { reasoning:")
    end = files[path].index("\n\t};\n}", start)
    files[path] = files[path][:start] + '''\t\treasoningConfigurationError: nativeReasoningError(configured?.reasoningConfig, connection),
\t\t...(() => {
\t\t\tconst inherited = connection.defaults.thinking === 'disabled' ? 'off' : connection.defaults.reasoningEffort ?? 'high';
\t\t\tconst reasoning = selectedReasoningInfo(configured?.reasoningConfig, { efforts: connection.defaults.thinking === 'disabled' ? OFF_ONLY_REASONING_EFFORTS : REASONING_EFFORTS, defaultEffort: inherited });
\t\t\treturn reasoning === undefined ? {} : { reasoning };
\t\t})()''' + files[path][end:]
    replace_once(files, path, '\tconst effort = options.purpose === "session-title" ? "off" : options.reasoningEffort ?? connection.defaults.reasoningEffort ?? (connection.defaults.thinking === "disabled" ? "off" : "high");', '''\tlet effort;
\ttry {
\t\tconst config = model?.reasoningConfig;
\t\tconst error = nativeReasoningError(config, connection);
\t\tif (error !== undefined) throw new Error(error);
\t\teffort = configuredReasoningEffort(config, connection.defaults.thinking === 'disabled' ? 'off' : connection.defaults.reasoningEffort ?? 'high', options.purpose === 'session-title' ? 'off' : options.reasoningEffort, options.provider, options.model, ['off', 'low', 'high', 'max']);
\t} catch (error) { throw new LlmError(`Provider "${options.provider}" model "${options.model}": ${error.message}. Open model settings to correct it.`, 'UNSUPPORTED_REASONING_EFFORT', { cause: error }); }''')
    files[path] += '''
function nativeReasoningError(config, connection) {
  const allowed = connection.defaults.thinking === 'disabled' ? ['off'] : ['off','low','high','max'];
  const error = reasoningConfigError(config, allowed, connection.defaults.thinking === 'disabled' ? 'off' : connection.defaults.reasoningEffort ?? 'high');
  if (error !== undefined) return error;
  if (config?.manualEfforts?.some(effort => effort.wireValue !== undefined && effort.wireValue !== effort.id)) return 'Native DeepSeek requires its own effort wire values';
}
'''
    replace_once(files, "lib/types/types.d.ts", "export interface DeepSeekCatalogModel {", "export interface DeepSeekCatalogModel {\n    reasoningConfig?: import('@deepseek-ai/dsh-llm').ModelReasoningConfig;")
    replace_once(files, path, '\t\t\t\t\tconst failure = providerError(raw, response.status, response.headers);', '''\t\t\t\t\tconst failure = providerError(raw, response.status, response.headers);
\t\t\t\t\tif ([400,422].includes(response.status) && /reasoning|thinking|effort/i.test(failure.message)) throw new LlmError(`Provider "${options.provider}" model "${options.model}" rejected reasoning effort "${options.reasoningEffort ?? 'service default'}": ${failure.message}. Open model settings to correct it.`, 'UNSUPPORTED_REASONING_EFFORT', { cause: new Error(text) });''')

    files[path] = 'import { endpointReasoningCapability, reasoningConfigForConnection } from "@deepseek-ai/dsh-llm";\n' + files[path]
    files[path] += '\n' + inline_source('native-discovery.mjs')
    replace_once(files, path, 'function registerDeepSeekProvider(ctx, provider, dependencies) {', '''function registerDeepSeekProvider(ctx, provider, dependencies) {
\tconst settingsNs = ctx.fiber.entry?.options.id ?? (provider === 'deepseek-account' ? 'llm-deepseek-account' : 'llm-deepseek');
\tctx.llm.registerModelDiscovery(settingsNs, (request, signal) => discoverNativeReasoningModels(request, signal, dependencies, endpointReasoningCapability, messagesApiRoot));''')
    replace_once(files, path, '\tconst configured = connection.models.find((entry) => entry.id === model);', '\tconst configured = connection.models.find((entry) => entry.id === model);\n\tconst reasoningConfig = reasoningConfigForConnection(configured?.reasoningConfig, connection.baseURL, "anthropic-messages");')
    replace_once(files, path, 'nativeReasoningError(configured?.reasoningConfig, connection)', 'nativeReasoningError(reasoningConfig, connection)')
    replace_once(files, path, 'selectedReasoningInfo(configured?.reasoningConfig,', 'selectedReasoningInfo(reasoningConfig,')
    replace_once(files, path, 'const config = model?.reasoningConfig;', "const config = reasoningConfigForConnection(model?.reasoningConfig, connection.baseURL, 'anthropic-messages');")


def patch_settings(files):
    path = "lib/client.js"
    controls = inline_source("client-controls.mjs")
    controls = controls[controls.index("/** Accessible"):]
    anchor = "\t\tfunction ModelRow(props) {"
    replace_once(files, path, anchor, inline_source("policy.mjs") + "\n" + controls + "\nconst ModelReasoningControls = createModelReasoningControls(react);\n" + anchor)
    replace_once(files, path, 'props.onFieldChange(field, field === "name" && value === "" ? void 0 : value);', '''if (field === 'id' && value !== model.id) {
\t\t\t\t\t\t\t\t\tconst next = { ...model, id: value };
\t\t\t\t\t\t\t\t\tdelete next.reasoningConfig;
\t\t\t\t\t\t\t\t\tdelete next.reasoningEfforts;
\t\t\t\t\t\t\t\t\tprops.onChange(next);
\t\t\t\t\t\t\t\t} else props.onFieldChange(field, field === 'name' && value === '' ? undefined : value);''')
    replace_once(files, path, '\t\t\t\t\t\tonChange: props.onChange\n\t\t\t\t\t})]', '''\t\t\t\t\t\tonChange: props.onChange
\t\t\t\t\t}), react.createElement(ModelReasoningControls, {
\t\t\t\t\t\tmodel, position, disabled, t, onChange: props.onChange,
\t\t\t\t\t\tnative: props.inputField === 'inputModalities', allowedIds: props.reasoningAllowedIds, fallback: props.reasoningFallback,
\t\t\t\t\t\tinheritedDefault: props.inheritedReasoningDefault, endpoint: props.reasoningEndpoint, api: props.reasoningApi
\t\t\t\t\t})]''')
    replace_once(files, path, "\t\t\t\tseen.add(trimmed);", "\t\t\t\tseen.add(trimmed);\n\t\t\t\tif (reasoningConfigError(model.reasoningConfig)) return { index, key: 'modelReasoningInvalid' };")
    replace_once(files, path, 'function validateDeepSeekModels(value) {', 'function validateDeepSeekModels(value, allowedIds, inheritedDefault) {')
    replace_once(files, path, "if (reasoningConfigError(model.reasoningConfig))", "if (reasoningConfigError(model.reasoningConfig, allowedIds, inheritedDefault))")
    replace_once(files, path, 'const modelFailure = validateDeepSeekModels(models);', "const modelFailure = validateDeepSeekModels(models, ['off','minimal','low','medium','high','xhigh','max']);")
    replace_once(files, path, '\t\t\t\t...candidate.inputModalities === void 0 ? {} : { input: [...candidate.inputModalities] }', "\t\t\t\t...candidate.inputModalities === void 0 ? {} : { input: [...candidate.inputModalities] },\n\t\t\t\t...refreshReasoningConfig(undefined, candidate.reasoningCapability) === undefined ? {} : { reasoningConfig: refreshReasoningConfig(undefined, candidate.reasoningCapability) }")
    # Connection identity includes credentials, but is kept in memory and never logged.
    replace_once(files, path, "\t\t\tconst { catalogProvider } = props;", """\t\t\tconst { catalogProvider } = props;
\t\t\tconst connectionKey = JSON.stringify(probe);
\t\t\tconst activeConnection = react.useRef(connectionKey);
\t\t\tactiveConnection.current = connectionKey;
\t\t\tconst activeModels = react.useRef(models);
\t\t\tactiveModels.current = models;
\t\t\tconst refreshRows = (found) => {
\t\t\t\tconst next = activeModels.current.map(model => {
\t\t\t\t\tconst capability = found.find(candidate => candidate.id === model.id)?.reasoningCapability;
\t\t\t\t\tconst legacy = model.reasoningEfforts;
\t\t\t\t\tconst previous = model.reasoningConfig ?? (legacy && typeof legacy === 'object' ? { manualEfforts: Object.entries(legacy).map(([id, wireValue]) => ({ id, name: id, wireValue })), selected: Object.keys(legacy), manualAcknowledged: true } : undefined);
\t\t\t\t\tconst config = refreshReasoningConfig(reasoningConfigForConnection(previous, probe.baseURL, probe.api), capability);
\t\t\t\t\treturn config === undefined ? model : { ...model, reasoningConfig: config };
\t\t\t\t});
\t\t\t\tonChange(next);
\t\t\t};""")
    replace_once(files, path, "operations.discoverModels(probe.settingsNs, { provider: catalogProvider }).then((answer) => {", "operations.discoverModels(probe.settingsNs, { ...probe, provider: catalogProvider }).then((answer) => {")
    replace_once(files, path, "\t\t\t\t\tif (!current) return;", "\t\t\t\t\tif (!current || activeConnection.current !== connectionKey) return;\n\t\t\t\t\tif (answer.kind === 'found') refreshRows(answer.models);")
    # Both catalog assignments carry the exact connection generation.
    files[path] = files[path].replace("provider: catalogProvider,\n", "provider: catalogProvider, connectionKey,\n")
    replace_once(files, path, "\t\t\t\tprobe.settingsNs\n\t\t\t]);", "\t\t\t\tprobe.settingsNs, connectionKey\n\t\t\t]);")
    replace_once(files, path, "const catalog = inheritedCatalog?.provider === catalogProvider ? inheritedCatalog?.models : void 0;", "const catalog = inheritedCatalog?.connectionKey === connectionKey ? inheritedCatalog?.models : void 0;")
    replace_once(files, path, '\t\t\tconst [candidates, setCandidates] = (0, react.useState)(void 0);', '''\t\t\tconst [candidates, setCandidates] = (0, react.useState)(void 0);
\t\t\treact.useEffect(() => {
\t\t\t\tactiveConnection.current = connectionKey;
\t\t\t\tsetCandidates(undefined);
\t\t\t\treturn () => { activeConnection.current = undefined; };
\t\t\t}, [connectionKey]);''')
    # Clear only reasoning ownership when the user changes a model's identity.
    replace_once(files, path, '\t\t\t\t\tconst cleared = new Set(Object.entries(next)', '\t\t\t\t\tif (next.id !== undefined && next.id !== model.id) next = { ...next, reasoningConfig: undefined, reasoningEfforts: undefined };\n\t\t\t\t\tconst cleared = new Set(Object.entries(next)')
    replace_once(files, path, '\t\t\t\t\tsetFailure(answer.kind === "refused" ? answer.message : void 0);\n\t\t\t\t});', '\t\t\t\t\tsetFailure(answer.kind === "refused" ? answer.message : void 0);\n\t\t\t\t}).catch(error => { if (current && activeConnection.current === connectionKey) setFailure(String(error)); });')
    replace_once(files, path, '\t\t\t\t} finally {\n\t\t\t\t\tsetBusy(false);\n\t\t\t\t}\n\t\t\t};\n\t\t\tconst closePicker', '\t\t\t\t} catch (error) {\n\t\t\t\t\tif (activeConnection.current === requestedConnection) setFailure(String(error));\n\t\t\t\t} finally {\n\t\t\t\t\tsetBusy(false);\n\t\t\t\t}\n\t\t\t};\n\t\t\tconst closePicker')
    replace_once(files, path, "\t\t\tconst fetchModels = async () => {", "\t\t\tconst fetchModels = async () => {\n\t\t\t\tconst requestedConnection = connectionKey;")
    replace_once(files, path, '\t\t\t\t\tif (answer.kind === "refused") {', '\t\t\t\t\tif (activeConnection.current !== requestedConnection) return;\n\t\t\t\t\tif (answer.kind === "refused") {')
    replace_once(files, path, "\t\t\t\t\tconst found = answer.models;", "\t\t\t\t\tconst found = answer.models;\n\t\t\t\t\trefreshRows(found);")
    replace_once(files, path, '\t\t\t\t\t\t\tinputField: "input",', '\t\t\t\t\t\t\tinputField: "input",\n\t\t\t\t\t\t\treasoningEndpoint: probe.baseURL, reasoningApi: probe.api,\n\t\t\t\t\t\t\treasoningFallback: catalog?.find(candidate => candidate.id === model.id)?.reasoningCapability,\n\t\t\t\t\t\t\tinheritedReasoningDefault: props.inheritedReasoningDefault,')
    replace_once(files, path, '\t\t\t\t\t\t\tinputField: "inputModalities",', '\t\t\t\t\t\t\tinputField: "inputModalities",\n\t\t\t\t\t\t\treasoningFallback: props.reasoningFallback,\n\t\t\t\t\t\t\tinheritedReasoningDefault: props.inheritedReasoningDefault,')
    replace_once(files, path, '\t\t\t\tconst catalogProps = {', '''\t\t\t\tconst nativeThinking = schema.getPath(draft, ['thinking']) ?? schema.getPath(fallback, ['thinking']);
\t\t\t\tconst inheritedReasoningDefault = schema.getPath(draft, [family === 'pi-ai' ? 'reasoning' : 'reasoningEffort']) ?? schema.getPath(fallback, [family === 'pi-ai' ? 'reasoning' : 'reasoningEffort']) ?? (family === 'pi-ai' ? undefined : nativeThinking === 'disabled' ? 'off' : 'high');
\t\t\t\tconst catalogProps = {
\t\t\t\t\tinheritedReasoningDefault,
\t\t\t\t\treasoningFallback: family === 'pi-ai' ? undefined : { status: 'known', source: 'adapter', efforts: (nativeThinking === 'disabled' ? ['off'] : ['off','low','high','max']).map(id => ({ id, name: id })) },''')
    # Validate inherited defaults as well as configured defaults before saving.
    anchor = '\t\t\tconst modelFailure = validateDeepSeekModels(schema.getPath(draft, ["models"]));'
    replacement = '''\t\t\tconst inheritedReasoningDefault = stringAt(draft, layout === 'pi-ai' ? 'reasoning' : 'reasoningEffort') ?? stringAt(fallback, layout === 'pi-ai' ? 'reasoning' : 'reasoningEffort') ?? (layout === 'pi-ai' ? undefined : (stringAt(draft, 'thinking') ?? stringAt(fallback, 'thinking')) === 'disabled' ? 'off' : 'high');
\t\t\tconst nativeDisabled = (stringAt(draft, 'thinking') ?? stringAt(fallback, 'thinking')) === 'disabled';
\t\t\tconst reasoningModels = modelDrafts(schema.getPath(draft, ['models'])).map(model => ({ ...model, reasoningConfig: reasoningConfigForConnection(model.reasoningConfig, stringAt(draft, 'baseURL') ?? stringAt(fallback, 'baseURL'), stringAt(draft, 'api') ?? stringAt(fallback, 'api')) }));
\t\t\tconst modelFailure = validateDeepSeekModels(reasoningModels, layout === 'pi-ai' ? ['off','minimal','low','medium','high','xhigh','max'] : nativeDisabled ? ['off'] : ['off','low','high','max'], inheritedReasoningDefault);'''
    replace_once(files, path, anchor, replacement)
    replace_once(files, path, '\t\t\t\t\tconst failure = validateDeepSeekModels(schema.getPath(next, ["models"]));', '\t\t\t\t\tconst failure = modelFailure;')
    locales = json.loads((SOURCES / 'locales.json').read_text(encoding='utf-8'))
    for language, values in locales.items():
        # Each locale has a unique existing modelName string; insert into that dictionary.
        marker = 'modelName: "Display name",' if language == 'en' else 'modelName: "显示名称",'
        replace_once(files, path, marker, marker + '\n' + ',\n'.join(f'{key}: {json.dumps(value, ensure_ascii=False)}' for key, value in values.items()) + ',')

    # Native providers use the same discovery and capability refresh workflow.
    replace_once(files, path, 'function adopt(candidate) {', 'function adopt(candidate, native = false) {')
    replace_once(files, path, '{ input: [...candidate.inputModalities] }', '{ [native ? "inputModalities" : "input"]: [...candidate.inputModalities] }')
    replace_once(files, path, 'byId.get(candidate.id) ?? adopt(candidate)', 'byId.get(candidate.id) ?? adopt(candidate, props.native)')
    replace_once(files, path, 'inputField: "input",\n', 'inputField: props.native ? "inputModalities" : "input",\n')
    replace_once(files, path, 'reasoningFallback: catalog?.find(candidate => candidate.id === model.id)?.reasoningCapability,', 'reasoningFallback: catalog?.find(candidate => candidate.id === model.id)?.reasoningCapability ?? props.reasoningFallback,')
    replace_once(files, path, 'reasoningEndpoint: probe.baseURL, reasoningApi: probe.api,', 'reasoningAllowedIds: props.native ? props.reasoningFallback?.efforts.map(effort => effort.id) : undefined, reasoningEndpoint: probe.baseURL, reasoningApi: probe.api,')
    replace_once(files, path, 'placeholder: CAPACITY_HINT.contextWindow,', 'placeholder: props.defaultContextWindow === undefined ? CAPACITY_HINT.contextWindow : formatCapacity(props.defaultContextWindow),')
    replace_once(files, path, 'placeholder: CAPACITY_HINT.maxTokens,', 'placeholder: props.defaultMaxTokens === undefined ? CAPACITY_HINT.maxTokens : formatCapacity(props.defaultMaxTokens),')
    replace_once(files, path, 'const catalogProps = {', "const catalogProps = {\n native: family === 'deepseek', operations, probe, catalogProvider: family === 'deepseek' ? props.provider : undefined, onBusyChange: setListBusy,")
    if files[path].count('jsx)(DeepSeekModelsEditor, {') != 2:
        raise ValueError('unexpected native editor entry points')
    files[path] = files[path].replace('jsx)(DeepSeekModelsEditor, {', 'jsx)(ModelListEditor, {')


def patch_selection(files):
    path = "lib/client.js"
    replace_once(files, path, '\t\t\tconst effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort;', '''\t\t\tconst effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort;
\t\t\tconst invalidEffort = state.current?.reasoningEffort !== undefined && currentChoice !== undefined && !reasoning?.efforts.some(effort => effort.id === state.current.reasoningEffort);''')
    # The trigger's effort label offers a correction entry without changing history.
    replace_once(files, path, 'const effortLabel = reasoning === void 0 ?', 'const effortLabel = invalidEffort ? `${state.current.reasoningEffort} — ${t("effort.correctionRequired")}` : reasoning === void 0 ?')
    # Locale maps use quoted dotted keys.
    marker = '"effort.providerDefault": "Default",'
    if files[path].count(marker) != 2:
        raise ValueError('unexpected model-selection locale dictionaries')
    files[path] = files[path].replace(marker, marker + '\n"effort.correctionRequired": "Unavailable; select a supported effort before sending",', 1)
    # Replace the remaining original marker (the first now has an extra key).
    start = files[path].rindex(marker)
    files[path] = files[path][:start] + files[path][start:].replace(marker, marker + '\n"effort.correctionRequired": "已失效；发送前请选择可用推理强度",', 1)


if __name__ == "__main__":
    generate()
