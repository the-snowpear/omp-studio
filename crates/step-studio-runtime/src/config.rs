//! Command-line surface. The Host spawns this executable with the same
//! arguments the TypeScript adapter took, so a swap needs no Host change.

use crate::bridge_server::AdapterConfig;

/// Parse `--mode studio-host --bridge-endpoint ... --bridge-token-file ...
/// --bridge-runtime-epoch N --cwd DIR`.
pub fn parse_args(args: impl Iterator<Item = String>) -> Result<AdapterConfig, String> {
    let args: Vec<String> = args.collect();
    let mut endpoint = None;
    let mut token_file = None;
    let mut epoch = 1u64;
    let mut cwd = std::env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| ".".to_string());

    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--bridge-endpoint" => {
                index += 1;
                endpoint = args.get(index).cloned();
            }
            "--bridge-token-file" => {
                index += 1;
                token_file = args.get(index).cloned();
            }
            "--bridge-runtime-epoch" => {
                index += 1;
                epoch = args
                    .get(index)
                    .and_then(|v| v.parse().ok())
                    .ok_or("--bridge-runtime-epoch expects an integer")?;
            }
            "--cwd" => {
                index += 1;
                cwd = args.get(index).cloned().unwrap_or(cwd);
            }
            "--mode" => {
                index += 1;
                // Only studio-host is supported; anything else is a caller error.
                match args.get(index).map(|s| s.as_str()) {
                    Some("studio-host") => {}
                    _ => return Err("only --mode studio-host is supported".to_string()),
                }
            }
            other => return Err(format!("unknown argument {other}")),
        }
        index += 1;
    }

    let endpoint = endpoint.ok_or("--bridge-endpoint is required")?;
    let token_file = token_file.ok_or("--bridge-token-file is required")?;
    let token = std::fs::read_to_string(&token_file)
        .map_err(|e| format!("could not read bridge token: {e}"))?
        .trim()
        .to_string();
    if token.is_empty() {
        return Err("bridge token file is empty".to_string());
    }

    // The CLI to drive, and the environment it inherits. Overridable so the
    // same binary works against a dev checkout or an installed release.
    //
    // The environment is passed through whole: filtering it to a prefix broke
    // the turn — the CLI accepted the prompt, processed the user message, and
    // then produced no assistant reply at all.
    let step_command = std::env::var("STEP_STUDIO_STEP_CMD").unwrap_or_else(|_| "step".to_string());
    let step_env: Vec<(String, String)> = std::env::vars().collect();
    // Opt-in, and only here: the desktop Host spawns this adapter without it and
    // must keep starting a fresh session. An env var rather than a flag because
    // the Host builds the argument list and should not have to learn about it.
    let continue_session = std::env::var("STEP_STUDIO_SESSION")
        .map(|value| value == "continue")
        .unwrap_or(false);

    Ok(AdapterConfig {
        endpoint,
        token,
        runtime_epoch: epoch,
        cwd,
        step_command,
        step_env,
        continue_session,
    })
}
