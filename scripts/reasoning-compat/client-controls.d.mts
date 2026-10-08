import type { ModelReasoningCapability, ModelReasoningConfig } from './types.js';

export interface ModelReasoningControlsProps {
  model: { id: string; reasoningConfig?: ModelReasoningConfig; reasoningEfforts?: false | Record<string, string | null> };
  position: number;
  disabled?: boolean;
  native?: boolean;
  allowedIds?: string[];
  fallback?: ModelReasoningCapability;
  inheritedDefault?: string;
  endpoint?: string;
  api?: string;
  t: (key: string) => string;
  onChange: (model: ModelReasoningControlsProps['model']) => void;
}
/** The caller supplies React so the maintained source has no runtime dependency. */
export declare function createModelReasoningControls<Element>(react: {
  createElement: (...args: never[]) => Element;
}): (props: ModelReasoningControlsProps) => Element;
