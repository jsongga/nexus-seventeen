import { describe, expect, it } from 'vitest';
import { parseProjectMetadata, safeProjectMetadataHref } from './project-metadata';

describe('project metadata', () => {
  it('keeps legacy prose and absolute workspace descriptions visible', () => {
    expect(parseProjectMetadata('Keep customer workflows dependable.')).toEqual({
      summaries: ['Keep customer workflows dependable.'],
      entries: [],
    });
    expect(parseProjectMetadata('/Users/team/platform')).toEqual({
      summaries: [],
      entries: [{
        key: 'workspace',
        label: 'Workspace',
        value: '/Users/team/platform',
        kind: 'workspace',
        href: null,
      }],
    });
    expect(parseProjectMetadata('C:\\work\\platform').entries[0]).toMatchObject({
      label: 'Workspace',
      value: 'C:\\work\\platform',
    });
  });

  it('parses canonical fields case-insensitively and retains repeated keys in order', () => {
    const parsed = parseProjectMetadata([
      'Summary: Keep onboarding dependable.',
      'summary: Keep setup fast.',
      'Workspace: /work/platform',
      'GitHub: https://github.com/acme/platform',
      'GitHub: https://github.com/acme/platform-docs',
      'Dokploy: https://deploy.example.test/apps/platform',
      'Live: https://platform.example.test',
      'Docs: https://docs.example.test/platform',
    ].join('\n'));

    expect(parsed.summaries).toEqual(['Keep onboarding dependable.', 'Keep setup fast.']);
    expect(parsed.entries.map(({ label, value }) => ({ label, value }))).toEqual([
      { label: 'Workspace', value: '/work/platform' },
      { label: 'GitHub', value: 'https://github.com/acme/platform' },
      { label: 'GitHub', value: 'https://github.com/acme/platform-docs' },
      { label: 'Dokploy', value: 'https://deploy.example.test/apps/platform' },
      { label: 'Live site', value: 'https://platform.example.test' },
      { label: 'Documentation', value: 'https://docs.example.test/platform' },
    ]);
    expect(parsed.entries.filter((item) => item.key === 'github')).toHaveLength(2);
  });

  it('links only credential-free HTTP(S) values and leaves other values as text', () => {
    const parsed = parseProjectMetadata([
      'GitHub: javascript:alert(1)',
      'Dokploy: ftp://deploy.example.test/app',
      'Live: https://user:secret@example.test/private',
      'Docs: docs/runbook.md',
      'Owner: Platform team',
      'Status page: http://status.example.test/current',
    ].join('\n'));

    expect(parsed.entries.map((item) => item.href)).toEqual([
      null,
      null,
      null,
      null,
      null,
      'http://status.example.test/current',
    ]);
    expect(parsed.entries.at(4)).toMatchObject({ label: 'Owner', value: 'Platform team' });
    expect(safeProjectMetadataHref('https://example.test/docs')).toBe('https://example.test/docs');
    expect(safeProjectMetadataHref('mailto:team@example.test')).toBeNull();
    expect(safeProjectMetadataHref('https://example.test/a path')).toBeNull();
  });

  it('does not mistake standalone URLs or Windows paths for metadata keys', () => {
    const parsed = parseProjectMetadata([
      'https://github.com/acme/platform',
      'C:\\work\\platform',
    ].join('\n'));

    expect(parsed.summaries).toEqual([]);
    expect(parsed.entries).toEqual([
      expect.objectContaining({ label: 'Project link', href: 'https://github.com/acme/platform' }),
      expect.objectContaining({ label: 'Workspace', value: 'C:\\work\\platform', href: null }),
    ]);
  });
});
