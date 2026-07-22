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
    'border-teal-500 bg-teal-500 text-ink shadow-[0_1px_0_rgba(255,255,255,.3)_inset] hover:border-teal-600 hover:bg-teal-600',
  secondary:
    'border-line bg-white text-ink shadow-[0_1px_2px_rgba(23,28,36,.05)] hover:border-line-strong hover:bg-card',
  quiet: 'border-transparent bg-transparent text-teal-700 hover:bg-teal-soft hover:text-teal-700',
  danger: 'border-urgent-border bg-white text-urgent hover:border-urgent-border hover:bg-urgent-soft',
  mint: 'border-teal-border bg-teal-soft text-teal-700 hover:border-teal-border hover:bg-teal-soft',
};

const buttonSizes = {
  sm: 'min-h-9 gap-1.5 rounded-[9px] px-3 text-[13px]',
  md: 'min-h-11 gap-2 rounded-[10px] px-4 text-sm',
  lg: 'min-h-12 gap-2.5 rounded-[10px] px-5 text-[15px]',
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
        'inline-flex items-center justify-center border font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45',
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
        'rounded-[14px] border border-line bg-card shadow-[0_1px_2px_rgba(23,28,36,.05),0_10px_26px_rgba(23,28,36,.06)]',
        className,
      )}
    >
      {children}
    </Component>
  );
}

const pillTones = {
  neutral: 'border-line bg-muted-surface text-muted',
  green: 'border-teal-border bg-teal-soft text-teal-700',
  amber: 'border-caution-border bg-caution-soft text-caution',
  red: 'border-urgent-border bg-urgent-soft text-urgent',
  blue: 'border-info-border bg-info-soft text-info',
  purple: 'border-alt-border bg-alt-soft text-alt',
  dark: 'border-white/15 bg-white/10 text-white/85',
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
        'inline-flex min-h-6 items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-semibold leading-none',
        pillTones[tone],
        className,
      )}
    >
      {dot ? <span className="size-1.5 rounded-full bg-current opacity-70" /> : null}
      {children}
    </span>
  );
}

export function Avatar({
  name,
  color = '#d9efec',
  size = 'md',
  human = false,
}: {
  name: string;
  color?: string;
  size?: 'sm' | 'md' | 'lg';
  human?: boolean;
}) {
  const initials = name
    .split(' ')
    .map((part) => part[0])
    .slice(0, 2)
    .join('');

  const sizes = {
    sm: 'size-7 text-[10px]',
    md: 'size-9 text-xs',
    lg: 'size-12 text-sm',
  };

  return (
    <span
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center rounded-[10px] border border-black/10 font-display font-bold text-ink shadow-[0_1px_0_rgba(255,255,255,.55)_inset]',
        sizes[size],
        human && 'rounded-full',
      )}
      style={{ backgroundColor: color }}
      aria-label={name}
    >
      {initials}
    </span>
  );
}

export function ProgressBar({
  value,
  tone = 'green',
  className,
}: {
  value: number;
  tone?: 'green' | 'amber' | 'blue' | 'purple';
  className?: string;
}) {
  const tones = {
    green: 'bg-teal-500',
    amber: 'bg-caution-fill',
    blue: 'bg-info',
    purple: 'bg-alt',
  };

  return (
    <div className={cn('h-1.5 overflow-hidden rounded-full bg-line-soft', className)}>
      <div
        className={cn('h-full rounded-full transition-[width] duration-500', tones[tone])}
        style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
      />
    </div>
  );
}

export function SectionHeading({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-end justify-between gap-4">
      <div>
        <h2 className="font-display text-[17px] font-semibold tracking-[-0.015em] text-ink">
          {title}
        </h2>
        {description ? <p className="mt-0.5 text-sm text-muted">{description}</p> : null}
      </div>
      {action}
    </div>
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
        'fixed inset-0 z-50 flex items-end justify-center bg-scrim/55 p-0 backdrop-blur-[3px] sm:items-center sm:p-5',
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
          'max-h-[94dvh] w-full overflow-y-auto rounded-t-[20px] border border-line bg-white shadow-[0_24px_64px_rgba(23,28,36,.22)] sm:max-w-lg sm:rounded-[18px]',
          className,
        )}
      >
        <header className="sticky top-0 z-10 flex items-start justify-between gap-5 border-b border-line bg-white/95 px-5 py-4 backdrop-blur sm:px-6">
          <div>
            <h2 id={`${layerId}-title`} className="font-display text-xl font-semibold tracking-[-0.02em]">
              {title}
            </h2>
            {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex size-10 shrink-0 items-center justify-center rounded-[10px] text-muted hover:bg-line-soft hover:text-ink"
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
    <label htmlFor={htmlFor} className="mb-1.5 block text-xs font-semibold text-muted">
      {children}
    </label>
  );
}

export const inputClass =
  'min-h-11 w-full rounded-[10px] border border-line bg-white px-3.5 text-sm text-ink shadow-[0_1px_1px_rgba(23,28,36,.03)] placeholder:text-muted hover:border-line-strong focus:border-teal-700 focus:outline-none';
