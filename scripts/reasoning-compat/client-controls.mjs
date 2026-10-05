import { reasoningCandidates, refreshReasoningConfig, reasoningConfigError, reasoningManualConflict, reasoningConfigForConnection } from './policy.mjs';

/** Accessible model settings component using the caller's React runtime. */
export function createModelReasoningControls(react) {
  return function ModelReasoningControls({ model, position, disabled, native, allowedIds, fallback, inheritedDefault, endpoint, api, t, onChange }) {
    const h = react.createElement;
    const [newId, setNewId] = react.useState('high');
    const [newWire, setNewWire] = react.useState('high');
    const allowed = native ? allowedIds ?? ['off', 'low', 'high', 'max'] : ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    const manualId = allowed.includes(newId) ? newId : allowed[0] ?? 'high';
    const legacy = model.reasoningEfforts;
    const legacyEfforts = legacy && typeof legacy === 'object'
      ? Object.entries(legacy).map(([id, wireValue]) => ({ id, name: id, wireValue })) : undefined;
    const boundConfig = reasoningConfigForConnection(model.reasoningConfig, endpoint, api);
    const savedConfig = native && fallback !== undefined && (fallback.source === 'endpoint' || boundConfig?.capability?.source !== 'endpoint')
      ? refreshReasoningConfig(boundConfig, { ...fallback, authoritative: true }) : boundConfig;
    const capability = savedConfig?.capability ?? (legacy === false ? { status: 'unsupported', source: 'adapter', efforts: [] } : fallback) ?? { status: 'unknown', source: 'adapter', efforts: [] };
    const initial = refreshReasoningConfig(undefined, capability) ?? { capability, selected: [] };
    const config = savedConfig ?? (legacyEfforts === undefined ? initial : {
      ...initial, manualEfforts: legacyEfforts, manualAcknowledged: true, selected: legacyEfforts.map(effort => effort.id),
    });
    const candidates = reasoningCandidates(config);
    const selected = config.selected;
    const error = reasoningConfigError(config, allowed, inheritedDefault);
    const save = next => onChange({ ...model, reasoningConfig: next });
    const invalid = selected.filter(id => !candidates.some(effort => effort.id === id));
    const configured = capability.status === 'known' || config.manualEfforts !== undefined;
    const choice = (effort, retired = false) => h('label', { key: effort.id, style: { display: 'inline-flex', gap: '6px', alignItems: 'center' } },
      h('input', {
        type: 'checkbox', 'aria-label': `${t('reasoning')} ${effort.name} ${position}`,
        disabled: disabled || retired && !selected.includes(effort.id), checked: selected.includes(effort.id),
        onChange: event => save({ ...config, selected: event.target.checked ? [...selected, effort.id] : selected.filter(id => id !== effort.id) }),
      }), effort.name, retired ? ` (${t('reasoningUnavailable')})` : null);
    return h('fieldset', { disabled, style: { gridColumn: '1 / -1', border: 'none', margin: 0, padding: '6px 0', display: 'grid', gap: '8px' }, 'aria-label': `${t('reasoning')} ${position}` },
      h('legend', null, t('reasoning')),
      h('p', { style: { margin: 0, fontSize: '12px' } }, config.manualEfforts !== undefined ? t('reasoningManualSource') : t(`reasoningSource${capability.source}`)),
      capability.status === 'unknown' && config.manualEfforts === undefined ? h('p', { role: 'status' }, t('reasoningUnknown')) : null,
      capability.status === 'unsupported' && config.manualEfforts === undefined ? h('p', { role: 'status' }, t('reasoningUnsupported')) : null,
      configured ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '12px' } },
        ...candidates.map(effort => choice(effort)), ...invalid.map(id => choice({ id, name: id }, true))) : null,
      configured ? h('button', { type: 'button', disabled, onClick: () => save({ ...config, selected: candidates.map(effort => effort.id) }) }, t('reasoningSelectAll')) : null,
      configured ? h('label', null, t('reasoningDefault'), ' ', h('select', {
        'aria-label': `${t('reasoningDefault')} ${position}`, value: config.defaultEffort ?? '', disabled,
        onChange: event => {
          const next = { ...config };
          if (event.target.value) next.defaultEffort = event.target.value;
          else delete next.defaultEffort;
          save(next);
        },
      }, h('option', { value: '' }, t('reasoningServiceDefault')),
      ...(config.defaultEffort && !selected.includes(config.defaultEffort) ? [h('option', { value: config.defaultEffort, key: 'invalid', disabled: true }, `${config.defaultEffort} (${t('reasoningUnavailable')})`)] : []),
      ...candidates.filter(effort => selected.includes(effort.id)).map(effort => h('option', { value: effort.id, key: effort.id }, effort.name)))) : null,
      h('p', { style: { margin: 0, fontSize: '12px' } }, t('reasoningDefaultHint')),
      config.manualEfforts === undefined ? h('button', { type: 'button', disabled, onClick: () => save({ ...config, manualEfforts: [...candidates], manualAcknowledged: false }) }, t('reasoningConfigureManual')) : h(react.Fragment, null,
      ...candidates.map(effort => h('button', { key: effort.id, type: 'button', disabled, onClick: () => save({ ...config,
        manualEfforts: candidates.filter(candidate => candidate.id !== effort.id),
        selected: selected.filter(id => id !== effort.id), manualAcknowledged: false,
      }) }, `${t('reasoningRemoveManual')} ${effort.name}`)),
        h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
          h('select', { 'aria-label': `${t('reasoningManualId')} ${position}`, value: manualId, onChange: event => { setNewId(event.target.value); setNewWire(event.target.value); } }, ...allowed.map(id => h('option', { value: id, key: id }, id))),
          native || manualId === 'off' ? null : h('input', { 'aria-label': `${t('reasoningWireValue')} ${position}`, value: newWire, onChange: event => setNewWire(event.target.value) }),
          h('button', { type: 'button', disabled: disabled || manualId !== 'off' && !newWire.trim(), onClick: () => {
            const effort = { id: manualId, name: manualId, wireValue: manualId === 'off' && !native ? null : native ? manualId : newWire.trim() };
            const manualEfforts = [...candidates.filter(item => item.id !== manualId), effort];
            save({ ...config, manualEfforts, selected: [...new Set([...selected, manualId])], manualAcknowledged: false });
          } }, t('reasoningAddManual'))),
        h('button', { type: 'button', disabled, onClick: () => {
          const next = { ...config, selected: selected.filter(id => capability.efforts.some(effort => effort.id === id)) };
          delete next.manualEfforts;
          delete next.manualAcknowledged;
          save(next);
        } }, t('reasoningUseAutomatic')),
        reasoningManualConflict(config) && !config.manualAcknowledged
          ? h('button', { type: 'button', disabled, onClick: () => save({ ...config, manualAcknowledged: true }) }, t('reasoningKeepManual')) : null),
      error === undefined ? null : h('p', { role: 'alert' }, t(error.includes('default') ? 'reasoningDefaultInvalid' : 'modelReasoningInvalid')),
    );
  };
}
