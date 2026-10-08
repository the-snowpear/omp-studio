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

        # The published close-and-save path must checkpoint before DB.close too.
        functions = [node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == "_handle"]
        sent, closes = [], []
        scope.update({"json": __import__("json"), "sys": sys, "traceback": __import__("traceback"),
                      "uuid": types.SimpleNamespace(uuid4=lambda: types.SimpleNamespace(hex="close")),
                      "_STUDIO_IDENTITY": "db", "_STUDIO_VERSION": 0, "_arm_sigint": lambda: None,
                      "_send": sent.append, "_error": str,
                      "DB": types.SimpleNamespace(close=lambda save: closes.append(save))})
        exec(compile(ast.Module(body=functions, type_ignores=[]), str(worker), "exec"), scope)
        def close_request():
            scope["_handle"](scope["json"].dumps({"id": 1, "method": "studio", "params": {
                "method": "close", "identity": "db", "version": scope["_STUDIO_VERSION"],
                "params": {"save": True}}}))
        close_request()
        assert sent[-1]["ok"] is False and not closes
        assert source.read_bytes() == b"newer-change"
        # Restore the real save function and verify both recoverable versions.
        save_node = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == "_rpc_save")
        exec(compile(ast.Module(body=[save_node], type_ignores=[]), str(worker), "exec"), scope)
        try:
            close_request()
        except SystemExit as error:
            assert error.code == 0
        else:
            raise AssertionError("Successful close did not exit")
        assert closes == [True] and sent[-1]["ok"]
        close_backup = pathlib.Path(sent[-1]["result"]["result"]["backup"])
        assert close_backup.read_bytes() == b"current-in-memory"
        assert pathlib.Path(str(close_backup) + ".before-flush").read_bytes() == b"newer-change"
    print("IDA checkpoint: current state, original disk state, exclusive copies and fail-closed execution/close passed")


if __name__ == "__main__":
    main()
