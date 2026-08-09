export interface ArtifactPreviewLoad {
  readonly done: Promise<void>;
  dispose(): void;
}

export interface ArtifactPreviewLoadOptions {
  artifactIds: readonly string[];
  getBlob: (artifactId: string, signal: AbortSignal) => Promise<Blob>;
  onPreview: (artifactId: string, url: string | null) => void;
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
}

/** Starts independent artifact loads and owns every object URL until disposal. */
export function beginArtifactPreviewLoad(options: ArtifactPreviewLoadOptions): ArtifactPreviewLoad {
  const controller = new AbortController();
  const created = new Set<string>();
  const createObjectURL = options.createObjectURL ?? ((blob: Blob) => URL.createObjectURL(blob));
  const revokeObjectURL = options.revokeObjectURL ?? ((url: string) => URL.revokeObjectURL(url));
  let disposed = false;

  const done = Promise.all(options.artifactIds.map(async (artifactId) => {
    let url: string;
    try {
      const blob = await options.getBlob(artifactId, controller.signal);
      url = createObjectURL(blob);
    } catch {
      if (!disposed) options.onPreview(artifactId, null);
      return;
    }
    if (disposed) {
      revokeObjectURL(url);
      return;
    }
    created.add(url);
    options.onPreview(artifactId, url);
  })).then(() => undefined);

  return {
    done,
    dispose() {
      if (disposed) return;
      disposed = true;
      controller.abort();
      for (const url of created) revokeObjectURL(url);
      created.clear();
    },
  };
}
