//! The fork's own names, in one place.
//!
//! Every persistent or runtime name this fork owns — the Tauri identifier, the cache
//! directory that holds the control descriptor, the shell-integration directory, the
//! environment variables a terminal exposes, the hook markers written into agent
//! configuration and the git ref/metadata namespaces — comes from the table in
//! `src/modules/identity/namespace.json`. The upstream identity lives there too, so a
//! test can prove the two never collide, and so code that must *refuse* upstream state
//! (rather than read, overwrite or delete it) has the upstream names to refuse.
//!
//! The publication identity (`Codr`, `io.github.kevsmir02.codr`, `codr`, `CODR`) was
//! finalized under #40. Renaming the fork requires updating `src/modules/identity/namespace.json`
//! and `src-tauri/tauri.conf.json` (whose literal fields the tests below check against this table),
//! and is a breaking change for installed packages and update endpoints.

use serde::Deserialize;
use std::path::PathBuf;
use std::sync::OnceLock;

const TABLE: &str = include_str!("../../../src/modules/identity/namespace.json");

#[derive(Deserialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Upstream {
    pub app_identifier: String,
    pub namespace: String,
    pub env_prefix: String,
    pub product_name: String,
    pub publisher: String,
}

/// The settled package/install identity of the fork (`Codr`), derived from
/// `src/modules/identity/namespace.json`. The packaging script (`scripts/package-candidate/run.py`)
/// generates bundle configuration overlays from these fields instead of repeating literals.
#[derive(Deserialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Packaging {
    pub product_name: String,
    pub vendor: String,
    pub package_name: String,
    pub cli_binary_name: String,
    pub short_description: String,
    pub long_description: String,
}

#[derive(Deserialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Table {
    pub provisional: bool,
    pub note: String,
    pub final_identity_ticket: u32,
    pub app_identifier: String,
    pub namespace: String,
    pub env_prefix: String,
    pub packaging: Packaging,
    /// Child-process variables this fork keeps at their upstream name on purpose: they
    /// are the contract of `~/.terax/project.toml` scripts shared with upstream projects
    /// (`TERAX_PORT` and friends), not fork-owned state.
    pub shared_child_env: Vec<String>,
    pub upstream: Upstream,
}

fn table() -> &'static Table {
    static TABLE_ONCE: OnceLock<Table> = OnceLock::new();
    TABLE_ONCE.get_or_init(|| serde_json::from_str(TABLE).expect("valid identity table"))
}

/// The Tauri/bundle identifier of this fork (holds no branding claim).
pub fn app_identifier() -> &'static str {
    &table().app_identifier
}

/// The single filesystem token: `<token>` directories, files and refs are ours.
pub fn namespace() -> &'static str {
    &table().namespace
}

/// Prefix of every environment variable this fork sets for a child process.
pub fn env_prefix() -> &'static str {
    &table().env_prefix
}

/// An environment variable of this fork, e.g. `env("CLI")` -> `CODR_CLI`.
pub fn env(suffix: &str) -> String {
    format!("{}_{suffix}", table().env_prefix)
}

/// The upstream identity this fork must never silently read, overwrite or delete.
pub fn upstream() -> &'static Upstream {
    &table().upstream
}

/// The package/install identity of the Linux candidate builds (private working values).
pub fn packaging() -> &'static Packaging {
    &table().packaging
}

/// The installed name of the bundled CLI sidecar. Upstream ships `terax-cli`; a candidate
/// package must not install over that path, so the sidecar is renamed with the fork's
/// package identity while the *launcher* command keeps its documented name (ticket #39).
pub fn cli_binary_name() -> &'static str {
    &table().packaging.cli_binary_name
}

/// An environment variable of the upstream application, e.g. `upstream_env("CLI")` ->
/// `TERAX_CLI`. A child shell carrying one of these belongs to the other installation.
pub fn upstream_env(suffix: &str) -> String {
    format!("{}_{suffix}", table().upstream.env_prefix)
}

/// True when `identifier` belongs to the upstream application (its own profile).
pub fn is_upstream_identifier(identifier: &str) -> bool {
    identifier == table().upstream.app_identifier
        || identifier.starts_with(&format!("{}.", table().upstream.app_identifier))
}

/// This fork's private directory in the user cache (`control.json`, per-pid launchers).
pub fn cache_dir() -> Option<PathBuf> {
    dirs::cache_dir().map(|cache| cache.join(namespace()))
}

/// The private per-user directory name of this fork (`.<namespace>`).
pub fn home_dir_name() -> String {
    format!(".{}", namespace())
}

/// The fork's private per-user directory (task worktrees and their registry).
pub fn home_state_dir(home: &std::path::Path) -> PathBuf {
    home.join(home_dir_name())
}

/// The upstream application's cache directory, which this fork refuses to touch.
pub fn upstream_cache_dir() -> Option<PathBuf> {
    dirs::cache_dir().map(|cache| cache.join(&table().upstream.namespace))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(raw: &str) -> serde_json::Value {
        serde_json::from_str(raw).expect("valid json")
    }

    #[test]
    fn the_working_identity_is_finalized_and_not_upstream() {
        let table = table();
        assert!(!table.provisional, "the working identity is finalized");
        assert_eq!(table.app_identifier, "io.github.kevsmir02.codr");
        assert_eq!(table.namespace, "codr");
        assert_eq!(table.env_prefix, "CODR");
        assert!(table.final_identity_ticket > 0);
        assert!(!table.note.is_empty());
        assert_ne!(table.app_identifier, table.upstream.app_identifier);
        assert!(!table
            .app_identifier
            .starts_with(&table.upstream.app_identifier));
        assert_ne!(table.namespace, table.upstream.namespace);
        assert_ne!(table.env_prefix, "TERAX");
    }

    #[test]
    fn the_candidate_packaging_identity_is_private_and_not_upstream() {
        let packaging = packaging();
        let upstream = upstream();
        for name in [
            packaging.product_name.as_str(),
            packaging.vendor.as_str(),
            packaging.package_name.as_str(),
        ] {
            assert!(!name.eq_ignore_ascii_case("terax"), "{name} reuses upstream branding");
            assert!(!name.contains("Crynta"), "{name} reuses upstream branding");
            assert!(!name.contains("crynta"), "{name} reuses upstream branding");
        }
        // A candidate package installs into its own paths: no `/usr/bin/terax`, no
        // `/usr/bin/terax-cli`, so it cannot overwrite an installed upstream build.
        assert_eq!(packaging.package_name, packaging.package_name.to_lowercase());
        assert!(packaging.package_name.contains(namespace()));
        assert_ne!(packaging.package_name, upstream.namespace);
        assert_ne!(cli_binary_name(), format!("{}-cli", upstream.namespace));
        assert!(cli_binary_name().contains(namespace()));
    }

    #[test]
    fn the_namespace_is_usable_as_a_directory_and_a_git_ref_component() {
        let namespace = namespace();
        assert!(!namespace.is_empty());
        assert!(
            namespace
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_'),
            "{namespace}"
        );
        assert!(!namespace.starts_with('-') && !namespace.starts_with('.'));
        // A ref path component may not contain `..`, spaces or control characters.
        assert!(!namespace.contains(".."));
    }

    #[test]
    fn the_env_prefix_is_an_uppercase_variable_prefix() {
        let prefix = env_prefix();
        assert!(
            prefix
                .chars()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_'),
            "{prefix}"
        );
        assert!(!prefix.ends_with('_'));
        assert_eq!(env("CLI"), format!("{prefix}_CLI"));
    }

    #[test]
    fn the_upstream_variables_are_named_so_a_shell_can_be_refused() {
        assert_eq!(upstream_env("CLI"), "TERAX_CLI");
        assert_eq!(upstream_env("CONTROL_ADDR"), "TERAX_CONTROL_ADDR");
        // For every variable this fork sets, the upstream variable of the same role is a
        // different name: a fork shell never advertises the other application's protocol.
        for suffix in [
            "CLI",
            "CONTROL_ADDR",
            "CONTROL_TOKEN",
            "PANE_ID",
            "TERMINAL",
            "BLOCKS",
            "USER_ZDOTDIR",
        ] {
            assert_ne!(env(suffix), upstream_env(suffix), "{suffix}");
        }
    }

    #[test]
    fn fork_variables_never_shadow_the_shared_project_script_contract() {
        let table = table();
        let prefix = format!("{}_", table.env_prefix);
        for name in &table.shared_child_env {
            assert!(
                !name.starts_with(&prefix),
                "{name} is shared with upstream project scripts but collides with the fork prefix"
            );
        }
    }

    #[test]
    fn the_tauri_identifier_literal_matches_the_table() {
        let config = parse(include_str!("../../tauri.conf.json"));
        assert_eq!(
            config["identifier"].as_str(),
            Some(app_identifier()),
            "src-tauri/tauri.conf.json must carry the identifier from the identity table"
        );
    }

    #[test]
    fn the_update_endpoint_is_fork_owned_and_not_upstreams_release_feed() {
        // Release identity is part of the fork identity: a build tool forces the updater
        // endpoint into tauri.conf.json, so it is compared against the contract table in
        // src/modules/updater/releaseContract.json instead of being trusted as a literal.
        let contract = parse(include_str!("../../../src/modules/updater/releaseContract.json"));
        let config = parse(include_str!("../../tauri.conf.json"));

        assert_eq!(contract["provisional"], serde_json::json!(false));
        assert_eq!(contract["channel"], serde_json::json!("stable"));

        let endpoints = contract["endpoints"]
            .as_array()
            .expect("endpoints array")
            .iter()
            .map(|value| value.as_str().expect("endpoint string").to_string())
            .collect::<Vec<_>>();
        assert_eq!(
            endpoints,
            vec!["https://github.com/kevsmir02/terax-ai/releases/latest/download/latest.json"]
        );

        let upstream = contract["upstream"]["endpoints"]
            .as_array()
            .expect("upstream endpoints array")
            .iter()
            .map(|value| value.as_str().expect("endpoint string").to_string())
            .collect::<Vec<_>>();
        assert!(
            !upstream.is_empty(),
            "the contract records upstream's feed so it can be refused"
        );
        for endpoint in &endpoints {
            assert!(
                !upstream.contains(endpoint),
                "{endpoint} is upstream's release feed"
            );
            assert!(
                !endpoint.contains("crynta"),
                "{endpoint} names the upstream release owner"
            );
            assert!(
                endpoint.starts_with("https://"),
                "the finalized endpoint must use HTTPS: {endpoint}"
            );
            let host = endpoint
                .split("://")
                .nth(1)
                .and_then(|rest| rest.split('/').next())
                .unwrap_or_default();
            assert!(
                !host.ends_with(".invalid"),
                "the finalized endpoint must not stay on .invalid: {endpoint}"
            );
        }

        let configured = config["plugins"]["updater"]["endpoints"]
            .as_array()
            .expect("tauri updater endpoints array")
            .iter()
            .map(|value| value.as_str().expect("endpoint string").to_string())
            .collect::<Vec<_>>();
        assert_eq!(
            configured, endpoints,
            "tauri.conf.json must mirror the fork release contract"
        );
        let pubkey = config["plugins"]["updater"]["pubkey"]
            .as_str()
            .unwrap_or_default();
        assert!(!pubkey.is_empty(), "the fork updater pubkey must be provisioned");
        assert_eq!(
            config["plugins"]["updater"]["pubkey"],
            contract["trust"]["publicKey"],
            "tauri.conf.json updater pubkey must match releaseContract.json"
        );
        assert!(
            !include_str!("../../tauri.conf.json").contains("3BABFD8AB60E3469"),
            "the upstream signing key must not remain in the fork config"
        );
    }

    #[test]
    fn the_upstream_identity_is_recognised_so_it_can_be_refused() {
        assert!(is_upstream_identifier("app.crynta.terax"));
        assert!(is_upstream_identifier("app.crynta.terax.app-lab-abc123"));
        assert!(!is_upstream_identifier(app_identifier()));
        assert!(!is_upstream_identifier("app.crynta.terax-fork"));
    }

    #[test]
    fn the_cache_directory_is_namespaced_and_not_the_upstream_one() {
        let Some(cache) = dirs::cache_dir() else {
            return;
        };
        assert_eq!(cache_dir(), Some(cache.join(namespace())));
        assert_eq!(upstream_cache_dir(), Some(cache.join("terax")));
        assert_ne!(cache_dir(), upstream_cache_dir());
    }
}
