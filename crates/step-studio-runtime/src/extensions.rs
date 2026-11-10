//! What Step has installed: extensions and the MCP servers they declare.
//!
//! Both are facts on disk, not runtime state — `step.plugin.json` lists an
//! extension's MCP servers in a standard shape, and the CLI exposes its command
//! catalog over RPC. Neither needs a bespoke adapter; they need a reader.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::step_rpc::StepRpc;

/// Where Step keeps its config: the parent of the agent directory, which is the
/// same resolution the CLI itself uses.
pub fn config_root() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("STEP_CONFIG_DIR") {
        return Some(PathBuf::from(dir));
    }
    let agent = std::env::var_os("STEP_CODING_AGENT_DIR")?;
    Some(PathBuf::from(agent).parent()?.to_path_buf())
}

/// Every `step.plugin.json` under `root`, and where it came from.
///
/// `marketplaces/` is the catalog and nests one level deeper
/// (`marketplaces/<marketplace>/<extension>/`), while `plugins/` is what is
/// installed. Both are scanned, because a catalog entry and its installed copy
/// are different facts — the panel says which is which rather than silently
/// showing one as the other.
fn manifests(root: &Path) -> Vec<(String, Value)> {
    let mut found: Vec<(String, Value)> = Vec::new();
    // The two trees nest differently: `marketplaces/<marketplace>/<extension>/`
    // is two deep, `plugins/<extension>/` is one. Scanning each at its own depth
    // is the whole difference between finding playwright and silently missing it.
    for (relative, installed, depth) in [
        ("marketplaces", false, 2usize),
        ("plugins", true, 1usize),
    ] {
        let base = root.join(relative);
        let Ok(top) = std::fs::read_dir(&base) else {
            continue;
        };
        let mut candidates: Vec<PathBuf> = Vec::new();
        for entry in top.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            if depth == 1 {
                candidates.push(path);
                continue;
            }
            // A marketplace is a directory of extension directories.
            let Ok(inner) = std::fs::read_dir(&path) else {
                continue;
            };
            candidates.extend(inner.flatten().map(|entry| entry.path()).filter(|p| p.is_dir()));
        }
        for extension_dir in candidates {
            {
                let manifest = extension_dir.join("step.plugin.json");
                let Ok(text) = std::fs::read_to_string(&manifest) else {
                    continue;
                };
                let Ok(mut value) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };
                let id = value
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if id.is_empty() {
                    continue;
                }
                if let Some(object) = value.as_object_mut() {
                    object.insert("installed".to_string(), json!(installed));
                }
                // An installed copy wins over its catalog entry.
                if let Some(existing) = found.iter_mut().find(|(known, _)| *known == id) {
                    if installed {
                        existing.1 = value;
                    }
                } else {
                    found.push((id, value));
                }
            }
        }
    }
    found
}

/// The installed extensions, each with the MCP servers it declares.
pub fn list_extensions(root: Option<&Path>) -> Vec<Value> {
    let Some(root) = root else {
        return Vec::new();
    };
    manifests(root)
        .into_iter()
        .map(|(_, manifest)| {
            let servers = manifest
                .get("mcpServers")
                .and_then(|s| s.as_object())
                .map(|servers| {
                    servers
                        .iter()
                        .map(|(name, spec)| {
                            json!({
                                "name": name,
                                "command": spec.get("command").and_then(|c| c.as_str()).unwrap_or(""),
                                "args": spec.get("args").and_then(|a| a.as_array()).cloned().unwrap_or_default(),
                            })
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            json!({
                "id": manifest.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                "name": manifest.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                "description": manifest.get("description").and_then(|v| v.as_str()).unwrap_or(""),
                "version": manifest.get("version").and_then(|v| v.as_str()).unwrap_or(""),
                "installed": manifest.get("installed").cloned().unwrap_or(json!(true)),
                "mcpServers": servers,
            })
        })
        .collect()
}

/// The CLI's command catalog: slash commands from every source, which is the
/// skills surface — there is no separate skills registry to read.
pub fn list_commands(step: &mut StepRpc) -> Result<Vec<Value>, String> {
    let catalog = step
        .request("get_commands", json!({}), std::time::Duration::from_secs(10))
        .map_err(|e| e.to_string())?;
    Ok(catalog
        .get("commands")
        .and_then(|c| c.as_array())
        .cloned()
        .unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Write an extension into `marketplaces/<marketplace>/<name>/` or
    /// `plugins/<name>/`, matching the real layout.
    fn write_extension(root: &Path, relative: &str, body: &str) {
        let dir = root.join(relative);
        std::fs::create_dir_all(&dir).expect("extension dir");
        std::fs::write(dir.join("step.plugin.json"), body).expect("write manifest");
    }

    /// The real config layout: an installed copy under `plugins/` and the same
    /// extension in the marketplace catalog it came from. The installed one wins,
    /// or a panel would show a stale version.
    #[test]
    fn an_installed_copy_wins_over_the_marketplace_catalog() {
        let dir = std::env::temp_dir().join(format!("ext-{}", std::process::id()));
        write_extension(
            &dir,
            "plugins/thing",
            r#"{"id":"thing","name":"Installed","version":"2.0.0"}"#,
        );
        write_extension(
            &dir,
            "marketplaces/builtin/thing",
            r#"{"id":"thing","name":"Catalog","version":"1.0.0"}"#,
        );

        let found = list_extensions(Some(&dir));
        assert_eq!(found.len(), 1, "one extension, not one per copy");
        assert_eq!(found[0]["name"], "Installed");
        assert_eq!(found[0]["version"], "2.0.0");
        assert_eq!(found[0]["installed"], json!(true));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A catalog entry nobody installed is still worth showing — it is a real MCP
    /// server the user could enable — but it must say it is not installed.
    #[test]
    fn a_catalog_entry_is_marked_uninstalled() {
        let dir = std::env::temp_dir().join(format!("ext-cat-{}", std::process::id()));
        write_extension(
            &dir,
            "marketplaces/builtin/playwright",
            r#"{"id":"playwright","name":"Playwright","version":"0.1.0","mcpServers":{"playwright":{"command":"npx","args":["@playwright/mcp@latest"]}}}"#,
        );

        let found = list_extensions(Some(&dir));
        assert_eq!(found.len(), 1);
        assert_eq!(found[0]["installed"], json!(false));
        assert_eq!(found[0]["mcpServers"][0]["name"], "playwright");
        assert_eq!(found[0]["mcpServers"][0]["command"], "npx");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An extension with no MCP servers still shows up, and its server list is
    /// empty rather than absent.
    #[test]
    fn an_extension_without_servers_lists_none() {
        let dir = std::env::temp_dir().join(format!("ext-none-{}", std::process::id()));
        write_extension(
            &dir,
            "plugins/plain",
            r#"{"id":"plain","name":"Plain","description":"no servers"}"#,
        );

        let found = list_extensions(Some(&dir));
        assert_eq!(found.len(), 1);
        assert_eq!(found[0]["mcpServers"], json!([]));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
