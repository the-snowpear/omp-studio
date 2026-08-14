# Process Ownership and Containment Contract

Each `OMP runtime`, `Preview/dev server`, and `Studio helper` is a distinct ownership domain. User terminals are separate and default to terminate-with-Host in the MVP; future persistent terminals require an explicit opt-in and warning.

## Spawn

- Resolve the OMP executable to a verified absolute path before setting project `cwd`.
- Spawn with explicit argv and `shell: false`; wrapper scripts require a platform-specific launcher, never string concatenation.
- Pass a filtered environment. Log the binary path/version/hash for diagnostics, never secrets.
- Assign the child to its containment domain before allowing useful work.

## Windows

Create the root process suspended, create one Job Object per ownership domain
with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, assign the root to the job, then
resume it. Breakaway is disabled. Assignment failure terminates the suspended
child and fails startup. Descendants remain in the job; closing the job is the
final cleanup mechanism after graceful shutdown.

## macOS/Linux

Start a separate process group/session for each ownership domain and signal the group, not only the parent PID.

## Stop sequence

1. reject new work and mark the domain `stopping`;
2. send the supported graceful RPC/stdin shutdown or interrupt;
3. wait a bounded deadline while draining stdout/stderr;
4. terminate the whole process tree;
5. close handles, revoke runtime ownership and emit one terminal event.

Repeated stop is idempotent. Host crash, half-start, upgrade and child-spawn races are required test cases.
