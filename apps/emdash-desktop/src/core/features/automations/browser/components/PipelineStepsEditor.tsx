import { Button, Input, Label, Select, Switch, Tooltip } from '@emdash/ui/react/primitives';
import { ArrowDown, ArrowUp, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { cn } from '@core/primitives/styling/browser/cn';

export type EditablePipelineStep = {
  id: string;
  name: string;
  providerId: string;
  prompt: string;
  gate: 'auto' | 'manual_approval';
  accountPolicy?: 'any' | 'different-from-previous' | 'same-as-first';
};

interface PipelineStepsEditorProps {
  steps: EditablePipelineStep[];
  onChange: (steps: EditablePipelineStep[]) => void;
  availableProviders: Array<{ id: string; name: string }>;
  disabled?: boolean;
}

export function PipelineStepsEditor({
  steps,
  onChange,
  availableProviders,
  disabled = false,
}: PipelineStepsEditorProps) {
  function handleAddStep() {
    const nextIdx = steps.length + 1;
    const defaultProvider = availableProviders[0]?.id ?? 'claude-empresa';
    const newStep: EditablePipelineStep = {
      id: `step-${Date.now()}`,
      name: `Step ${nextIdx}`,
      providerId: defaultProvider,
      prompt: '',
      gate: 'auto',
      accountPolicy: steps.length > 0 ? 'different-from-previous' : 'any',
    };
    onChange([...steps, newStep]);
  }

  function handleRemoveStep(index: number) {
    const updated = steps.filter((_, i) => i !== index);
    onChange(updated);
  }

  function handleUpdateStep(index: number, patch: Partial<EditablePipelineStep>) {
    const updated = steps.map((s, i) => (i === index ? { ...s, ...patch } : s));
    onChange(updated);
  }

  function handleMoveStep(index: number, direction: 'up' | 'down') {
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= steps.length) return;
    const updated = [...steps];
    const [moved] = updated.splice(index, 1);
    if (!moved) return;
    updated.splice(targetIndex, 0, moved);
    onChange(updated);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-foreground-muted">
          Sequential Pipeline Steps ({steps.length})
        </span>
        <Button
          size="sm"
          variant="secondary"
          onClick={handleAddStep}
          disabled={disabled}
          className="h-7 gap-1 text-xs"
        >
          <Plus className="size-3.5" />
          Add Step
        </Button>
      </div>

      {steps.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border/60 p-6 text-center text-xs text-foreground-muted">
          <p>No steps configured in this pipeline.</p>
          <p className="mt-1 text-[11px] text-foreground-passive">
            Click &quot;Add Step&quot; to configure a multi-agent flow (e.g. Plan &rarr; Code &rarr;
            Review).
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {steps.map((step, idx) => (
            <div
              key={step.id}
              className="flex flex-col gap-2 rounded-md border border-border/60 bg-background-2/40 p-3 transition-colors"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex flex-1 items-center gap-2">
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-background-3 text-[10px] font-semibold text-foreground-muted">
                    {idx + 1}
                  </span>
                  <Input
                    value={step.name}
                    onChange={(e) => handleUpdateStep(idx, { name: e.target.value })}
                    placeholder="Step name (e.g. Architecture Planning)"
                    disabled={disabled}
                    className="h-7 flex-1 text-xs font-medium"
                  />
                </div>

                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    icon
                    disabled={disabled || idx === 0}
                    onClick={() => handleMoveStep(idx, 'up')}
                    aria-label="Move step up"
                  >
                    <ArrowUp className="size-3" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon
                    disabled={disabled || idx === steps.length - 1}
                    onClick={() => handleMoveStep(idx, 'down')}
                    aria-label="Move step down"
                  >
                    <ArrowDown className="size-3" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon
                    disabled={disabled || steps.length <= 1}
                    onClick={() => handleRemoveStep(idx)}
                    aria-label="Remove step"
                    className="text-destructive/80 hover:text-destructive"
                  >
                    <Trash2 className="size-3" />
                  </Button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="flex flex-col gap-1">
                  <Label className="text-[11px] text-foreground-muted">
                    Agent Account / Profile
                  </Label>
                  <Select.Root
                    value={step.providerId}
                    onValueChange={(val) => {
                      if (val) handleUpdateStep(idx, { providerId: val });
                    }}
                    disabled={disabled}
                  >
                    <Select.Trigger className="h-7 text-xs">
                      <Select.Value />
                    </Select.Trigger>
                    <Select.Content>
                      {availableProviders.map((p) => (
                        <Select.Item key={p.id} value={p.id}>
                          {p.name}
                        </Select.Item>
                      ))}
                    </Select.Content>
                  </Select.Root>
                </div>

                <div className="flex flex-col gap-1">
                  <div className="flex items-center justify-between">
                    <Label className="text-[11px] text-foreground-muted">Approval Gate</Label>
                    <span className="text-[10px] text-foreground-passive">
                      {step.gate === 'manual_approval' ? 'Requires Approval' : 'Auto Continue'}
                    </span>
                  </div>
                  <div className="flex h-7 items-center justify-between rounded-md border border-border/40 bg-background-1 px-2">
                    <span className="text-xs text-foreground-muted">Pause after this step</span>
                    <Switch
                      checked={step.gate === 'manual_approval'}
                      onCheckedChange={(checked) =>
                        handleUpdateStep(idx, {
                          gate: checked ? 'manual_approval' : 'auto',
                        })
                      }
                      disabled={disabled}
                    />
                  </div>
                </div>
              </div>

              {idx > 0 && (
                <div className="flex items-center justify-between rounded-md bg-background-1 px-2 py-1 text-xs">
                  <div className="flex items-center gap-1 text-foreground-muted">
                    <ShieldCheck className="text-primary size-3.5" />
                    <span>Account isolation</span>
                    <Tooltip.Root>
                      <Tooltip.Trigger
                        render={
                          <span className="cursor-help text-[10px] text-foreground-passive underline">
                            (info)
                          </span>
                        }
                      />
                      <Tooltip.Content>
                        Enforces that this step cannot run under the same account as the previous
                        step
                      </Tooltip.Content>
                    </Tooltip.Root>
                  </div>
                  <Switch
                    checked={step.accountPolicy === 'different-from-previous'}
                    onCheckedChange={(checked) =>
                      handleUpdateStep(idx, {
                        accountPolicy: checked ? 'different-from-previous' : 'any',
                      })
                    }
                    disabled={disabled}
                  />
                </div>
              )}

              <div className="flex flex-col gap-1">
                <Label className="text-[11px] text-foreground-muted">
                  Step Prompt & Instructions
                </Label>
                <textarea
                  value={step.prompt}
                  onChange={(e) => handleUpdateStep(idx, { prompt: e.target.value })}
                  placeholder="Instructions for this agent..."
                  disabled={disabled}
                  rows={2}
                  className={cn(
                    'w-full resize-y rounded-md border border-border/60 bg-background-1 p-2 text-xs text-foreground outline-none',
                    'placeholder:text-foreground-passive focus:border-primary'
                  )}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
