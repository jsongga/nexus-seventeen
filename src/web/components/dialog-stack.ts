import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type RefObject } from "react";

type DialogDismissalDecision = "close" | "confirm";

export type DialogSwitchTarget = string;

const dialogSwitchEvents = new WeakMap<Event, DialogSwitchTarget>();

/** Records which dialog owner already routed a trigger click in its React handler. */
export function markDialogSwitchEvent(event: Event | undefined, target: DialogSwitchTarget): void {
  if (event) dialogSwitchEvents.set(event, target);
}

export function dialogSwitchWasHandledForLayer(event: Event, layer: DialogSwitchTarget): boolean {
  return dialogSwitchEvents.get(event) === layer;
}

/** Lets React route a trigger click before the originating dialog acts on it. */
export function deferDialogOutsideDismissal(event: Event, layer: DialogSwitchTarget, onDismiss: () => void): void {
  queueMicrotask(() => {
    if (!dialogSwitchWasHandledForLayer(event, layer)) onDismiss();
  });
}

export function fieldsAreDirty(values: readonly string[]): boolean {
  return values.some((value) => value.length > 0);
}

/** Evaluates lazily so a dialog always protects the text visible at dismissal time. */
export function dialogDismissalDecision(isDirty?: () => boolean): DialogDismissalDecision {
  return isDirty?.() ? "confirm" : "close";
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

interface DialogLayerRecord {
  id: string;
  lockScroll: boolean;
}

let layers: DialogLayerRecord[] = [];
let priorBodyOverflow: string | undefined;
let deferredRestoreTarget: HTMLElement | null = null;
const listeners = new Set<() => void>();

function emitLayerChange() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function topLayer() {
  return layers.at(-1)?.id ?? null;
}

export function dialogLayersLockScroll(lockScrollByLayer: readonly boolean[]): boolean {
  return lockScrollByLayer.some(Boolean);
}

function syncBodyScrollLock() {
  const shouldLock = dialogLayersLockScroll(layers.map((layer) => layer.lockScroll));
  if (shouldLock && priorBodyOverflow === undefined) {
    priorBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return;
  }
  if (!shouldLock && priorBodyOverflow !== undefined) {
    document.body.style.overflow = priorBodyOverflow;
    priorBodyOverflow = undefined;
  }
}

function addLayer(id: string, lockScroll: boolean) {
  if (layers.some((layer) => layer.id === id)) return;
  layers = [...layers, { id, lockScroll }];
  syncBodyScrollLock();
  emitLayerChange();
}

function updateLayerScrollLock(id: string, lockScroll: boolean) {
  const layer = layers.find((candidate) => candidate.id === id);
  if (!layer || layer.lockScroll === lockScroll) return;
  layers = layers.map((candidate) => (candidate.id === id ? { ...candidate, lockScroll } : candidate));
  syncBodyScrollLock();
}

function removeLayer(id: string) {
  if (!layers.some((layer) => layer.id === id)) return;
  layers = layers.filter((layer) => layer.id !== id);
  syncBodyScrollLock();
  emitLayerChange();
}

function focusableElements(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) =>
      !element.hidden && element.getAttribute("aria-hidden") !== "true" && element.getClientRects().length > 0
  );
}

interface DialogLayerOptions {
  open: boolean;
  onClose: () => void;
  containerRef: RefObject<HTMLElement | null>;
  lockScroll?: boolean;
  trapFocus?: boolean;
}

interface ConfirmBeforeDiscardOptions {
  open: boolean;
  isDirty?: () => boolean;
  onDiscard: () => void;
}

/** Routes every opt-in dismissal through the same dirty-state decision. */
export function useConfirmBeforeDiscard({ open, isDirty, onDiscard }: ConfirmBeforeDiscardOptions) {
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const isDirtyRef = useRef(isDirty);
  const onDiscardRef = useRef(onDiscard);
  isDirtyRef.current = isDirty;
  onDiscardRef.current = onDiscard;

  useEffect(() => {
    if (!open) setConfirmationOpen(false);
  }, [open]);

  const requestClose = useCallback(() => {
    if (dialogDismissalDecision(isDirtyRef.current) === "confirm") {
      setConfirmationOpen(true);
      return;
    }
    onDiscardRef.current();
  }, []);

  const keepEditing = useCallback(() => setConfirmationOpen(false), []);
  const discard = useCallback(() => {
    setConfirmationOpen(false);
    onDiscardRef.current();
  }, []);

  return { confirmationOpen, requestClose, keepEditing, discard };
}

/** Shared keyboard, focus, and stacking behavior for sibling/stacked dialogs. */
export function useDialogLayer({
  open,
  onClose,
  containerRef,
  lockScroll = true,
  trapFocus = true,
}: DialogLayerOptions) {
  const reactId = useId().replace(/:/g, "");
  const layerId = `dialog-${reactId}`;
  const onCloseRef = useRef(onClose);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const receivedInitialFocusRef = useRef(false);
  const wasOpenRef = useRef(false);
  const lockScrollRef = useRef(lockScroll);
  onCloseRef.current = onClose;
  lockScrollRef.current = lockScroll;

  // Capture during render, before React commits a descendant's `autoFocus`.
  // A passive effect is too late and would remember the dialog input itself.
  if (open && !wasOpenRef.current && typeof document !== "undefined") {
    previouslyFocusedRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }
  wasOpenRef.current = open;

  const currentTopLayer = useSyncExternalStore(subscribe, topLayer, topLayer);
  const isTopmost = open && currentTopLayer === layerId;

  useEffect(() => {
    if (!open) {
      receivedInitialFocusRef.current = false;
      return;
    }

    addLayer(layerId, lockScrollRef.current);

    return () => {
      const wasTopmost = topLayer() === layerId;
      const restoreTarget = previouslyFocusedRef.current;
      if (!wasTopmost && restoreTarget?.isConnected) {
        deferredRestoreTarget = restoreTarget;
      }
      removeLayer(layerId);
      const target =
        restoreTarget?.isConnected === true
          ? restoreTarget
          : deferredRestoreTarget?.isConnected === true
            ? deferredRestoreTarget
            : null;
      if (wasTopmost && target) {
        target.focus({ preventScroll: true });
        deferredRestoreTarget = null;
        queueMicrotask(() => {
          if (target.isConnected && document.activeElement !== target) {
            target.focus({ preventScroll: true });
          }
        });
      }
    };
  }, [layerId, open]);

  useEffect(() => {
    if (open) updateLayerScrollLock(layerId, lockScroll);
  }, [layerId, lockScroll, open]);

  useEffect(() => {
    if (!isTopmost || receivedInitialFocusRef.current || !containerRef.current) return;
    receivedInitialFocusRef.current = true;
    queueMicrotask(() => {
      const container = containerRef.current;
      if (!container) return;
      const explicitTarget = container.querySelector<HTMLElement>("[data-dialog-initial-focus], [autofocus]");
      if (explicitTarget && document.activeElement !== explicitTarget) {
        explicitTarget.focus({ preventScroll: true });
        return;
      }
      if (container.contains(document.activeElement)) return;
      const target = explicitTarget ?? focusableElements(container)[0] ?? container;
      target.focus({ preventScroll: true });
    });
  }, [containerRef, isTopmost]);

  useEffect(() => {
    if (!isTopmost) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onCloseRef.current();
        return;
      }
      if (!trapFocus || event.key !== "Tab" || !containerRef.current) return;

      const focusable = focusableElements(containerRef.current);
      if (focusable.length === 0) {
        event.preventDefault();
        containerRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const focusInside = containerRef.current.contains(document.activeElement);
      if (!focusInside || (event.shiftKey && document.activeElement === first)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [containerRef, isTopmost, trapFocus]);

  return { layerId, isTopmost };
}
