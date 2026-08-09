import type { ReactNode } from 'react';

export function WorkspaceHeader({
  eyebrow,
  title,
  actions,
}: {
  eyebrow: string;
  title: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex shrink-0 items-start justify-between gap-4 bg-header p-4 sm:p-8">
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-[11px] text-taupe">{eyebrow}</p>
        <h1 data-page-heading tabIndex={-1} className="break-words text-[28px] font-normal tracking-[-0.5px] text-ink">{title}</h1>
      </div>
      {actions ? <div className="flex shrink-0 gap-2">{actions}</div> : null}
    </header>
  );
}
