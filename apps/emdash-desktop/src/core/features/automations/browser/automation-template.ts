import type { LucideIcon } from 'lucide-react';
import type { TriggerConfig } from '@core/primitives/automations/api';

export type BuiltinAutomationTemplateStep = {
  id?: string;
  name: string;
  providerId: string;
  initialPrompt: string;
  gate?: 'auto' | 'manual_approval';
  accountPolicy?: 'any' | 'different-from-previous' | 'same-as-first';
  model?: string;
};

export type BuiltinAutomationTemplate = {
  id: string;
  category: string;
  name: string;
  description: string;
  icon: LucideIcon;
  defaultTrigger: TriggerConfig;
  defaultConversationConfig: {
    initialPrompt: string;
  };
  pipelineSteps?: BuiltinAutomationTemplateStep[];
};
