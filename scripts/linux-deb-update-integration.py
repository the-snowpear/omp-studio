#!/usr/bin/env python3
"""Exercise the privileged installer against real dpkg/apt in an isolated container.

Run only in a disposable Ubuntu 24.04 container with OMP_DEB_TEST_CONTAINER=1.
It installs a tiny fixture named omp-studio into that container's package database.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


if os.environ.get("OMP_DEB_TEST_CONTAINER") != "1" or os.geteuid() != 0 or not os.path.exists("/.dockerenv"):
    raise SystemExit("Run as root only in a disposable container with OMP_DEB_TEST_CONTAINER=1")


def run(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs)


def installed():
    return run("dpkg-query", "-W", "-f=${Version}", "omp-studio").stdout


with tempfile.TemporaryDirectory(prefix="omp-deb-integration-") as tmp:
    root = Path(tmp)
    root.chmod(0o755)
    helper = root / "omp-deb-update"
    shutil.copyfile("/repo/packaging/linux/omp-deb-update", helper)
    helper.chmod(0o755)
    keys = root / "runtime-keys"
    keys.mkdir()
    run("openssl", "genpkey", "-algorithm", "ed25519", "-out", str(root / "private.pem"))
    run("openssl", "pkey", "-in", str(root / "private.pem"), "-pubout", "-out", str(keys / "public.pem"))
    (keys / "trusted-keys.json").write_text(json.dumps({"keys": {"test": "public.pem"}}))
    packages = root / "downloads"
    packages.mkdir()

    def fixture(version, fail=False):
        tree = root / ("build-" + version)
        (tree / "DEBIAN").mkdir(parents=True)
        (tree / "DEBIAN/control").write_text("Package: omp-studio\nVersion: %s\nArchitecture: amd64\nMaintainer: test <test@example.invalid>\nDescription: isolated update fixture\n" % version)
        if fail:
            postinst = tree / "DEBIAN/postinst"
            postinst.write_text("#!/bin/sh\nexit 1\n")
            postinst.chmod(0o755)
        data = tree / "usr/share/omp-studio-integration"
        data.mkdir(parents=True)
        (data / "version").write_text(version)
        asset = "OMP-Studio-%s-linux-x64.deb" % version
        package = packages / asset
        run("dpkg-deb", "--build", "--root-owner-group", str(tree), str(package))
        contents = package.read_bytes()
        file = {"asset": asset, "url": "https://github.com/the-snowpear/omp-studio/releases/download/v%s/%s" % (version, asset), "size": len(contents), "sha256": hashlib.sha256(contents).hexdigest(), "sha512": base64.b64encode(hashlib.sha512(contents).digest()).decode()}
        manifest = {"schema": 2, "repo": "the-snowpear/omp-studio", "platform": "linux-x64", "generatedAt": "2026-11-17T00:00:00Z", "releaseNotesUrl": "https://github.com/the-snowpear/omp-studio/releases/tag/v%s" % version,
                    "app": {"version": version, "sequence": int(version[0]), "channel": "stable", "minAppVersion": "0.0.0", "studioProtocol": {"min": 1, "max": 1}, "file": file, "blockmap": file}}
        signature = root / "signature"
        # Sign with Node's production canonicalizer; Python in the privileged
        # helper must verify exactly the bytes the release builder signs.
        manifest_input = root / "manifest.json"
        manifest_input.write_text(json.dumps(manifest))
        node = r'''const fs = require("fs"), crypto = require("crypto");
const canonical = v => Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v !== null && typeof v === "object" ? `{${Object.entries(v).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}` : JSON.stringify(v);
const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
fs.writeFileSync(process.argv[3], crypto.sign(null, Buffer.from("omp-studio-update-v2\n" + canonical(value)), fs.readFileSync(process.argv[2])));'''
        run("node", "-e", node, str(manifest_input), str(root / "private.pem"), str(signature))
        catalog = packages / (version + ".json")
        catalog.write_text(json.dumps({"manifest": manifest, "signature": {"algorithm": "ed25519", "keyId": "test", "value": base64.urlsafe_b64encode(signature.read_bytes()).decode().rstrip("=")}}))
        os.chown(package, 65534, 65534)
        os.chown(catalog, 65534, 65534)
        return package, catalog

    old = fixture("1.0.0")
    new = fixture("2.0.0")
    bad_install = fixture("3.0.0", fail=True)
    run("dpkg", "-i", str(old[0]))
    assert installed() == "1.0.0"

    def helper_process(target, previous):
        env = {**os.environ, "PKEXEC_UID": "65534"}
        command = ["/usr/sbin/runuser", "-u", "nobody", "--", "/usr/bin/pkexec", str(helper)] if os.environ.get("OMP_DEB_TEST_PKEXEC") == "1" else ["/usr/bin/python3", "-I", str(helper)]
        return subprocess.Popen([*command, str(target[0]), str(target[1]), str(previous[0]), str(previous[1])], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)

    def line(process, expected):
        actual = process.stdout.readline().strip()
        if actual != expected:
            raise AssertionError("expected %r, got %r: %s" % (expected, actual, process.stderr.read()))

    if os.environ.get("OMP_DEB_TEST_PKEXEC") == "1":
        denied = subprocess.run(["/usr/sbin/runuser", "-u", "daemon", "--", "/usr/bin/pkexec", str(helper), str(new[0]), str(new[1]), str(old[0]), str(old[1])], input="", stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=15)
        assert denied.returncode != 0 and installed() == "1.0.0"
        print("PASS: polkit refusal leaves the installed package untouched")

    process = helper_process(new, old)
    line(process, "AUTHORIZED")
    assert installed() == "1.0.0", "authorization must not install before the old app exits"
    process.stdin.write("install\n"); process.stdin.flush()
    line(process, "INSTALLED")
    assert installed() == "2.0.0"
    process.stdin.write("commit\n"); process.stdin.flush()
    line(process, "COMMITTED")
    assert process.wait() == 0, process.stderr.read()
    print("PASS: signed upgrade and explicit commit")

    process = helper_process(old, new)
    line(process, "AUTHORIZED")
    process.stdin.write("install\n"); process.stdin.flush()
    line(process, "INSTALLED")
    assert installed() == "1.0.0"
    process.stdin.write("rollback\n"); process.stdin.flush()
    line(process, "ROLLED_BACK")
    assert process.wait() == 0, process.stderr.read()
    assert installed() == "2.0.0"
    print("PASS: startup failure restores the previous signed deb")

    process = helper_process(bad_install, new)
    line(process, "AUTHORIZED")
    process.stdin.write("install\n"); process.stdin.flush()
    line(process, "ROLLED_BACK")
    assert process.wait() == 0, process.stderr.read()
    assert installed() == "2.0.0"
    print("PASS: apt installation failure restores the previous signed deb")

    process = helper_process(old, new)
    line(process, "AUTHORIZED")
    process.stdin.write("cancel\n"); process.stdin.flush()
    assert process.wait() == 0, process.stderr.read()
    assert installed() == "2.0.0"
    print("PASS: cancelling before app exit leaves the installed package untouched")

    process = helper_process(old, new)
    line(process, "AUTHORIZED")
    process.stdin.write("install\n"); process.stdin.flush()
    line(process, "INSTALLED")
    process.stdin.close()
    line(process, "ROLLED_BACK")
    assert process.wait() == 0, process.stderr.read()
    assert installed() == "2.0.0"
    print("PASS: supervisor disappearance restores the previous package")

    if os.environ.get("OMP_DEB_TEST_SUPERVISOR") == "1":
        swap = root / "swap"
        swap.mkdir()
        os.chown(swap, 65534, 65534)
        launcher = root / "desktop"
        launcher.write_text("#!/bin/sh\nif [ \"$OMP_TEST_HEALTH\" = 1 ]; then printf healthy > \"$OMP_TEST_MARKER\"; sleep 1; else exit 1; fi\n")
        launcher.chmod(0o755)
        supervisor = root / "supervisor.cjs"
        run("node", "--input-type=module", "-e", 'import {writeFileSync} from "node:fs"; import {linuxDebSwapHelperSource} from "file:///repo/apps/desktop/dist/src/linux-deb-swap.js"; writeFileSync(process.argv[1], linuxDebSwapHelperSource());', str(supervisor))
        supervisor.chmod(0o755)

        def supervise(target, previous, healthy):
            for item in swap.iterdir():
                item.unlink()
            target_catalog = swap / "target.json"
            previous_catalog = swap / "previous.json"
            shutil.copyfile(target[1], target_catalog)
            shutil.copyfile(previous[1], previous_catalog)
            control = swap / "control"
            control.write_text("")
            for item in (target_catalog, previous_catalog, control):
                os.chown(item, 65534, 65534)
            version = json.loads(target_catalog.read_text())["manifest"]["app"]["version"]
            plan = {"schema": 1, "pid": 99999999, "target": str(launcher), "launchArguments": ["--omp-restarted"], "version": version,
                    "helper": str(helper), "packagePath": str(target[0]), "catalogPath": str(target_catalog), "previousPath": str(previous[0]), "previousCatalogPath": str(previous_catalog),
                    "ready": str(swap / "ready"), "outcome": str(swap / "outcome"), "started": str(swap / "started"), "healthy": str(swap / "healthy"), "cleanExit": str(swap / "clean"), "control": str(control),
                    "pollMs": 50, "exitTimeoutMs": 1000, "startTimeoutMs": 3000}
            plan_path = swap / "plan.json"
            plan_path.write_text(json.dumps(plan))
            os.chown(plan_path, 65534, 65534)
            env = {**os.environ, "OMP_TEST_HEALTH": "1" if healthy else "0", "OMP_TEST_MARKER": plan["healthy"]}
            run("/usr/sbin/runuser", "-u", "nobody", "--", "/usr/bin/node", str(supervisor), str(plan_path), env=env, timeout=90)
            return json.loads((swap / "outcome").read_text())["status"]

        assert supervise(old, new, True) == "installed"
        assert installed() == "1.0.0"
        assert supervise(new, old, False) == "rolled-back"
        assert installed() == "1.0.0"
        run("dpkg", "-i", str(new[0]))
        print("PASS: packaged supervisor coordinates real pkexec, apt, health confirmation and rollback")

    contents = new[0].read_bytes()
    new[0].write_bytes(contents + b"tampered")
    process = helper_process(new, old)
    assert process.wait() != 0
    assert "signed size" in process.stderr.read()
    assert installed() == "2.0.0"
    print("PASS: tampered download is rejected before installation")

    new[0].write_bytes(contents)
    original_catalog = new[1].read_text()
    altered = json.loads(original_catalog)
    altered["manifest"]["app"]["version"] = "9.0.0"
    new[1].write_text(json.dumps(altered))
    process = helper_process(new, old)
    assert process.wait() != 0
    assert installed() == "2.0.0"
    print("PASS: modified catalog signature is rejected before installation")

    new[1].write_text(original_catalog)
    os.chown(new[0], 0, 0)
    process = helper_process(new, old)
    assert process.wait() != 0
    assert "not owned by the requesting user" in process.stderr.read()
    assert installed() == "2.0.0"
    print("PASS: the privileged helper refuses another user's package")
