"""Exercise the real worker functions without starting IDA or its stdin loop."""
import ast
import io
import os
import pathlib
import shutil
import sys
import tempfile
import types


def main():
    worker = pathlib.Path(sys.argv[1])
    module = ast.parse(worker.read_text(encoding="utf-8"))
    functions = [node for node in module.body if isinstance(node, ast.FunctionDef) and node.name in ("_rpc_save", "_rpc_exec")]
    with tempfile.TemporaryDirectory() as directory:
        source = pathlib.Path(directory) / "db.i64"
        backup = pathlib.Path(directory) / "checkpoint.i64"
        source.write_bytes(b"original-on-disk")
        def save_database(path, flags):
            pathlib.Path(path).write_bytes(b"current-in-memory")
            return True
        scope = {"os": os, "shutil": shutil, "_db": lambda: None, "_idb_path": lambda: str(source), "ida_loader": types.SimpleNamespace(save_database=save_database), "_DIRTY": True}
        exec(compile(ast.Module(body=functions, type_ignores=[]), str(worker), "exec"), scope)
        scope["_rpc_save"]({"studioBackup": str(backup)})
        assert backup.read_bytes() == b"current-in-memory"
        assert pathlib.Path(str(backup) + ".before-flush").read_bytes() == b"original-on-disk"
        source.write_bytes(b"newer-change")
        try:
            scope["_rpc_save"]({"studioBackup": str(backup)})
        except FileExistsError:
            pass
        else:
            raise AssertionError("Existing checkpoint was overwritten")
        assert source.read_bytes() == b"newer-change"
        assert backup.read_bytes() == b"current-in-memory"
        def failed_checkpoint(params):
            raise OSError("disk full")
        scope["_rpc_save"] = failed_checkpoint
        scope["io"] = io
        try:
            scope["_rpc_exec"]({"studioBackup": str(backup), "code": "raise AssertionError('must not execute')"})
        except OSError as error:
            assert str(error) == "disk full"
        else:
            raise AssertionError("Execution continued after a failed checkpoint")
    print("IDA checkpoint: current state, original disk state, exclusive copies and fail-closed execution passed")


if __name__ == "__main__":
    main()
