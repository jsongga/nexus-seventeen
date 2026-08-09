import { useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useDialogLayer } from './dialog-stack';

export function cn(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger' | 'mint';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  icon?: ReactNode;
}

const buttonVariants: Record<ButtonVariant, string> = {
  primary:
    'border-taupe bg-taupe text-white enabled:hover:border-taupe-hover enabled:hover:bg-taupe-hover',
  secondary:
    'border-line bg-surface text-ink enabled:hover:border-line-strong enabled:hover:bg-muted-surface',
  quiet: 'border-transparent bg-transparent text-ink enabled:hover:bg-muted-surface',
  danger: 'border-urgent-border bg-canvas text-urgent enabled:hover:bg-urgent-soft',
  mint: 'border-success-fill/60 bg-success-soft text-success enabled:hover:bg-surface',
};

const buttonSizes = {
  sm: 'min-h-9 gap-1.5 rounded-[99px] px-3 text-[12px]',
  md: 'min-h-11 gap-2 rounded-[99px] px-4 text-sm',
  lg: 'min-h-12 gap-2.5 rounded-[99px] px-5 text-[15px]',
};

export function Button({
  className,
  variant = 'secondary',
  size = 'md',
  icon,
  children,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex items-center justify-center border font-medium transition-[background-color,border-color,color,box-shadow,transform] duration-150 ease-out motion-safe:hover:-translate-y-px motion-safe:active:translate-y-0 motion-safe:active:scale-[0.98] disabled:transform-none disabled:cursor-not-allowed disabled:opacity-45',
        buttonVariants[variant],
        buttonSizes[size],
        className,
      )}
      {...props}
    >
      {icon}
      {children}
    </button>
  );
}

export function Card({
  children,
  className,
  as: Component = 'div',
}: {
  children: ReactNode;
  className?: string;
  as?: 'div' | 'section' | 'article';
}) {
  return (
    <Component
      className={cn(
        'rounded-sm border border-line bg-card',
        className,
      )}
    >
      {children}
    </Component>
  );
}

const pillTones = {
  neutral: 'bg-muted-surface text-muted',
  green: 'bg-success-soft text-success',
  amber: 'bg-caution-soft text-caution',
  red: 'bg-urgent-fill text-white',
  blue: 'bg-info-soft text-info',
  purple: 'bg-alt-soft text-alt',
};

export function Pill({
  children,
  tone = 'neutral',
  dot,
  className,
}: {
  children: ReactNode;
  tone?: keyof typeof pillTones;
  dot?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-[6px] px-2 py-1 text-[11px] font-medium',
        pillTones[tone],
        className,
      )}
    >
      {dot ? <span className="size-1.5 rounded-full bg-current opacity-70" /> : null}
      {children}
    </span>
  );
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const { isTopmost, layerId } = useDialogLayer({
    open,
    onClose,
    containerRef: dialogRef,
  });

  if (!open) return null;

  return (
    <div
      className={cn(
        'cicada-scrim-enter fixed inset-0 z-50 flex items-end justify-center bg-ink/55 p-0 backdrop-blur-[3px] sm:items-center sm:p-5',
        !isTopmost && 'pointer-events-none',
      )}
      role="presentation"
      aria-hidden={isTopmost ? undefined : true}
      onMouseDown={(event) => {
        if (isTopmost && event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal={isTopmost ? 'true' : undefined}
        aria-labelledby={`${layerId}-title`}
        tabIndex={-1}
        className={cn(
          'cicada-modal-enter max-h-[94dvh] w-full overflow-y-auto rounded-t-md border border-line bg-surface shadow-[0_24px_64px_var(--elevation-shadow-color)] sm:max-w-lg sm:rounded-md',
          className,
        )}
      >
        <header className="sticky top-0 z-10 flex items-start justify-between gap-5 border-b border-line bg-canvas/95 px-5 py-4 backdrop-blur sm:px-6">
          <div>
            <h2 id={`${layerId}-title`} className="font-display text-xl font-light tracking-[0.01em]">
              {title}
            </h2>
            {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex size-10 shrink-0 items-center justify-center rounded-[99px] text-muted transition-[background-color,color,transform] duration-150 ease-out hover:bg-surface hover:text-ink motion-safe:hover:scale-105 motion-safe:active:scale-95"
            aria-label="Close dialog"
          >
            <X size={19} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

export function FieldLabel({ children, htmlFor }: { children: ReactNode; htmlFor: string }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-xs font-medium text-ink">
      {children}
    </label>
  );
}

export function Toast({
  children,
  onDismiss,
  dismissLabel = 'Dismiss error',
  className,
}: {
  children: ReactNode;
  onDismiss: () => void;
  dismissLabel?: string;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        'rounded-md border border-urgent/25 bg-urgent-soft px-4 py-3 text-sm text-urgent shadow-[0_12px_34px_rgba(23,28,36,.18)]',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 break-words leading-5">{children}</div>
        <button
          type="button"
          className="-mr-1 -mt-1 flex size-10 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-urgent/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-urgent"
          onClick={onDismiss}
          aria-label={dismissLabel}
        >
          <X size={17} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

export function InlineActionErrors({
  errors,
  onDismiss,
  className,
}: {
  errors: readonly { context: string; error: string }[];
  onDismiss: (context: string) => void;
  className?: string;
}) {
  if (errors.length === 0) return null;
  return (
    <div className={cn('space-y-2', className)}>
      {errors.map((entry) => (
        <div key={entry.context} className="rounded-md border border-urgent/20 bg-urgent-soft px-3.5 py-3 text-sm text-urgent" role="alert">
          <div className="flex items-start justify-between gap-3">
            <span className="min-w-0 flex-1 leading-5">{entry.error}</span>
            <button
              type="button"
              className="-mr-1 -mt-1 flex size-9 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-urgent/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-urgent"
              onClick={() => onDismiss(entry.context)}
              aria-label="Dismiss error"
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

export const inputClass =
  'min-h-11 w-full rounded-xl border border-line bg-surface px-3.5 text-sm text-ink transition-[background-color,border-color,box-shadow] duration-150 ease-out placeholder:text-muted hover:border-taupe-hover focus:border-taupe-hover focus:bg-surface';
