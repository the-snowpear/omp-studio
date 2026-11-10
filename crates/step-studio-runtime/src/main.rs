//! Step Studio's Studio Bridge adapter in Rust.
//!
//! Speaks the same framed protocol the Host expects, and drives
//! `step --mode rpc --include-live-events` behind it. The TypeScript adapter
//! this replaces was 64 MB of Node doing frame codec and JSONL forwarding.

use step_studio_runtime::bridge_server::Runtime;
use step_studio_runtime::config::parse_args;

fn main() {
    let config = match parse_args(std::env::args().skip(1)) {
        Ok(config) => config,
        Err(message) => {
            eprintln!("step-studio-runtime: {message}");
            std::process::exit(2);
        }
    };
    let runtime = Runtime::new(config);
    if let Err(error) = runtime.serve() {
        eprintln!("step-studio-runtime: {error}");
        std::process::exit(1);
    }
}
