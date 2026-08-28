import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react';
import { X } from 'lucide-react';
import { useConfirmBeforeDiscard, useDialogLayer } from './dialog-stack';

const modalViewportInset = 16;
const modalAnchorGap = 8;
const modalAnchoredMinMaxHeight = 16 * 16;
const modalAnchoredTakeoverThreshold = 12 * 16;

export function resolveModalAnchorPlacement(spaceAbove: number, spaceBelow: number) {
  const placement: 'above' | 'below' = spaceAbove > spaceBelow ? 'above' : 'below';
  const maxHeight = Math.max(0, placement === 'above' ? spaceAbove : spaceBelow);

  return {
    placement,
    maxHeight,
    takeover: maxHeight < modalAnchoredTakeoverThreshold,
  };
}

export function cn(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger' | 'mint';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  icon?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
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
  ref,
  ...props
}: ButtonProps) {
  return (
    <button
      ref={ref}
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
  isDirty,
  variant = 'takeover',
  anchorRef,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode | ((requestClose: () => void) => ReactNode);
  className?: string;
  isDirty?: () => boolean;
  variant?: 'takeover' | 'anchored';
  anchorRef?: RefObject<HTMLElement | null>;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const [desktopBreakpointMatches, setDesktopBreakpointMatches] = useState(() => (
    typeof window === 'undefined' || window.matchMedia('(min-width: 640px)').matches
  ));
  const [anchorPosition, setAnchorPosition] = useState({
    top: 16,
    right: 16,
    maxHeight: modalAnchoredMinMaxHeight,
    placement: 'below' as 'above' | 'below',
    takeover: false,
  });
  const anchoredOnDesktop = variant === 'anchored' && desktopBreakpointMatches;
  const anchoredLayout = anchoredOnDesktop && !anchorPosition.takeover;
  const takeoverLayout = !anchoredLayout;
  const { confirmationOpen, requestClose, keepEditing, discard } = useConfirmBeforeDiscard({
    open,
    isDirty,
    onDiscard: onClose,
  });
  const { isTopmost, layerId } = useDialogLayer({
    open,
    onClose: requestClose,
    containerRef: dialogRef,
    lockScroll: takeoverLayout,
  });

  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 640px)');
    const updateBreakpoint = () => setDesktopBreakpointMatches(desktop.matches);
    updateBreakpoint();
    desktop.addEventListener('change', updateBreakpoint);
    return () => desktop.removeEventListener('change', updateBreakpoint);
  }, []);

  useLayoutEffect(() => {
    if (!open || !anchoredOnDesktop || !anchorRef?.current || !dialogRef.current) return;
    const anchor = anchorRef.current;
    const dialog = dialogRef.current;
    const updatePosition = () => {
      const anchorBounds = anchor.getBoundingClientRect();
      const dialogBounds = dialog.getBoundingClientRect();
      const viewportWidth = document.documentElement.clientWidth;
      const desiredRight = viewportWidth - anchorBounds.right;
      const maxRight = Math.max(
        modalViewportInset,
        viewportWidth - dialogBounds.width - modalViewportInset,
      );
      const right = Math.min(maxRight, Math.max(modalViewportInset, desiredRight));
      const spaceBelow = window.innerHeight
        - anchorBounds.bottom
        - modalAnchorGap
        - modalViewportInset;
      const spaceAbove = anchorBounds.top - modalAnchorGap - modalViewportInset;
      const placement = resolveModalAnchorPlacement(spaceAbove, spaceBelow);
      const anchorEdge = placement.placement === 'above' ? anchorBounds.top : anchorBounds.bottom;
      const top = anchorEdge
        + window.scrollY
        + (placement.placement === 'above' ? -modalAnchorGap : modalAnchorGap);
      const next = {
        top: Math.round(top),
        right: Math.round(right),
        maxHeight: Math.floor(placement.maxHeight),
        placement: placement.placement,
        takeover: placement.takeover,
      };
      setAnchorPosition((current) => (
        current.top === next.top
          && current.right === next.right
          && current.maxHeight === next.maxHeight
          && current.placement === next.placement
          && current.takeover === next.takeover
          ? current
          : next
      ));
    };
    const resizeObserver = new ResizeObserver(updatePosition);

    updatePosition();
    resizeObserver.observe(anchor);
    resizeObserver.observe(dialog);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [anchorRef, anchoredOnDesktop, open]);

  useEffect(() => {
    if (!open || !anchoredLayout || !isTopmost) return;
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (dialogRef.current?.contains(target) || anchorRef?.current?.contains(target)) return;
      requestClose();
    };

    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [anchorRef, anchoredLayout, isTopmost, open, requestClose]);

  if (!open) return null;

  const anchorStyle = anchoredLayout
    ? {
        '--modal-anchor-top': `${anchorPosition.top}px`,
        '--modal-anchor-right': `${anchorPosition.right}px`,
        '--modal-anchor-max-height': `${anchorPosition.maxHeight}px`,
      } as CSSProperties
    : undefined;

  return (
    <>
      <div
        className={cn(
          takeoverLayout && 'cicada-scrim-enter fixed inset-0 z-50 flex items-end justify-center bg-ink/55 p-0 backdrop-blur-[3px] sm:items-center sm:p-5',
          !isTopmost && 'pointer-events-none',
        )}
        data-testid={takeoverLayout ? 'modal-scrim' : undefined}
        role={takeoverLayout ? 'presentation' : undefined}
        aria-hidden={isTopmost ? undefined : true}
        onMouseDown={(event) => {
          if (isTopmost && event.target === event.currentTarget) requestClose();
        }}
      >
        <section
          ref={dialogRef}
          role="dialog"
          aria-modal={isTopmost && takeoverLayout ? 'true' : undefined}
          aria-labelledby={`${layerId}-title`}
          tabIndex={-1}
          style={anchorStyle}
          className={cn(
            anchoredLayout
              ? 'cicada-modal-enter flex max-h-[94dvh] w-full flex-col overflow-hidden rounded-t-md border border-line bg-surface shadow-[0_24px_64px_var(--elevation-shadow-color)] sm:absolute sm:right-[var(--modal-anchor-right)] sm:top-[var(--modal-anchor-top)] sm:z-50 sm:max-h-[var(--modal-anchor-max-height)] sm:w-[min(28rem,calc(100vw-2rem))] sm:rounded-md'
              : 'cicada-modal-enter max-h-[94dvh] w-full overflow-y-auto rounded-t-md border border-line bg-surface shadow-[0_24px_64px_var(--elevation-shadow-color)] sm:max-w-lg sm:rounded-md',
            anchoredLayout && anchorPosition.placement === 'above' && 'sm:-translate-y-full',
            className,
          )}
        >
          <header className={anchoredLayout
            ? 'flex shrink-0 items-start justify-between gap-5 border-b border-line bg-canvas/95 px-5 py-4 backdrop-blur sm:px-6'
            : 'sticky top-0 z-10 flex items-start justify-between gap-5 border-b border-line bg-canvas/95 px-5 py-4 backdrop-blur sm:px-6'}>
            <div>
              <h2 id={`${layerId}-title`} className="font-display text-xl font-light tracking-[0.01em]">
                {title}
              </h2>
              {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
            </div>
            <button
              type="button"
              onClick={requestClose}
              className="flex size-10 shrink-0 items-center justify-center rounded-[99px] text-muted transition-[background-color,color,transform] duration-150 ease-out hover:bg-surface hover:text-ink motion-safe:hover:scale-105 motion-safe:active:scale-95"
              aria-label="Close dialog"
            >
              <X size={19} />
            </button>
          </header>
          <div className={anchoredLayout ? 'min-h-0 flex-1 overflow-y-auto' : undefined}>
            {typeof children === 'function' ? children(requestClose) : children}
          </div>
        </section>
      </div>
      <Modal
        open={confirmationOpen}
        onClose={keepEditing}
        title="Discard draft?"
        description="Your unsaved text will be lost."
      >
        <div className="grid gap-2 p-5 sm:grid-cols-2 sm:p-6">
          <Button variant="danger" onClick={discard}>Discard</Button>
          <Button data-dialog-initial-focus onClick={keepEditing}>Keep editing</Button>
        </div>
      </Modal>
    </>
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
