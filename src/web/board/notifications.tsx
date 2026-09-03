/** Renders the board's notification list. */

/* —— Imports —— */

import { Bell, RefreshCw } from "lucide-react";
import { Button } from "../components/ui";
import { type BoardNotifications } from "../data/client";
import { formatShortDateTime } from "../data/date-format";
import type { RawBoardNotification } from "../data/parse";
import { notificationKindLabel } from "../model/work-item-labels";

/* —— Notifications —— */

export function NotificationsBlock({
  notifications,
  loading,
  error,
  markingId,
  onMarkRead,
  onOpenWorkItem,
  onRetry,
}: {
  notifications: BoardNotifications | null;
  loading: boolean;
  error: string | null;
  markingId: string | null;
  onMarkRead: (notification: RawBoardNotification) => void;
  onOpenWorkItem: (workItemId: string) => void;
  onRetry: () => void;
}) {
  const unread = notifications?.unread ?? [];
  return (
    <section aria-labelledby="notifications-heading" aria-live="polite">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Bell size={15} className="text-muted" aria-hidden="true" />
          <h2 id="notifications-heading" className="font-display text-lg font-light tracking-[0.01em] text-ink">
            Notifications
          </h2>
        </div>
        <span className="text-xs text-muted">{unread.length} unread</span>
      </div>
      {error === null ? null : (
        <div
          className="mb-2 flex flex-wrap items-center justify-between gap-3 rounded-md border border-urgent/20 bg-urgent-soft px-3.5 py-3 text-sm text-urgent"
          role="alert"
        >
          <span>{error}</span>
          <Button size="sm" onClick={onRetry}>
            Retry
          </Button>
        </div>
      )}
      {loading && notifications === null ? (
        <div
          className="flex min-h-20 items-center justify-center gap-2 rounded-md border border-line bg-muted-surface text-sm text-muted"
          role="status"
        >
          <RefreshCw size={15} className="animate-spin" /> Loading notifications…
        </div>
      ) : unread.length === 0 ? (
        <p className="rounded-md border border-line bg-muted-surface px-3.5 py-4 text-sm text-muted">
          No unread notifications.
        </p>
      ) : (
        <ol className="divide-y divide-line rounded-md border border-line bg-card">
          {unread.map((notification) => {
            return (
              <li
                key={notification.notificationId}
                className="flex flex-col gap-3 px-3.5 py-3 sm:flex-row sm:items-start sm:justify-between"
              >
                <div className="min-w-0 flex-1">
                  {notification.workItemId === null ? (
                    <p className="text-sm leading-6 text-ink">{notification.summary}</p>
                  ) : (
                    <button
                      type="button"
                      className="text-left text-sm leading-6 text-ink underline decoration-line underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-taupe-hover"
                      onClick={() => onOpenWorkItem(notification.workItemId!)}
                    >
                      {notification.summary}
                    </button>
                  )}
                  <p className="mt-1 text-[11px] text-muted">
                    {notificationKindLabel[notification.kind]} ·{" "}
                    <time dateTime={notification.createdAt}>{formatShortDateTime(notification.createdAt)}</time>
                  </p>
                </div>
                <Button size="sm" disabled={markingId !== null} onClick={() => onMarkRead(notification)}>
                  {markingId === notification.notificationId ? "Marking…" : "Mark read"}
                </Button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
