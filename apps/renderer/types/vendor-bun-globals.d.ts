// The vendored sources compiled through the renderer's path map reference a
// few Bun globals. Naming just those keeps the browser typecheck honest
// without pulling full Bun types into every workspace package.

declare const Bun: {
  color(color: string, format: "hex"): string | null;
  color(color: string, format: "ansi-16m" | "ansi-256"): string | null;
  stringWidth(text: string, options?: { countAnsiEscapeCodes?: boolean; ambiguousIsNarrow?: boolean }): number;
  CryptoHasher: new (algorithm: string) => {
    update(data: Uint8Array | string): this;
    digest(format: "hex"): string;
  };
};
