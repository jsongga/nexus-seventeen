import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react';
import { cn, resolveModalAnchorPlacement } from './ui';

type PopoverPlacement = Readonly<{
  horizontal: 'left' | 'right';
  vertical: 'above' | 'below';
  maxHeight: number;
}>;

export function Popover({
  open,
  onClose,
  anchorRef,
  label,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const popoverRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  const restoreFocusOnCloseRef = useRef(false);
  const [placement, setPlacement] = useState<PopoverPlacement>({
    horizontal: 'left',
    vertical: 'below',
    maxHeight: 256,
  });
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    if (!open || !anchorRef.current || !popoverRef.current) return;
    const anchor = anchorRef.current;
    const popover = popoverRef.current;
    const updatePlacement = () => {
      const anchorBounds = anchor.getBoundingClientRect();
      const popoverBounds = popover.getBoundingClientRect();
      const viewportInset = 16;
      const anchorGap = 8;
      const horizontal = anchorBounds.left + popoverBounds.width > window.innerWidth - viewportInset
        && anchorBounds.right - popoverBounds.width >= viewportInset
        ? 'right'
        : 'left';
      const anchorPlacement = resolveModalAnchorPlacement(
        anchorBounds.top - anchorGap - viewportInset,
        window.innerHeight - anchorBounds.bottom - anchorGap - viewportInset,
      );
      const vertical = anchorPlacement.placement;
      const maxHeight = Math.max(0, Math.floor(anchorPlacement.maxHeight));
      setPlacement((current) => current.horizontal === horizontal
        && current.vertical === vertical
        && current.maxHeight === maxHeight
        ? current
        : { horizontal, vertical, maxHeight });
    };
    const resizeObserver = new ResizeObserver(updatePlacement);

    updatePlacement();
    resizeObserver.observe(anchor);
    resizeObserver.observe(popover);
    window.addEventListener('resize', updatePlacement);
    window.addEventListener('scroll', updatePlacement, true);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', updatePlacement);
      window.removeEventListener('scroll', updatePlacement, true);
    };
  }, [anchorRef, open]);

  useEffect(() => {
    if (!open || !popoverRef.current) return;
    const popover = popoverRef.current;
    restoreFocusOnCloseRef.current = false;
    const focusInitialTarget = () => {
      popover.querySelector<HTMLElement>('[data-popover-initial-focus]')?.focus({ preventScroll: true });
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
    };
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (popover.contains(target) || anchorRef.current?.contains(target)) return;
      restoreFocusOnCloseRef.current = false;
      onCloseRef.current();
    };
    const handleFocusIn = (event: FocusEvent) => {
      restoreFocusOnCloseRef.current = event.target instanceof Node && popover.contains(event.target);
    };

    queueMicrotask(focusInitialTarget);
    popover.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('focusin', handleFocusIn);
    return () => {
      popover.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('focusin', handleFocusIn);
      if (!restoreFocusOnCloseRef.current) return;
      const anchor = anchorRef.current;
      if (!anchor?.isConnected) return;
      anchor.focus({ preventScroll: true });
      queueMicrotask(() => {
        if (anchor.isConnected && document.activeElement !== anchor) {
          anchor.focus({ preventScroll: true });
        }
      });
      restoreFocusOnCloseRef.current = false;
    };
  }, [anchorRef, open]);

  if (!open) return null;

  return (
    <section
      ref={popoverRef}
      role="dialog"
      aria-label={label}
      style={{ maxHeight: `${placement.maxHeight}px` } as CSSProperties}
      className={cn(
        'absolute z-40 flex w-[min(22rem,calc(100vw-2rem))] max-lg:max-w-full flex-col overflow-hidden rounded-md border border-line bg-surface shadow-[0_24px_64px_var(--elevation-shadow-color)]',
        placement.horizontal === 'right' ? 'right-0' : 'left-0',
        placement.vertical === 'above' ? 'bottom-full mb-2' : 'top-full mt-2',
        className,
      )}
    >
      <div className="min-h-0 overflow-y-auto p-3">{children}</div>
    </section>
  );
}
