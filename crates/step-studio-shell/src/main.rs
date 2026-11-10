//! Step Studio's native shell: egui over winit, no webview, no Electron.

use std::path::PathBuf;

use eframe::egui;

fn main() -> eframe::Result {
    // `--prompt` sends one turn on start, which is how the shell is driven from
    // a script; `--step-cmd` names the Step Code runtime to bridge to;
    // `--screenshot` captures the frame after the turn settles and exits.
    let mut prompt: Option<String> = None;
    let mut screenshot: Option<PathBuf> = None;
    let mut step_command = std::env::var("STEP_STUDIO_STEP_CMD").unwrap_or_else(|_| "step".to_string());
    let mut repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("repo root")
        .to_path_buf();

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
