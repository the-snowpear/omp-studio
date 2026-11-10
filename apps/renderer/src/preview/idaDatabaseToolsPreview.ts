import type { IdaState, IdaView } from "@omp-studio/studio-protocol";
import { PREVIEW_IDA as databases } from "./idaPreview";

export const PREVIEW_IDA: IdaState = { available: true, databases: databases.databases.map(row => ({
  id: row.id, label: row.module, state: row.state, dirty: row.dirty, busy: row.busy, identity: `preview-${row.id}`, version: 1,
})) };
export const PREVIEW_IDA_TEXT = `// sample.exe : main
int main(int argc, char **argv)
{
    if (argc < 2)
        return print_usage(argv[0]);

    return parse_file(argv[1]);
}`;
export const PREVIEW_IDA_VIEWS: Record<IdaView, string> = {
  overview: `Module        sample.exe
Format        Portable executable (PE)
Architecture  x86 / 64-bit
Database      sample.i64

Segments
.text         0x140001000    Executable code
.rdata        0x140006000    Read-only data
.data         0x140008000    Initialized data

Entry points
0x140001000   main`,
  pseudocode: PREVIEW_IDA_TEXT,
  asm: `main:
0x140001000  sub     rsp, 28h
0x140001004  cmp     ecx, 2
0x140001007  jl      short usage
0x140001009  mov     rcx, [rdx+8]
0x14000100D  call    parse_file
0x140001012  add     rsp, 28h
0x140001016  retn`,
  functions: `Address           Name
0x140001000       main
0x140001040       print_usage
0x140001120       parse_file
0x1400012A0       parse_header
0x140001380       read_record
0x140001510       validate_checksum`,
  strings: `Address           String
0x140006000       "Usage: sample <file>"
0x140006018       "Unable to open input file"
0x140006040       "Invalid file header"
0x140006058       "Checksum mismatch"`,
  imports: `Module           Name
KERNEL32.dll     CreateFileW
KERNEL32.dll     ReadFile
KERNEL32.dll     CloseHandle
ucrtbase.dll     printf
ucrtbase.dll     malloc
ucrtbase.dll     free`,
  exports: "No exports.",
  xrefs: `Cross-references to parse_file
0x14000100D       main                 call`,
};
