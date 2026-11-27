import type { DisassemblerResultMap, DisassemblerStatus } from "@omp-studio/studio-protocol";

export const PREVIEW_DISASSEMBLER: DisassemblerStatus = {
  backend: "auto", activeBackend: "ida", maxOpen: 4, idleCloseSec: 900, available: true,
  backends: { ida: { state: "ready" }, ghidra: { state: "ready" }, binja: { state: "ready" } },
  binjaInstallDir: "", binjaPython: "",
  databases: [
    { id: "demo-db", backend: "ida", label: "sample.exe", identity: "preview-demo-db", version: 1, name: "omp.ida", ref: "sample.exe", path: "sample.i64", state: "open", module: "sample.exe", format: "PE", arch: "x86", bitness: 64, busy: false, dirty: false },
    { id: "demo-library", backend: "ghidra", label: "parser.dll", identity: "preview-demo-library", version: 1, name: "parser", ref: "parser.dll", path: "parser.gpr", state: "open", module: "parser.dll", format: "PE", arch: "x86", bitness: 64, busy: false, dirty: true },
    { id: "demo-binja", backend: "binja", label: "codec.so", identity: "preview-binja", version: 1, name: "codec", ref: "codec.so", path: "codec.bndb", state: "open", module: "codec.so", format: "ELF", arch: "aarch64", bitness: 64, busy: false, dirty: false },
  ],
};

export const PREVIEW_DISASSEMBLER_PYTHON = `# db is the current ida_domain Database.
# This namespace is shared with agents using this database.
import ida_funcs
import ida_name

address = ida_funcs.get_next_func(0)
if address:
    print(hex(address.start_ea), ida_name.get_name(address.start_ea))
`;

export const PREVIEW_DISASSEMBLER_RESULT: DisassemblerResultMap["disassembler.run"] = {
  output: "0x140001000 main", value: null, error: null, truncated: false,
  backup: "sample.before-run.i64", resultFile: "disassembler-result.txt",
};

export const PREVIEW_BINARY_HEADER = "PE32+ executable (console)\nMachine: AMD64 (0x8664)\nEntry point: 0x140001000\nImage base: 0x140000000\nSections: .text, .rdata, .data, .pdata";
