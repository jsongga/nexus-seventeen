export type ProjectMetadataKind = 'workspace' | 'github' | 'dokploy' | 'live' | 'docs' | 'other';

export interface ProjectMetadataEntry {
  key: string;
  label: string;
  value: string;
  kind: ProjectMetadataKind;
  href: string | null;
}

export interface ProjectMetadata {
  summaries: string[];
  entries: ProjectMetadataEntry[];
}

const keyedLine = /^([A-Za-z][A-Za-z0-9 _-]{0,39}):[ \t]*(.*)$/u;
const windowsWorkspace = /^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/u;

const knownKeys: Readonly<Record<string, { label: string; kind: ProjectMetadataKind | 'summary' }>> = {
  summary: { label: 'Summary', kind: 'summary' },
  description: { label: 'Summary', kind: 'summary' },
  overview: { label: 'Summary', kind: 'summary' },
  workspace: { label: 'Workspace', kind: 'workspace' },
  workspaces: { label: 'Workspace', kind: 'workspace' },
  'workspace path': { label: 'Workspace', kind: 'workspace' },
  github: { label: 'GitHub', kind: 'github' },
  'github repo': { label: 'GitHub', kind: 'github' },
  'github repository': { label: 'GitHub', kind: 'github' },
  dokploy: { label: 'Dokploy', kind: 'dokploy' },
  live: { label: 'Live site', kind: 'live' },
  'live site': { label: 'Live site', kind: 'live' },
  site: { label: 'Live site', kind: 'live' },
  website: { label: 'Live site', kind: 'live' },
  docs: { label: 'Documentation', kind: 'docs' },
  documentation: { label: 'Documentation', kind: 'docs' },
  runbook: { label: 'Documentation', kind: 'docs' },
};

function normalizedKey(value: string): string {
  return value.trim().toLowerCase().replace(/[_-]+/gu, ' ').replace(/\s+/gu, ' ');
}

function humanizeKey(value: string): string {
  return normalizedKey(value)
    .split(' ')
    .filter(Boolean)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(' ');
}

function isWorkspacePath(value: string): boolean {
  return value.startsWith('/') || value.startsWith('~/') || windowsWorkspace.test(value);
}

/** Returns a canonical href only for ordinary, credential-free HTTP(S) URLs. */
export function safeProjectMetadataHref(value: string): string | null {
  const candidate = value.trim();
  if (!candidate || /[\u0000-\u0020\u007f]/u.test(candidate)) return null;
  try {
    const url = new URL(candidate);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function entry(key: string, label: string, kind: ProjectMetadataKind, value: string): ProjectMetadataEntry {
  return {
    key,
    label,
    kind,
    value,
    href: safeProjectMetadataHref(value),
  };
}

/**
 * Parses the free-form project description without making structured metadata
 * mandatory. Legacy prose remains a summary, and legacy absolute paths remain
 * visible as workspace metadata.
 */
export function parseProjectMetadata(description: string | null | undefined): ProjectMetadata {
  const source = description?.trim();
  if (!source) return { summaries: [], entries: [] };

  const summaries: string[] = [];
  const entries: ProjectMetadataEntry[] = [];
  const prose: string[] = [];

  const flushProse = () => {
    const value = prose.join('\n').trim();
    prose.length = 0;
    if (!value) return;
    summaries.push(value);
  };

  for (const sourceLine of source.replace(/\r\n?/gu, '\n').split('\n')) {
    const line = sourceLine.trim();
    if (!line) {
      flushProse();
      continue;
    }
    if (safeProjectMetadataHref(line) !== null) {
      flushProse();
      entries.push(entry('link', 'Project link', 'other', line));
      continue;
    }
    if (isWorkspacePath(line)) {
      flushProse();
      entries.push(entry('workspace', 'Workspace', 'workspace', line));
      continue;
    }
    const match = keyedLine.exec(line);
    if (!match) {
      prose.push(line);
      continue;
    }

    flushProse();
    const rawKey = match[1] ?? '';
    const value = (match[2] ?? '').trim();
    if (!value) continue;
    const key = normalizedKey(rawKey);
    const definition = knownKeys[key];
    if (definition?.kind === 'summary') {
      summaries.push(value);
      continue;
    }
    entries.push(entry(
      key,
      definition?.label ?? humanizeKey(rawKey),
      definition?.kind ?? 'other',
      value,
    ));
  }
  flushProse();

  return { summaries, entries };
}
