//! Rendering. Split from `app.rs` so the state machine stays testable.

use eframe::egui;

use crate::app::{App, Status};

impl App {
    pub(crate) fn render_chrome(&mut self, ctx: &egui::Context) {
        egui::TopBottomPanel::top("chrome").show(ctx, |ui| {
            ui.horizontal_wrapped(|ui| {
                ui.heading("Step Studio");
                let (label, colour) = match self.status {
                    Status::Connecting => ("connecting…", egui::Color32::YELLOW),
                    Status::Ready => ("ready", egui::Color32::GREEN),
                    Status::Failed => ("failed", egui::Color32::RED),
                };
                ui.colored_label(colour, label);
                if !self.status_detail.is_empty() {
                    ui.small(&self.status_detail);
                }

                ui.separator();
                ui.label("model");
                let current = self.model.clone().unwrap_or_else(|| "—".to_string());
                egui::ComboBox::from_id_salt("model-picker")
                    .selected_text(short_model(&current))
                    .show_ui(ui, |ui| {
                        // Clone the rows first: the click handler needs `&mut self`.
                        let rows: Vec<(bool, String)> = self
                            .models
                            .iter()
                            .map(|model| {
                                (
                                    self.model.as_deref() == Some(model.selector.as_str()),
                                    model.name.clone(),
                                )
                            })
                            .collect();
                        for (index, (selected, name)) in rows.iter().enumerate() {
                            if ui.selectable_label(*selected, name).clicked() {
                                if let Some(model) = self.models.get(index) {
                                    self.set_model(model.selector.clone());
                                }
                            }
                        }
                    });

                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    ui.small(format!("session {}", short_id(&self.session_id)));
                    ui.checkbox(&mut self.show_thinking, "thinking");
                });
            });
        });
    }

    pub(crate) fn render_conversation(&mut self, ctx: &egui::Context) {
        egui::CentralPanel::default().show(ctx, |ui| {
            egui::ScrollArea::vertical()
                .auto_shrink([false, false])
                .stick_to_bottom(true)
                .show(ui, |ui| {
                    if self.turns.is_empty() {
                        ui.vertical_centered(|ui| {
                            ui.add_space(48.0);
                            ui.heading("Step Studio");
                            ui.label("native shell · no webview · no Electron");
                            ui.add_space(8.0);
                            ui.small("Send a message to start a turn.");
                        });
                        return;
                    }
                    for turn in &self.turns {
                        ui.add_space(10.0);
                        ui.horizontal(|ui| {
                            ui.label(
                                egui::RichText::new("you").strong().color(egui::Color32::LIGHT_BLUE),
                            );
                            ui.label(&turn.user);
                        });

                        let assistant = &turn.assistant;
                        if self.show_thinking && !assistant.thinking.is_empty() {
                            ui.horizontal_top(|ui| {
                                ui.label(egui::RichText::new("thinking").weak());
                                ui.label(
                                    egui::RichText::new(&assistant.thinking).weak().small(),
                                );
                            });
                        }
                        for tool in &assistant.tools {
                            let colour = if tool.is_error {
                                egui::Color32::RED
                            } else if tool.done {
                                egui::Color32::GREEN
                            } else {
                                egui::Color32::YELLOW
                            };
                            ui.horizontal_top(|ui| {
                                ui.colored_label(colour, format!("⚙ {}", tool.name));
                                if tool.done && !tool.output.is_empty() {
                                    ui.label(
                                        egui::RichText::new(truncate(&tool.output, 400))
                                            .weak()
                                            .small(),
                                    );
                                }
                            });
                        }
                        if !assistant.text.is_empty() {
                            ui.horizontal_top(|ui| {
                                ui.label(
                                    egui::RichText::new("step")
                                        .strong()
                                        .color(egui::Color32::LIGHT_GREEN),
                                );
                                ui.label(&assistant.text);
                            });
                        }
                        if let Some(error) = &assistant.error {
                            ui.colored_label(egui::Color32::RED, format!("turn failed: {error}"));
                        }
                    }
                });
        });
    }

    pub(crate) fn render_composer(&mut self, ctx: &egui::Context) {
        egui::TopBottomPanel::bottom("composer").show(ctx, |ui| {
            ui.horizontal(|ui| {
                // The action swaps to Stop mid-turn: the runtime can abort a
                // turn in flight, and a second prompt would compete with the
                // running one for the shared event stream.
                let streaming = self.streaming();
                let (label, width) = if streaming {
                    ("Stop", 52.0)
                } else {
                    ("Send", 60.0)
                };
                let response = ui.add_sized(
                    [ui.available_width() - width - 8.0, 28.0],
                    egui::TextEdit::singleline(&mut self.composer)
                        .hint_text("message Step…")
                        .id(egui::Id::new("composer")),
                );
                let enter = response.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter));
                let clicked = ui.button(label).clicked();
                if streaming {
                    if clicked {
                        self.abort();
                    }
                } else if (enter || clicked) && !self.composer.trim().is_empty() {
                    let text = std::mem::take(&mut self.composer);
                    self.send(text);
                    response.request_focus();
                }
            });
        });
    }
}

fn short_model(selector: &str) -> String {
    selector.rsplit('/').next().unwrap_or(selector).to_string()
}

fn short_id(id: &str) -> String {
    if id.len() <= 8 {
        id.to_string()
    } else {
        id[..8].to_string()
    }
}

fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_string()
    } else {
        let head: String = text.chars().take(max).collect();
        format!("{head}…")
    }
}
