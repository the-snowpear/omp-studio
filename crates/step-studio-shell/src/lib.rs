//! The shell's state and rendering. Kept free of `eframe` so the app logic can
//! be unit-tested without a window.
pub mod app;
pub mod bridge_client;
pub mod markdown;
pub mod shell;
pub mod views;
