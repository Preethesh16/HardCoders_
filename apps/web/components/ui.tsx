/**
 * Presentation primitives.
 *
 * A small, deliberate component set in the shadcn idiom: Tailwind utility
 * classes composed through `cva`, no runtime theming, no client JavaScript
 * unless a component genuinely needs it.
 */

import { cva, type VariantProps } from 'class-variance-authority';
import type { ReactNode } from 'react';
import { cn } from '@/lib/util';

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <section className={cn('rounded-xl border border-ink-200 bg-white shadow-[0_1px_2px_rgba(19,18,17,0.04)]', className)}>
      {children}
    </section>
  );
}

export function CardHeader({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <header className="flex items-start justify-between gap-4 border-b border-ink-200 px-5 py-4">
      <div>
        <h2 className="text-sm font-semibold tracking-tight text-ink-800">{title}</h2>
        {description ? <p className="mt-1 text-sm text-ink-500">{description}</p> : null}
      </div>
      {action}
    </header>
  );
}

export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('px-5 py-4', className)}>{children}</div>;
}

const badge = cva(
  'inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap',
  {
    variants: {
      tone: {
        neutral: 'bg-ink-100 text-ink-600',
        good: 'bg-good-100 text-good-500',
        warn: 'bg-warn-100 text-warn-500',
        stop: 'bg-stop-100 text-stop-500',
        signal: 'bg-signal-500/10 text-signal-600',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export type BadgeProps = VariantProps<typeof badge> & { children: ReactNode; className?: string };

export function Badge({ tone, children, className }: BadgeProps) {
  return <span className={cn(badge({ tone }), className)}>{children}</span>;
}

/** Maps a workflow state to the one signal colour it deserves. */
export function stateTone(state: string): NonNullable<BadgeProps['tone']> {
  if (['COMPLETED', 'PASSED', 'APPROVED', 'MATCHED', 'ACTIVE', 'USDC_RELEASED', 'PAYOUT_CREDITED'].includes(state)) return 'good';
  if (['BLOCKED', 'DISPUTED', 'REFUNDED', 'MISMATCHED', 'FAILED_RECONCILIATION', 'REVOKED'].includes(state)) return 'stop';
  if (['MANUAL_REVIEW', 'REVISION_REQUIRED', 'PENDING', 'PAUSED'].includes(state)) return 'warn';
  return 'signal';
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string | undefined }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium uppercase tracking-wide text-ink-400">{label}</dt>
      <dd className="mt-1 truncate text-lg font-semibold tabular-nums text-ink-800">{value}</dd>
      {hint ? <p className="mt-0.5 truncate text-xs text-ink-500">{hint}</p> : null}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-ink-100 py-2 last:border-0">
      <span className="shrink-0 text-xs font-medium uppercase tracking-wide text-ink-400">{label}</span>
      <span className="min-w-0 truncate text-right text-sm text-ink-700">{children}</span>
    </div>
  );
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <code className={cn('font-mono text-xs text-ink-600', className)}>{children}</code>;
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-ink-200 px-4 py-8 text-center text-sm text-ink-400">
      {children}
    </p>
  );
}

export function Table({ head, children }: { head: readonly string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[36rem] border-collapse text-sm">
        <thead>
          <tr className="border-b border-ink-200 text-left">
            {head.map((column) => (
              <th key={column} className="px-3 py-2 text-xs font-medium uppercase tracking-wide text-ink-400">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-100">{children}</tbody>
      </table>
    </div>
  );
}

export function Cell({ children, className }: { children: ReactNode; className?: string }) {
  return <td className={cn('px-3 py-2 align-top text-ink-700', className)}>{children}</td>;
}

/** The standing reminder that nothing here is a real financial service. */
export function DemoNotice({ className }: { className?: string }) {
  return (
    <p className={cn('text-xs leading-relaxed text-ink-500', className)}>
      Demonstration only. Not a licensed remittance, payment, KYC, tax or legal service. Every token is a
      zero-value test asset, every fiat balance is simulated, and no end user holds a blockchain key.
    </p>
  );
}
