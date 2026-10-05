/** An exact Provider/model capability declaration; never a global effort enum. */
export interface ModelReasoningCapability {
  status: 'known' | 'unknown' | 'unsupported';
  source: 'endpoint' | 'catalog' | 'adapter';
  authoritative?: boolean;
  endpoint?: string;
  api?: string;
  efforts: ModelReasoningCandidate[];
}
export interface ModelReasoningCandidate {
  id: string;
  name: string;
  wireValue?: string | null;
}
export interface ModelReasoningConfig {
  capability?: ModelReasoningCapability;
  manualEfforts?: ModelReasoningCandidate[];
  manualAcknowledged?: boolean;
  selected: string[];
  /** Omission inherits the existing adapter or Provider default. */
  defaultEffort?: string;
}
export declare function reasoningCandidates(config?: ModelReasoningConfig, fallback?: ModelReasoningCandidate[]): ModelReasoningCandidate[];
export declare function reasoningConfigForConnection(config: ModelReasoningConfig | undefined, endpoint?: string, api?: string): ModelReasoningConfig | undefined;
export declare function reasoningManualConflict(config?: ModelReasoningConfig): boolean;
export declare function refreshReasoningConfig(config: ModelReasoningConfig | undefined, capability: ModelReasoningCapability | undefined): ModelReasoningConfig | undefined;
export declare function reasoningConfigError(config?: ModelReasoningConfig, allowedIds?: readonly string[], inheritedDefault?: string): string | undefined;
export declare function selectedReasoningInfo<Id extends string>(config: ModelReasoningConfig | undefined, reasoning: { efforts: { id: Id; name: string }[]; defaultEffort?: Id } | undefined): { efforts: { id: Id; name: string }[]; defaultEffort?: Id } | undefined;
export declare function configuredReasoningEffort(config: ModelReasoningConfig | undefined, inheritedDefault: string | undefined, explicit: string | undefined, provider: string, model: string, allowedIds?: readonly string[]): string | undefined;
export declare function endpointReasoningCapability(entry: unknown, allowedIds: readonly string[]): ModelReasoningCapability;
