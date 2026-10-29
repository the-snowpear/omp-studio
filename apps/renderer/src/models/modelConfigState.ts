// Shared with navigation/target switching without loading the model settings page.
let modelConfigDirty = false;

export function modelConfigHasUnsavedChanges(): boolean {
  return modelConfigDirty;
}

export function setModelConfigDirty(dirty: boolean): void {
  modelConfigDirty = dirty;
}
