import { FileText } from 'lucide-react';

export interface ActivityArtifact {
  artifactId: string;
  caption: string;
  mediaType: string;
}

export interface ActivityFeedUpdate {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  artifacts: ActivityArtifact[];
}

const activityTime = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

function timeLabel(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : activityTime.format(parsed);
}

export function ActivityFeed({
  updates,
  artifactUrls,
  onOpenArtifact,
}: {
  updates: ActivityFeedUpdate[];
  artifactUrls: Record<string, string>;
  onOpenArtifact: (artifactId: string) => void;
}) {
  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-labelledby="recent-activity-heading">
      <h2 id="recent-activity-heading" className="mb-4 shrink-0 text-xs font-semibold tracking-[0.2px] text-ink">Recent Activity &amp; Visuals</h2>
      {updates.length > 0 ? (
        <ol
          className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto overscroll-contain pr-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-taupe-hover [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-[99px] [&::-webkit-scrollbar-thumb]:bg-line [&::-webkit-scrollbar-track]:bg-transparent"
          aria-label="Recent project activity"
          tabIndex={0}
        >
          {updates.map((update) => (
            <li key={update.id} className="grid grid-cols-[64px_minmax(0,1fr)] gap-3 sm:grid-cols-[80px_minmax(0,1fr)] sm:gap-4">
              <time dateTime={update.createdAt} className="pt-0.5 text-[11px] leading-tight text-muted">{timeLabel(update.createdAt)}</time>
              <div className="flex min-w-0 flex-col gap-2">
                <p className="whitespace-pre-wrap break-words leading-[1.5] text-ink"><span className="font-semibold text-taupe">{update.author}</span> {update.body}</p>
                {update.artifacts.map((artifact) => {
                  const url = artifactUrls[artifact.artifactId];
                  if (!url) return null;
                  const image = artifact.mediaType.startsWith('image/');
                  return (
                    <button
                      key={artifact.artifactId}
                      type="button"
                      className="mt-1 block w-full rounded-[6px] border border-line bg-muted-surface p-4 text-left text-ink hover:border-line-strong focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-taupe-hover"
                      aria-label={`Open visual artifact: ${artifact.caption}`}
                      onClick={() => onOpenArtifact(artifact.artifactId)}
                    >
                      {image ? (
                        <img className="max-h-48 w-full object-contain" src={url} alt="" />
                      ) : (
                        <span className="flex min-h-14 items-center gap-3 text-xs text-muted">
                          <FileText size={18} strokeWidth={1.5} aria-hidden="true" />
                          <span className="min-w-0">
                            <span className="block break-words font-medium text-ink">{artifact.caption}</span>
                            <span className="mt-1 block text-[11px] text-tertiary">{artifact.mediaType}</span>
                          </span>
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <div className="flex min-h-24 flex-1 items-center justify-center text-center text-xs text-muted">Activity will appear as tasks and agents record progress.</div>
      )}
    </section>
  );
}
