export interface WipeHost {
  editorDetach(): void;
  blockKeyboard(): void;
  cancelNetwork(): void;
  ydocDestroy(): void;
  modelDispose(): void;
  editorDispose(): void;
  previewRootReplaceChildren(): void;
  dropKeys(): void;
  socketClose(): void;
  clearCaches(): Promise<void>;
  unregisterServiceWorkers(): Promise<void>;
  navigate(locationHref: string): void;
}

export const TOMBSTONE_URL = "/gone.html";

export async function executeWipe(host: WipeHost, tombstoneUrl = TOMBSTONE_URL): Promise<void> {
  host.editorDetach();
  host.blockKeyboard();
  host.cancelNetwork();

  host.ydocDestroy();

  host.modelDispose();
  host.editorDispose();

  host.previewRootReplaceChildren();

  host.dropKeys();

  host.socketClose();

  await host.clearCaches();

  await host.unregisterServiceWorkers();

  try {
    history.replaceState(null, "", tombstoneUrl);
  } catch {
    void 0;
  }
  host.navigate(tombstoneUrl);
}
