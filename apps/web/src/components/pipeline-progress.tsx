'use client';

import { STEP_STATUS_TONE, cn, formatDuration } from '@/lib/format';
import {
  PIPELINE_STEP_ORDER,
  STEP_LABELS,
  type PipelineStepRun,
  type ResearchRun,
  type StepId,
} from '@frp/schemas';
import { Dot, Mono } from '@/components/ui/primitives';

/**
 * Pipeline visualisation.
 *
 * Both views render recorded backend state — `pipeline_step_runs` rows — and
 * nothing else. There is no timer-driven animation and no interpolated
 * percentage: a step is drawn as running because the worker said so, and it
 * stops looking like that when the worker says otherwise.
 */

const TONE_BG: Record<string, string> = {
  ok: 'bg-[var(--color-ok)]',
  warn: 'bg-[var(--color-warn)]',
  danger: 'bg-[var(--color-danger)]',
  info: 'bg-[var(--color-info)]',
  idle: 'bg-[var(--color-line-strong)]',
};

/**
 * Dashboard-row progress.
 *
 * Derived from the run record alone (`currentStep` + `status`) so a table of
 * fifty jobs costs zero extra requests.
 */
export function PipelineProgress({ run }: { run: ResearchRun }) {
  const currentIndex = run.currentStep ? PIPELINE_STEP_ORDER.indexOf(run.currentStep) : -1;
  const finished = run.status === 'completed';
  const failed = run.status === 'failed';

  return (
    <div className="flex items-center gap-2">
      <div
        className="flex flex-1 gap-[2px]"
        role="img"
        aria-label={`Pipeline step ${currentIndex + 1} of ${PIPELINE_STEP_ORDER.length}`}
      >
        {PIPELINE_STEP_ORDER.map((stepId, index) => {
          const done = finished || (currentIndex >= 0 && index < currentIndex);
          const active = !finished && index === currentIndex;
          return (
            <span
              key={stepId}
              title={STEP_LABELS[stepId]}
              className={cn(
                'h-[5px] flex-1',
                done && TONE_BG.ok,
                active && failed && TONE_BG.danger,
                active && !failed && cn(TONE_BG.info, run.status === 'running' && 'pulse'),
                active && run.status === 'review_required' && TONE_BG.warn,
                !done && !active && TONE_BG.idle,
              )}
            />
          );
        })}
      </div>
      <span className="tnum w-[86px] shrink-0 text-[10px] text-[var(--color-ink-faint)]">
        {finished
          ? 'all steps'
          : run.currentStep
            ? `${currentIndex + 1}/${PIPELINE_STEP_ORDER.length} ${run.currentStep}`
            : 'queued'}
      </span>
    </div>
  );
}

/** Full vertical timeline shown on the run page. */
export function PipelineTimeline({
  steps,
  activeStep,
}: {
  steps: PipelineStepRun[];
  activeStep: StepId | null;
}) {
  return (
    <ol className="flex flex-col">
      {steps.map((step, index) => {
        const tone = STEP_STATUS_TONE[step.status];
        const isLast = index === steps.length - 1;
        const metrics = step.metrics;

        return (
          <li key={step.stepId} className="relative flex gap-3 px-3 py-2">
            {/* Connector rail */}
            {!isLast ? (
              <span
                className="absolute top-[22px] bottom-[-2px] left-[17px] w-px bg-[var(--color-line)]"
                aria-hidden
              />
            ) : null}

            <span className="relative z-10 mt-[3px] flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border border-[var(--color-line-strong)] bg-[var(--color-base)]">
              <Dot tone={tone} pulse={step.status === 'running'} />
            </span>

            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <span
                  className={cn(
                    'text-[12px]',
                    step.status === 'pending'
                      ? 'text-[var(--color-ink-faint)]'
                      : 'text-[var(--color-ink)]',
                    activeStep === step.stepId && 'font-medium',
                  )}
                >
                  {STEP_LABELS[step.stepId]}
                </span>
                <span className="tnum shrink-0 text-[10px] text-[var(--color-ink-faint)]">
                  {step.status === 'pending' ? '' : formatDuration(metrics?.durationMs ?? null)}
                </span>
              </div>

              <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-[var(--color-ink-faint)]">
                <span className="uppercase tracking-wide">{step.status}</span>
                {step.attempt > 1 ? (
                  <span className="text-[var(--color-warn)]">
                    attempt {step.attempt}/{step.maxAttempts}
                  </span>
                ) : null}
                {metrics && metrics.itemsIn > 0 ? <span>in {metrics.itemsIn}</span> : null}
                {metrics && metrics.itemsOut > 0 ? <span>out {metrics.itemsOut}</span> : null}
                {metrics && metrics.itemsFailed > 0 ? (
                  <span className="text-[var(--color-warn)]">failed {metrics.itemsFailed}</span>
                ) : null}
                {metrics && metrics.providerCalls > 0 ? (
                  <span>{metrics.providerCalls} calls</span>
                ) : null}
              </div>

              {step.error ? (
                <p className="mt-1 border-l-2 border-[var(--color-danger)] bg-[var(--color-danger)]/5 py-1 pl-2 text-[11px] text-[var(--color-danger)]">
                  <Mono>{step.error.code}</Mono> {step.error.message}
                </p>
              ) : null}

              {step.warnings.length > 0 ? (
                <ul className="mt-1 flex flex-col gap-0.5 border-l-2 border-[var(--color-warn)] py-0.5 pl-2">
                  {step.warnings.slice(0, 4).map((warning, i) => (
                    <li key={i} className="text-[11px] text-[var(--color-warn)]">
                      {warning}
                    </li>
                  ))}
                  {step.warnings.length > 4 ? (
                    <li className="text-[10px] text-[var(--color-ink-faint)]">
                      +{step.warnings.length - 4} more
                    </li>
                  ) : null}
                </ul>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
