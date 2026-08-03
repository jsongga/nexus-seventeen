import {
  ArrowLeft,
  CircleAlert,
  FilePlus2,
  PenLine,
  RefreshCw,
  Save,
  ShieldAlert,
  Undo2,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, FieldLabel, Modal, cn, inputClass } from '../components/ui';
import type { TaskBoardClient } from './client';
import { documentContentFits, documentDraftStore, protectUnsavedDocumentDrafts } from './document-drafts';
import type { BoardDocument, BoardSnapshot, CreateDocumentInput } from './types';

const dateTime = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

type StreamState = 'idle' | 'connecting' | 'watching' | 'reconnecting';

interface DraftState {
  documentId: string | null;
  baseContentVersion: number;
  content: string;
  dirty: boolean;
  remoteChanged: boolean;
}

const emptyDraft: DraftState = {
  documentId: null,
  baseContentVersion: 0,
  content: '',
  dirty: false,
  remoteChanged: false,
};

const warmCard = '!rounded-[18px] !border-line !bg-surface !shadow-none';
const pillAction = '!rounded-full !shadow-none';
const warmInput = '!rounded-[14px] !border-line !bg-surface !shadow-none';

function formatTime(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : dateTime.format(parsed);
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof DOMException && error.name === 'AbortError') return '';
  return error instanceof Error ? error.message : fallback;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function CreateDocumentForm({
  snapshot,
  busy,
  onSubmit,
}: {
  snapshot: BoardSnapshot;
  busy: boolean;
  onSubmit: (input: CreateDocumentInput) => Promise<void>;
}) {
  const [projectId, setProjectId] = useState(snapshot.projects[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [contentError, setContentError] = useState<string | null>(null);
  return (
    <form
      className="space-y-4 p-5 sm:p-6"
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit({ projectId, title: title.trim(), content });
      }}
    >
      <div>
        <FieldLabel htmlFor="document-project">Project</FieldLabel>
        <select id="document-project" className={cn(inputClass, warmInput)} value={projectId} onChange={(event) => setProjectId(event.target.value)}>
          {snapshot.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
      </div>
      <div>
        <FieldLabel htmlFor="document-title">Title</FieldLabel>
        <input id="document-title" className={cn(inputClass, warmInput)} autoFocus required value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Release checklist" />
      </div>
      <div>
        <FieldLabel htmlFor="document-content">Starting text</FieldLabel>
        <textarea id="document-content" className={cn(inputClass, warmInput, 'min-h-48 resize-y py-3 font-mono text-xs leading-5')} value={content} onChange={(event) => { const next = event.target.value; if (documentContentFits(next)) { setContent(next); setContentError(null); } else setContentError('Documents are limited to 48 KiB of Markdown text.'); }} placeholder="# Release checklist" />
        <p className={cn('mt-1.5 text-[11px] leading-4', contentError ? 'text-urgent' : 'text-muted')}>{contentError ?? 'Markdown, up to 48 KiB.'}</p>
      </div>
      <Button className={cn(pillAction, 'w-full')} type="submit" variant="primary" disabled={busy || !projectId || !title.trim() || contentError !== null}>Create document</Button>
    </form>
  );
}

export function DocumentsPage({
  snapshot,
  selectedDocumentId,
  client,
  connected,
  onSelectDocument,
  onRefreshBoard,
}: {
  snapshot: BoardSnapshot;
  selectedDocumentId?: string;
  client: TaskBoardClient;
  connected: boolean;
  onSelectDocument: (documentId?: string) => void;
  onRefreshBoard: () => Promise<boolean>;
}) {
  const [document, setDocument] = useState<BoardDocument | null>(null);
  const [documentLoading, setDocumentLoading] = useState(false);
  const [operationBusy, setOperationBusy] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [summaryWarning, setSummaryWarning] = useState<string | null>(null);
  const [streamState, setStreamState] = useState<StreamState>('idle');
  const [streamError, setStreamError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [draft, setDraft] = useState<DraftState>(emptyDraft);
  const documentHeadingRef = useRef<HTMLHeadingElement>(null);
  const documentButtonRefs = useRef(new Map<string, HTMLButtonElement>());

  const orderedDocuments = useMemo(
    () => [...snapshot.documents].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.title.localeCompare(right.title)),
    [snapshot.documents],
  );

  useEffect(() => {
    if (!selectedDocumentId || !connected) {
      setDocument((current) => selectedDocumentId && current?.id === selectedDocumentId ? current : null);
      setDocumentLoading(false);
      setStreamState('idle');
      return;
    }
    const documentId = selectedDocumentId;
    const controller = new AbortController();
    let stopped = false;
    let firstRead = true;
    setDocument((current) => current?.id === documentId ? current : null);
    setDocumentLoading(true);
    setOperationError(null);

    async function follow(): Promise<void> {
      let retryMilliseconds = 400;
      while (!stopped && !controller.signal.aborted) {
        try {
          setStreamState(firstRead ? 'connecting' : 'reconnecting');
          const latest = await client.getDocument(documentId, controller.signal);
          if (stopped) return;
          let cursor = latest.sequence;
          setDocument(latest);
          setDocumentLoading(false);
          setStreamError(null);
          setStreamState('watching');
          firstRead = false;
          retryMilliseconds = 400;
          await client.subscribeDocument({
            documentId,
            after: cursor,
            signal: controller.signal,
            onDocument: (next) => {
              if (next.sequence <= cursor || stopped) return;
              cursor = next.sequence;
              setDocument(next);
              setStreamError(null);
              setStreamState('watching');
            },
          });
          if (stopped) return;
          setStreamError('The update stream ended. Reconnecting from the latest saved snapshot.');
        } catch (error) {
          if (controller.signal.aborted || stopped) return;
          setDocumentLoading(false);
          setStreamError(errorMessage(error, 'Could not follow document updates'));
        }
        setStreamState('reconnecting');
        await sleep(retryMilliseconds);
        retryMilliseconds = Math.min(retryMilliseconds * 2, 4_000);
      }
    }

    void follow();
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [client, connected, selectedDocumentId]);

  useEffect(() => {
    if (!document) return;
    setDraft((current) => {
      if (current.documentId !== document.id) {
        const stored = documentDraftStore.get(document.id);
        if (stored && stored.content !== document.content) {
          protectUnsavedDocumentDrafts();
          return {
            documentId: document.id,
            baseContentVersion: stored.baseContentVersion,
            content: stored.content,
            dirty: true,
            remoteChanged: stored.baseContentVersion !== document.contentVersion,
          };
        }
        if (stored) documentDraftStore.delete(document.id);
        return {
          documentId: document.id,
          baseContentVersion: document.contentVersion,
          content: document.content,
          dirty: false,
          remoteChanged: false,
        };
      }
      if (current.dirty && current.content === document.content) {
        documentDraftStore.delete(document.id);
        return {
          documentId: document.id,
          baseContentVersion: document.contentVersion,
          content: document.content,
          dirty: false,
          remoteChanged: false,
        };
      }
      if (!current.dirty) {
        return {
          ...current,
          baseContentVersion: document.contentVersion,
          content: document.content,
          remoteChanged: false,
        };
      }
      if (current.baseContentVersion !== document.contentVersion) {
        return { ...current, remoteChanged: true };
      }
      return current;
    });
  }, [document]);

  useEffect(() => {
    if (!draft.documentId) return;
    if (!draft.dirty) {
      documentDraftStore.delete(draft.documentId);
      return;
    }
    protectUnsavedDocumentDrafts();
    const persisted = documentDraftStore.set({
      documentId: draft.documentId,
      baseContentVersion: draft.baseContentVersion,
      content: draft.content,
      updatedAt: Date.now(),
    });
    if (!persisted) {
      setSummaryWarning('This draft is retained while the app stays open, but the browser could not retain every draft for reload. Save or copy it before closing the tab.');
    }
  }, [draft.baseContentVersion, draft.content, draft.dirty, draft.documentId]);

  useEffect(() => {
    if (!selectedDocumentId || document?.id !== selectedDocumentId || typeof window.matchMedia !== 'function') return;
    if (window.matchMedia('(max-width: 1023px)').matches) documentHeadingRef.current?.focus();
  }, [document?.id, selectedDocumentId]);

  async function runDocumentOperation(operation: () => Promise<BoardDocument>): Promise<BoardDocument | null> {
    if (!connected) {
      setOperationError('The task board is disconnected. Reconnect before changing a document.');
      return null;
    }
    setOperationBusy(true);
    setOperationError(null);
    setSummaryWarning(null);
    try {
      const next = await operation();
      setDocument(next);
      if (!await onRefreshBoard()) {
        setSummaryWarning('The document was saved, but the project document list could not be refreshed. The open saved snapshot remains authoritative.');
      }
      return next;
    } catch (error) {
      setOperationError(errorMessage(error, 'The document change could not be saved'));
      return null;
    } finally {
      setOperationBusy(false);
    }
  }

  async function createDocument(input: CreateDocumentInput): Promise<void> {
    const created = await runDocumentOperation(() => client.createDocument(input));
    if (!created) return;
    setCreateOpen(false);
    setDraft({
      documentId: created.id,
      baseContentVersion: created.contentVersion,
      content: created.content,
      dirty: false,
      remoteChanged: false,
    });
    onSelectDocument(created.id);
  }

  async function acquirePen(force: boolean): Promise<void> {
    if (!document) return;
    if (force && !window.confirm(`Take the pen from ${document.penHolder?.actorId ?? 'the current holder'}? Their future saves will be blocked and unsaved work cannot be merged.`)) return;
    await runDocumentOperation(() => client.changeDocumentPen(document.id, {
      action: 'acquire',
      expectedPenEpoch: document.penEpoch,
      force,
    }));
  }

  async function releasePen(): Promise<void> {
    if (!document) return;
    if (draft.dirty && !window.confirm('Release the pen without saving this draft? The draft will remain in this tab, but it is not part of the durable document.')) return;
    await runDocumentOperation(() => client.changeDocumentPen(document.id, {
      action: 'release',
      expectedPenEpoch: document.penEpoch,
      force: false,
    }));
  }

  async function saveSnapshot(): Promise<void> {
    if (!document || !draft.dirty || draft.remoteChanged) return;
    const saved = await runDocumentOperation(() => client.saveDocumentSnapshot(document.id, {
      penEpoch: document.penEpoch,
      contentVersion: draft.baseContentVersion,
      content: draft.content,
    }));
    if (!saved) return;
    documentDraftStore.delete(saved.id);
    setDraft({
      documentId: saved.id,
      baseContentVersion: saved.contentVersion,
      content: saved.content,
      dirty: false,
      remoteChanged: false,
    });
  }

  const holdsPen = document?.penHolder?.actorType === 'human'
    && document.penHolder.clientId === client.documentClientId;
  const holderLabel = document?.penHolder
    ? holdsPen
      ? 'You hold the pen'
      : `${document.penHolder.actorId} holds the pen`
    : 'The pen is available';
  const selectedProject = snapshot.projects.find((project) => project.id === document?.projectId);

  function useSavedVersion(): void {
    if (!document) return;
    if (draft.dirty && !window.confirm('Discard this unsaved draft and load the newer saved version? The draft cannot be recovered.')) return;
    documentDraftStore.delete(document.id);
    setDraft({
      documentId: document.id,
      baseContentVersion: document.contentVersion,
      content: document.content,
      dirty: false,
      remoteChanged: false,
    });
  }

  function backToDocumentList(): void {
    const returnDocumentId = selectedDocumentId;
    onSelectDocument();
    window.requestAnimationFrame(() => {
      if (returnDocumentId) documentButtonRefs.current.get(returnDocumentId)?.focus();
    });
  }

  return (
    <>
      {selectedDocumentId ? (
        <>
          <header className="flex items-center border-b border-line bg-canvas px-4 py-5 sm:px-8 lg:px-12 lg:py-8">
            <Button className={pillAction} size="sm" variant="quiet" icon={<ArrowLeft size={15} />} onClick={backToDocumentList}>Back to document list</Button>
          </header>

          <main className="w-full max-w-5xl space-y-4 bg-canvas p-4 sm:px-8 sm:py-6 lg:min-h-[calc(100dvh-101px)] lg:px-12 lg:py-8">
            {operationError ? (
              <div role="alert" className="flex items-start gap-2 rounded-[16px] border border-urgent-border bg-urgent-soft px-4 py-3 text-sm text-urgent">
                <CircleAlert size={17} className="mt-0.5 shrink-0" />
                <span>{operationError}. Your unsaved draft remains in this tab.</span>
              </div>
            ) : null}
            {summaryWarning ? (
              <div role="status" className="flex items-start gap-2 rounded-[16px] border border-caution-border bg-caution-soft px-4 py-3 text-sm text-caution">
                <CircleAlert size={17} className="mt-0.5 shrink-0" />
                <span>{summaryWarning}</span>
              </div>
            ) : null}

            <section aria-label="Document viewer">
              {documentLoading && !document ? (
                <Card className={cn(warmCard, 'p-10 text-center')}><RefreshCw size={18} className="mx-auto animate-spin text-muted" /><p className="mt-3 text-sm text-muted">Loading document…</p></Card>
              ) : document ? (
                <Card className={cn(warmCard, 'overflow-hidden')}>
                  <div className="border-b border-line px-4 py-4 sm:px-5">
                    <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted">{selectedProject?.name ?? 'Document'}</p>
                    <h1 ref={documentHeadingRef} tabIndex={-1} className="mt-1 break-words font-display text-xl font-medium tracking-[-0.025em] text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-taupe">{document.title}</h1>
                    <p className="mt-1 text-[11px] text-muted">Saved {formatTime(document.updatedAt)} · Version {document.contentVersion}</p>
                  </div>

                  <div className="border-b border-line bg-paper px-4 py-3 sm:px-5">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <PenLine size={15} className="shrink-0 text-muted" />
                        <p className="text-xs font-medium text-ink">{holderLabel}</p>
                      </div>
                      <div className="flex shrink-0 flex-wrap gap-2">
                        {holdsPen ? <Button className={pillAction} size="sm" disabled={operationBusy || !connected} onClick={() => void releasePen()}>Release pen</Button> : document.penHolder ? <Button className={pillAction} size="sm" variant="danger" icon={<ShieldAlert size={14} />} disabled={operationBusy || !connected} onClick={() => void acquirePen(true)}>Take over pen</Button> : <Button className={pillAction} size="sm" variant="mint" icon={<PenLine size={14} />} disabled={operationBusy || !connected} onClick={() => void acquirePen(false)}>Take the pen</Button>}
                      </div>
                    </div>
                  </div>

                  {draft.remoteChanged ? (
                    <div role="status" aria-live="polite" className="flex flex-col gap-3 border-b border-caution-border bg-caution-soft px-4 py-3 text-xs text-caution sm:flex-row sm:items-center sm:justify-between sm:px-5"><span className="flex items-start gap-2"><CircleAlert size={15} className="mt-0.5 shrink-0" />A newer saved version arrived. Your draft is preserved and cannot overwrite it.</span><Button className={pillAction} size="sm" variant="danger" icon={<Undo2 size={14} />} onClick={useSavedVersion}>Discard draft and load saved</Button></div>
                  ) : null}

                  <div className="p-4 sm:p-5">
                    {holdsPen || draft.dirty ? (
                      <>
                        <label htmlFor={`document-editor-${document.id}`} className="sr-only">Edit {document.title}</label>
                        <textarea
                          id={`document-editor-${document.id}`}
                          className={cn(inputClass, warmInput, 'min-h-[360px] resize-y whitespace-pre-wrap py-3 font-mono text-xs leading-6')}
                          readOnly={!holdsPen}
                          value={draft.content}
                          onChange={(event) => {
                            const content = event.target.value;
                            if (!documentContentFits(content)) {
                              setOperationError('Documents are limited to 48 KiB of Markdown text');
                              return;
                            }
                            setOperationError(null);
                            setDraft((current) => ({ ...current, content, dirty: content !== document.content, remoteChanged: current.remoteChanged }));
                          }}
                        />
                        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"><p className="text-[11px] leading-4 text-muted">{draft.dirty ? holdsPen ? 'Unsaved in this tab' : 'Draft preserved — read-only' : 'Saved'}</p><Button className={pillAction} variant="primary" size="sm" icon={<Save size={14} />} disabled={!holdsPen || !draft.dirty || draft.remoteChanged || operationBusy || !connected} onClick={() => void saveSnapshot()}>Save snapshot</Button></div>
                      </>
                    ) : (
                      <pre aria-label={`${document.title} saved snapshot`} className="min-h-[360px] whitespace-pre-wrap break-words rounded-[14px] border border-line bg-paper p-4 font-mono text-xs leading-6 text-ink">{document.content || 'This document is empty.'}</pre>
                    )}
                  </div>

                  {streamError || streamState === 'reconnecting' ? (
                    <div role="status" aria-live="polite" className="flex items-start gap-2 border-t border-caution-border bg-caution-soft px-4 py-3 text-xs text-caution sm:px-5"><CircleAlert size={14} className="mt-0.5 shrink-0" /><span>{streamError ?? 'Live updates paused. Reconnecting…'}</span></div>
                  ) : null}
                </Card>
              ) : streamError ? (
                <Card className={cn(warmCard, 'p-8 text-center')} as="section"><CircleAlert size={18} className="mx-auto text-caution" /><h1 className="mt-3 text-sm font-medium text-ink">Could not load this document</h1><p role="status" aria-live="polite" className="mt-1 text-xs leading-5 text-muted">{streamError}. Reconnecting automatically.</p></Card>
              ) : null}
            </section>
          </main>
        </>
      ) : (
        <>
          <header className="flex items-center justify-between gap-4 border-b border-line bg-canvas px-4 py-5 sm:px-8 lg:px-12 lg:py-8">
            <h1 className="font-display text-2xl font-light tracking-[0.01em] text-ink sm:text-[28px]">Documents</h1>
            <Button className={pillAction} size="sm" variant="primary" icon={<FilePlus2 size={15} />} disabled={!connected} onClick={() => setCreateOpen(true)}>New document</Button>
          </header>

          <main className="w-full max-w-[1200px] bg-canvas p-4 sm:px-8 sm:py-6 lg:min-h-[calc(100dvh-109px)] lg:px-12 lg:py-8">
            {operationError ? (
              <div role="alert" className="mb-4 flex items-start gap-2 rounded-[16px] border border-urgent-border bg-urgent-soft px-4 py-3 text-sm text-urgent"><CircleAlert size={17} className="mt-0.5 shrink-0" /><span>{operationError}</span></div>
            ) : null}
            <div className="overflow-hidden rounded-[18px] border border-line bg-surface">
              <table className="w-full table-fixed text-left">
                <caption className="sr-only">Documents</caption>
                <thead className="border-b border-line bg-paper text-[10px] font-medium uppercase tracking-[0.12em] text-muted">
                  <tr>
                    <th scope="col" className="w-full px-4 py-3 sm:w-[42%] sm:px-5">Document</th>
                    <th scope="col" className="hidden w-[24%] px-4 py-3 sm:table-cell">Project</th>
                    <th scope="col" className="hidden w-[18%] px-4 py-3 md:table-cell">Updated</th>
                    <th scope="col" className="hidden w-[16%] px-4 py-3 lg:table-cell">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {orderedDocuments.length > 0 ? orderedDocuments.map((item) => {
                    const project = snapshot.projects.find((candidate) => candidate.id === item.projectId);
                    const hasDraft = (draft.documentId === item.id && draft.dirty) || documentDraftStore.has(item.id);
                    const holder = item.penHolder?.actorType === 'human' && item.penHolder.clientId === client.documentClientId
                      ? 'You are editing'
                      : item.penHolder
                        ? `${item.penHolder.actorId} is editing`
                        : 'Available to edit';
                    return (
                      <tr key={item.id} className="cursor-pointer transition-colors duration-150 hover:bg-paper focus-within:bg-paper" onClick={() => onSelectDocument(item.id)}>
                        <td className="p-0">
                          <button
                            ref={(node) => {
                              if (node) documentButtonRefs.current.set(item.id, node);
                              else documentButtonRefs.current.delete(item.id);
                            }}
                            type="button"
                            aria-label={`${item.title}. ${holder}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              onSelectDocument(item.id);
                            }}
                            className="block min-h-11 w-full px-4 py-3 text-left transition-transform duration-150 ease-out motion-safe:active:scale-[0.995] sm:px-5"
                          >
                            <span className="block truncate text-sm font-medium text-ink">{item.title}</span>
                            <span className="mt-1 block truncate text-[11px] text-muted sm:hidden">{project?.name ?? 'Unknown project'} · {formatTime(item.updatedAt)}</span>
                            {hasDraft ? <span className="mt-1 block text-[10px] font-medium text-caution">Unsaved draft</span> : null}
                          </button>
                        </td>
                        <td className="hidden truncate px-4 py-3 text-xs text-muted sm:table-cell">{project?.name ?? 'Unknown project'}</td>
                        <td className="hidden px-4 py-3 text-xs text-muted md:table-cell">{formatTime(item.updatedAt)}</td>
                        <td className="hidden truncate px-4 py-3 text-xs text-muted lg:table-cell">{holder}</td>
                      </tr>
                    );
                  }) : (
                    <tr><td colSpan={4} className="px-5 py-10 text-center text-sm text-muted">No documents yet</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </main>
        </>
      )}

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Create a document" description="A shared Markdown note. Creating it does not wake an agent."><CreateDocumentForm snapshot={snapshot} busy={operationBusy || !connected} onSubmit={createDocument} /></Modal>
    </>
  );
}
