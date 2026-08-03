/**
 * Project artifact media validation and upload preparation.
 *
 * Deliberately not rendered by the current ProjectPage design, which shows the
 * documents, pipeline and activity regions only. Kept exported so the behaviour
 * survives and can be re-surfaced without being rebuilt.
 */
import type { TaskBoardClient } from './client';
import type { ProjectArtifact } from './types';

const supportedMediaTypes = [
  'text/markdown',
  'text/vnd.mermaid',
  'image/png',
  'image/jpeg',
  'image/webp',
];

export function artifactMediaType(fileName: string, fileType: string): string | null {
  const mediaType = fileName.endsWith('.mmd') || fileName.endsWith('.mermaid')
    ? 'text/vnd.mermaid'
    : fileName.endsWith('.md') ? 'text/markdown' : fileType;
  return supportedMediaTypes.includes(mediaType) ? mediaType : null;
}

export async function uploadArtifact(
  client: TaskBoardClient,
  projectId: string,
  file: File,
): Promise<ProjectArtifact> {
  const mediaType = artifactMediaType(file.name, file.type);
  if (mediaType === null) throw new TypeError(`Unsupported artifact media type: ${file.type}`);

  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return client.uploadArtifact(projectId, {
    mediaType,
    caption: file.name,
    contentBase64: window.btoa(binary),
  });
}
