import { nativeTableFigure, type NumericTableData } from "./native-table-chart";
self.onmessage = (event: MessageEvent<NumericTableData>) => {
  try {
    self.postMessage({ ok: true, figure: nativeTableFigure(event.data) });
  } catch (cause) {
    self.postMessage({
      ok: false,
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
};
