import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { cn } from './ui';

type PopoverPlacement = Readonly<{
  horizontal: 'left' | 'right';
  vertical: 'above' | 'below';
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
  const [placement, setPlacement] = useState<PopoverPlacement>({
    horizontal: 'left',
    vertical: 'below',
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
      const vertical = anchorBounds.bottom + anchorGap + popoverBounds.height > window.innerHeight - viewportInset
        && anchorBounds.top - anchorGap - popoverBounds.height >= viewportInset
        ? 'above'
        : 'below';
      setPlacement((current) => current.horizontal === horizontal && current.vertical === vertical
        ? current
        : { horizontal, vertical });
    };
    const resizeObserver = new ResizeObserver(updatePlacement);

    updatePlacement();
    resizeObserver.observe(popover);
    window.addEventListener('resize', updatePlacement);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', updatePlacement);
    };
  }, [anchorRef, open]);

  useEffect(() => {
    if (!open || !popoverRef.current) return;
    const popover = popoverRef.current;
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
      onCloseRef.current();
    };

    queueMicrotask(focusInitialTarget);
    popover.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handleMouseDown);
    return () => {
      popover.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handleMouseDown);
      const anchor = anchorRef.current;
      if (!anchor?.isConnected) return;
      anchor.focus({ preventScroll: true });
      queueMicrotask(() => {
        if (anchor.isConnected && document.activeElement !== anchor) {
          anchor.focus({ preventScroll: true });
        }
      });
    };
  }, [anchorRef, open]);

  if (!open) return null;

  return (
    <section
      ref={popoverRef}
      role="dialog"
      aria-label={label}
      className={cn(
        'absolute z-40 w-[min(22rem,calc(100vw-2rem))] max-lg:max-w-full rounded-md border border-line bg-surface p-3 shadow-[0_24px_64px_var(--elevation-shadow-color)]',
        placement.horizontal === 'right' ? 'right-0' : 'left-0',
        placement.vertical === 'above' ? 'bottom-full mb-2' : 'top-full mt-2',
        className,
      )}
    >
      {children}
    </section>
  );
}
