import { describe, expect, it, vi } from 'vitest';
import { beginArtifactPreviewLoad } from './artifact-previews';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('beginArtifactPreviewLoad', () => {
  it('settles each artifact independently so successful previews survive a failed blob', async () => {
    const successfulBlob = new Blob(['preview']);
    const previews = new Map<string, string | null>();
    const load = beginArtifactPreviewLoad({
      artifactIds: ['failed', 'successful'],
      getBlob: async (artifactId) => {
        if (artifactId === 'failed') throw new Error('blob unavailable');
        return successfulBlob;
      },
      onPreview: (artifactId, url) => previews.set(artifactId, url),
      createObjectURL: (blob) => blob === successfulBlob ? 'blob:successful' : 'blob:unexpected',
      revokeObjectURL: vi.fn(),
    });

    await load.done;

    expect(Object.fromEntries(previews)).toEqual({ failed: null, successful: 'blob:successful' });
  });

  it('revokes an object URL created after cleanup when the blob resolves late', async () => {
    const lateBlob = deferred<Blob>();
    const onPreview = vi.fn();
    const createObjectURL = vi.fn(() => 'blob:late');
    const revokeObjectURL = vi.fn();
    const load = beginArtifactPreviewLoad({
      artifactIds: ['late'],
      getBlob: () => lateBlob.promise,
      onPreview,
      createObjectURL,
      revokeObjectURL,
    });

    load.dispose();
    lateBlob.resolve(new Blob(['late preview']));
    await load.done;

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:late');
    expect(onPreview).not.toHaveBeenCalled();
  });
});
