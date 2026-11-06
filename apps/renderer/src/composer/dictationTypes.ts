export interface ComposerDictationBinding {
  enabled: boolean;
  active: boolean;
  toggleShortcut: string;
  holdKeys?: readonly string[];
  toggleKeys?: readonly string[];
  onStart(mode: "hold" | "toggle"): void;
  onStop(): void;
  onCancel(): void;
  onInterrupt(): void;
}

export interface ComposerDictationCommit {
  applied: boolean;
  unchanged: boolean;
}

export interface ComposerDictationHandle {
  beginDictation(id: string): boolean;
  updateDictation(id: string, committedText: string, partialText: string): void;
  commitDictation(id: string, text: string): ComposerDictationCommit;
  cancelDictation(id: string): void;
}
