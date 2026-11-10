import type { StudioIdaResultMap, StudioIdaStatus } from "@omp-studio/studio-protocol";

export const PREVIEW_IDA: StudioIdaStatus = {
  enabled: true, available: true, installDir: "", python: "",
  databases: [
    { id: "demo-db", name: "omp.ida", ref: "sample.exe", path: "sample.i64", state: "open", module: "sample.exe", format: "PE", arch: "x86", bitness: 64, busy: false, dirty: false },
    { id: "demo-library", name: "parser", ref: "parser.dll", path: "parser.i64", state: "open", module: "parser.dll", format: "PE", arch: "x86", bitness: 64, busy: false, dirty: true },
  ],
};

export const PREVIEW_IDA_PYTHON = `# db is the current ida_domain Database.
# This namespace is shared with agents using this database.
import ida_funcs
import ida_name

address = ida_funcs.get_next_func(0)
if address:
    print(hex(address.start_ea), ida_name.get_name(address.start_ea))
`;

export const PREVIEW_IDA_RESULT: StudioIdaResultMap["ida.run"] = {
  output: "0x140001000 main", value: null, error: null, truncated: false,
  backup: "sample.before-run.i64", resultFile: "ida-result.txt",
};
