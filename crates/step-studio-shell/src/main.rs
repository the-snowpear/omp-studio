//! Step Studio's native shell: egui over winit, no webview, no Electron.

use std::path::PathBuf;

use eframe::egui;

/// The installed Step Code CLI, resolved when neither environment variable
/// names it. `PATH` first; then the installer's default location, which it
/// does not add to `PATH`.
fn find_step_cli() -> String {
    if let Some(found) = find_on_path("step") {
        return found;
    }
    if let Some(home) = std::env::var_os("HOME") {
        let installed = PathBuf::from(home).join(".stepcode/bin/step");
        if installed.is_file() {
            return installed.to_string_lossy().to_string();
        }
    }
    "step".to_string()
}

/// First `name` on `PATH` that is a file, so a directory named `step` never
/// wins.
fn find_on_path(name: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
        .map(|found| found.to_string_lossy().to_string())
}

fn main() -> eframe::Result {
    // `--prompt` sends one turn on start, which is how the shell is driven from
    // a script; `--step-cmd` names the Step Code runtime to bridge to;
    // `--screenshot` captures the frame after the turn settles and exits.
    let mut prompt: Option<String> = None;
    let mut screenshot: Option<PathBuf> = None;
    let mut step_command = std::env::var("STEP_STUDIO_STEP_CMD")
        .or_else(|_| std::env::var("STEP_STUDIO_RUNTIME_CMD"))
        .unwrap_or_else(|_| find_step_cli());
    // The project the agent works in. Defaults to where the shell was started:
    // a build-time path is meaningless once the binary is copied somewhere else.
    let mut repo_root = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--prompt" => prompt = args.next(),
            "--screenshot" => screenshot = args.next().map(PathBuf::from),
            "--step-cmd" => {
                if let Some(value) = args.next() {
                    step_command = value;
                }
            }
            "--repo" => {
                if let Some(value) = args.next() {
                    repo_root = PathBuf::from(value);
                }
            }
            other => eprintln!("step-studio-shell: ignoring unknown argument {other}"),
        }
    }

    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_title("Step Studio")
            .with_inner_size([1100.0, 720.0]),
        ..Default::default()
    };

    let mut app = step_studio_shell::app::App::connect(repo_root, step_command);
    if let Some(text) = prompt {
        app.send(text);
    }

    eframe::run_native(
        "Step Studio",
        options,
        Box::new(move |cc| {
            Ok(Box::new(step_studio_shell::shell::ShellApp::new(
                app,
                screenshot,
                cc,
            )))
        }),
    )
}
