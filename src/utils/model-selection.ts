/**
 * Shared utilities for model selection UI
 */

import type * as p from '@clack/prompts';

export interface ModelOption {
  handle: string;
  name: string;
  display_name?: string;
  tier?: string;
}

const TIER_LABELS: Record<string, string> = {
  'free': '🆓 Free',
  'premium': '⭐ Premium',
  'per-inference': '💰 Pay-per-use',
};

const BYOK_LABEL = '🔑 BYOK';

/**
 * Build model selection options
 * Returns array ready for @clack/prompts select()
 */
export async function buildModelOptions(): Promise<Array<{ value: string; label: string; hint: string }>> {
  const { listModels } = await import('../tools/letta-api.js');
  
  // Fetch both base and BYOK models
  const [baseModels, byokModels] = await Promise.all([
    listModels({ providerCategory: 'base' }),
    listModels({ providerCategory: 'byok' }),
  ]);
  
  // Sort base models: free first, then premium, then per-inference
  const sortedBase = baseModels.sort((a, b) => {
    const tierOrder = ['free', 'premium', 'per-inference'];
    return tierOrder.indexOf(a.tier || 'free') - tierOrder.indexOf(b.tier || 'free');
  });
  
  // Sort BYOK models alphabetically
  const sortedByok = byokModels.sort((a, b) => 
    (a.display_name || a.name).localeCompare(b.display_name || b.name)
  );
  
  const result: Array<{ value: string; label: string; hint: string }> = [];
  
  // Add base models
  result.push(...sortedBase.map(m => ({
    value: m.handle,
    label: m.display_name || m.name,
    hint: TIER_LABELS[m.tier || 'free'] || '',
  })));
  
  // Add top 3 BYOK models inline
  result.push(...sortedByok.map(m => ({
    value: m.handle,
    label: m.display_name || m.name,
    hint: BYOK_LABEL,
  })));
  
  // Add custom option
  result.push({ 
    value: '__custom__', 
    label: 'Custom model', 
    hint: 'Enter handle: provider/model-name' 
  });
  
  return result;
}



/**
 * Handle model selection including custom input
 * Returns the selected model handle or null if cancelled/header selected
 */
export async function handleModelSelection(
  selection: string | symbol,
  promptFn: typeof p.text,
): Promise<string | null> {
  // Handle cancellation
  const p = await import('@clack/prompts');
  if (p.isCancel(selection)) return null;
  
  // Handle custom model input
  if (selection === '__custom__') {
    const custom = await promptFn({
      message: 'Model handle',
      placeholder: 'provider/model-name (e.g., anthropic/claude-sonnet-4-5-20250929)',
    });
    if (p.isCancel(custom) || !custom) return null;
    return custom as string;
  }
  
  // Regular model selection
  return selection as string;
}
