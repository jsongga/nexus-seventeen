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
  quiet: 'border-transparent bg-transparent text-ink enabled:hover:bg-surface',
  danger: 'border-urgent-border bg-canvas text-urgent enabled:hover:bg-urgent-soft',
  mint: 'border-success-fill/60 bg-success-soft text-success enabled:hover:bg-surface',
};

const buttonSizes = {
  sm: 'min-h-9 gap-1.5 rounded-[99px] px-3 font-mono text-[12px] uppercase tracking-[0.06em]',
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
        'rounded-[2px] border border-line bg-card',
        className,
      )}
    >
      {children}
    </Component>
  );
}

const pillTones = {
  neutral: 'border-line bg-surface text-muted',
  green: 'border-success-fill/60 bg-success-soft text-success',
  amber: 'border-caution-border bg-caution-soft text-caution',
  red: 'border-urgent-border bg-urgent-fill text-white',
  blue: 'border-info-border bg-info-soft text-info',
  purple: 'border-alt-border bg-alt-soft text-alt',
  dark: 'border-line-strong bg-ink-panel text-ink',
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
        'inline-flex min-h-6 items-center gap-1.5 rounded-[2px] border px-2 py-0.5 font-mono text-[10px] font-medium uppercase leading-none tracking-[0.06em]',
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
        'relative inline-flex shrink-0 items-center justify-center rounded-[2px] border border-taupe font-mono font-semibold text-ink',
        sizes[size],
        human && 'border-ink/15',
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
    green: 'bg-success-fill',
    amber: 'bg-caution-fill',
    blue: 'bg-info-border',
    purple: 'bg-alt-border',
  };

  return (
    <div className={cn('h-1.5 overflow-hidden bg-line-soft', className)}>
      <div
        className={cn('h-full transition-[width] duration-500', tones[tone])}
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
        <h2 className="font-display text-lg font-light tracking-[0.01em] text-ink">
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
          'cicada-modal-enter max-h-[94dvh] w-full overflow-y-auto rounded-t-[20px] border border-line bg-surface shadow-[0_24px_64px_rgba(74,69,65,.16)] sm:max-w-lg sm:rounded-[18px]',
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
            className="flex size-10 shrink-0 items-center justify-center rounded-full text-muted transition-[background-color,color,transform] duration-150 ease-out hover:bg-surface hover:text-ink motion-safe:hover:scale-105 motion-safe:active:scale-95"
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

export const inputClass =
  'min-h-11 w-full rounded-xl border border-line bg-surface px-3.5 text-sm text-ink transition-[background-color,border-color,box-shadow] duration-150 ease-out placeholder:text-muted hover:border-taupe-hover focus:border-taupe-hover focus:bg-surface';
