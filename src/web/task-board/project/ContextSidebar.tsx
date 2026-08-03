import { ChevronDown, ChevronUp } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cn } from '../../components/ui';

export interface ContextDocument {
  id: string;
  label: string;
  value: string;
  href: string | null;
  meta: string;
  documentId?: string;
}

function orderedDocuments(documents: ContextDocument[], order: string[]): ContextDocument[] {
  return [...documents].sort((left, right) => {
    const leftIndex = order.indexOf(left.id);
    const rightIndex = order.indexOf(right.id);
    return (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex)
      - (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex);
  });
}

export function ContextSidebar({
  intro,
  documents,
  onSelectDocument,
  orderStorageKey,
}: {
  intro: string;
  documents: ContextDocument[];
  onSelectDocument: (documentId: string) => void;
  orderStorageKey?: string;
}) {
  const [order, setOrder] = useState<string[]>([]);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const ordered = orderedDocuments(documents, order);

  useEffect(() => {
    if (!orderStorageKey) {
      setOrder([]);
      return;
    }
    try {
      const saved = JSON.parse(window.localStorage.getItem(orderStorageKey) ?? '[]') as unknown;
      setOrder(Array.isArray(saved) && saved.every((item) => typeof item === 'string') ? saved : []);
    } catch {
      setOrder([]);
    }
  }, [orderStorageKey]);

  const saveOrder = (next: string[]) => {
    setOrder(next);
    if (!orderStorageKey) return;
    try {
      window.localStorage.setItem(orderStorageKey, JSON.stringify(next));
    } catch {
      // Reordering still works for this session when browser storage is unavailable.
    }
  };

  const move = (id: string, direction: -1 | 1) => {
    const current = ordered.map((document) => document.id);
    const from = current.indexOf(id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= current.length) return;
    [current[from], current[to]] = [current[to]!, current[from]!];
    saveOrder(current);
  };

  const drop = (targetId: string) => {
    if (!draggedId || draggedId === targetId) return;
    const current = ordered.map((document) => document.id);
    const from = current.indexOf(draggedId);
    const to = current.indexOf(targetId);
    if (from < 0 || to < 0) return;
    current.splice(to, 0, current.splice(from, 1)[0]!);
    saveOrder(current);
    setDraggedId(null);
  };

  return (
    <aside className="max-h-[40%] w-full shrink-0 overflow-y-auto border-b border-line p-4 md:max-h-none md:w-[260px] md:border-b-0 md:border-r md:p-8">
      <h2 className="mb-6 inline-block border-b-2 border-ink pb-1 text-xs font-semibold tracking-[0.2px] text-ink">Context &amp; Materials</h2>
      <p className="mb-6 whitespace-pre-line text-xs leading-[1.5] text-muted">{intro}</p>
      <h3 className="mb-4 text-xs font-semibold tracking-[0.2px] text-ink">Important Documents</h3>
      {ordered.length > 0 ? (
        <ul className="flex list-none flex-col gap-3">
          {ordered.map((document, index) => (
            <li
              key={document.id}
              className={cn(
                'group -m-1 flex min-w-0 items-start gap-2 rounded-[4px] p-1 text-[13px] leading-[1.3] text-muted transition-colors hover:bg-muted-surface hover:text-ink focus-within:bg-muted-surface focus-within:text-ink',
                draggedId === document.id && 'opacity-50',
              )}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => drop(document.id)}
            >
              <span
                draggable
                className="mt-0.5 size-3.5 shrink-0 cursor-grab rounded-[2px] bg-line"
                onDragStart={() => setDraggedId(document.id)}
                onDragEnd={() => setDraggedId(null)}
                aria-hidden="true"
              />
              {document.documentId ? (
                <button
                  type="button"
                  aria-label={`Open ${document.label}`}
                  title={document.label}
                  className="min-w-0 flex-1 rounded-[4px] text-left text-current focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-taupe-hover"
                  onClick={() => onSelectDocument(document.documentId!)}
                >
                  <span className="block break-words">{document.label}</span>
                  <span className="mt-0.5 block break-words text-[11px] text-muted">{document.meta}</span>
                </button>
              ) : document.href ? (
                <a
                  href={document.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`${document.label}: ${document.value} (opens in a new tab)`}
                  title={document.value}
                  className="min-w-0 flex-1 rounded-[4px] text-current no-underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-taupe-hover"
                >
                  <span className="block break-words">{document.label}</span>
                  <span className="mt-0.5 block break-all text-[11px] text-muted">{document.meta}</span>
                </a>
              ) : (
                <div title={document.value} className="min-w-0 flex-1">
                  <span className="block break-words">{document.label}</span>
                  <span className="mt-0.5 block break-all text-[11px] text-muted">{document.meta}</span>
                </div>
              )}
              <span className="flex shrink-0 opacity-100 transition-opacity sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
                <button
                  type="button"
                  disabled={index === 0}
                  aria-label={`Move ${document.label} earlier`}
                  className="flex size-6 items-center justify-center rounded-[4px] text-muted hover:bg-card hover:text-ink disabled:invisible"
                  onClick={() => move(document.id, -1)}
                >
                  <ChevronUp size={12} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  disabled={index === ordered.length - 1}
                  aria-label={`Move ${document.label} later`}
                  className="flex size-6 items-center justify-center rounded-[4px] text-muted hover:bg-card hover:text-ink disabled:invisible"
                  onClick={() => move(document.id, 1)}
                >
                  <ChevronDown size={12} aria-hidden="true" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : <p className="text-xs leading-[1.5] text-muted">No important documents recorded.</p>}
    </aside>
  );
}
