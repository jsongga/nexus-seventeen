export interface SinkCollection { readonly id: string; readonly name: string }
export interface SinkDocument { readonly id: string; readonly title: string; readonly text: string }
export interface DocsSink {
  ensureCollection(repoName: string): Promise<SinkCollection>;
  listDocuments(collection: SinkCollection): Promise<readonly SinkDocument[]>;
  createDocument(collection: SinkCollection, title: string, text: string): Promise<void>;
  updateDocument(documentId: string, title: string, text: string): Promise<void>;
  archiveDocument(documentId: string): Promise<void>;
}
