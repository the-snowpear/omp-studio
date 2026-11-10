//! The window wrapper: owns the app state plus the screenshot harness, so the
//! reducer itself stays free of window concerns.

use std::path::PathBuf;

use eframe::egui;

use crate::app::App;

pub struct ShellApp {
    app: App,
    screenshot: Option<PathBuf>,
    started: std::time::Instant,
    requested: bool,
}

impl ShellApp {
    pub fn new(app: App, screenshot: Option<PathBuf>, _cc: &eframe::CreationContext<'_>) -> Self {
        Self {
            app,
            screenshot,
            started: std::time::Instant::now(),
            requested: false,
        }
    }
}

impl eframe::App for ShellApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        if self.app.pump() || self.app.streaming() {
            ctx.request_repaint();
        }
        self.app.render_chrome(ctx);
        self.app.render_conversation(ctx);
        self.app.render_composer(ctx);

        // The captured frame arrives as a raw egui event on a later frame.
        if let Some(path) = self.screenshot.clone() {
            let captured = ctx.input(|input| {
                input.events.iter().find_map(|event| match event {
                    egui::Event::Screenshot { image, .. } => Some((**image).clone()),
                    _ => None,
                })
            });
            if let Some(image) = captured {
                match crate::shell::save_png(&path, &image) {
                    Ok(()) => {
                        eprintln!("screenshot written to {}", path.display());
                        ctx.send_viewport_cmd(egui::ViewportCommand::Close);
                    }
                    Err(error) => {
                        eprintln!("screenshot failed: {error}");
                        ctx.send_viewport_cmd(egui::ViewportCommand::Close);
                    }
                }
            }
        }

        // Ask once the turn has settled. The fallback is wall-clock, not frame
        // count: a real runtime spends tens of seconds booting its CLI before
        // the first snapshot, and a frame budget fires long before that.
        let settled = !self.app.streaming() && !self.app.turns.is_empty();
        let waited_long_enough = self.started.elapsed() > std::time::Duration::from_secs(150);
        if !self.requested && (settled || waited_long_enough) {
            if let Some(path) = self.screenshot.clone() {
                ctx.send_viewport_cmd(egui::ViewportCommand::Screenshot(
                    egui::UserData::new(path),
                ));
                self.requested = true;
            }
        }
    }

    fn save(&mut self, _storage: &mut dyn eframe::Storage) {}

    /// egui delivers the captured frame here.
    fn on_exit(&mut self, _gl: Option<&eframe::glow::Context>) {}
}

/// Save a captured frame. egui hands us the pixels; PNG is the only encoder we
/// need, so the `image` dependency is feature-gated to it.
pub fn save_png(path: &std::path::Path, image: &egui::ColorImage) -> Result<(), String> {
    let width = image.size[0] as u32;
    let height = image.size[1] as u32;
    let rgba = image::RgbaImage::from_fn(width, height, |x, y| {
        let pixel = image[(x as usize, y as usize)];
        image::Rgba([pixel.r(), pixel.g(), pixel.b(), pixel.a()])
    });
    rgba.save(path).map_err(|e| e.to_string())
}
