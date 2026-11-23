//! Gemfile.lock パーサ（Bundler を呼ばずに解析するので高速・Ruby 未インストールでも動く）

use regex::Regex;
use serde::Serialize;
use serde_json::{Map, Value};
use std::sync::LazyLock;

static RE_NAME_VERSION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^([^\s(!]+)(?:\s+\(([^)]*)\))?(!)?$").unwrap());
static RE_SOURCE_KV: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(remote|revision|branch|ref|tag|glob|submodules):\s*(.*)$").unwrap());
static RE_RUBY_PREFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^ruby\s+").unwrap());
static RE_OUTDATED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([^\s(!]+)\s+\((.+)\)$").unwrap());
static RE_OUTDATED_KV: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(newest|installed|requested)\s+(.+)$").unwrap());

#[derive(Debug, Clone, Serialize, Default)]
pub struct Source {
    #[serde(rename = "type")]
    pub kind: String,
    pub remote: Option<String>,
    pub revision: Option<String>,
    pub branch: Option<String>,
    #[serde(rename = "ref")]
    pub reference: Option<String>,
    pub tag: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Dep {
    pub name: String,
    pub requirement: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Spec {
    pub name: String,
    pub version: String,
    pub platform: Option<String>,
    pub source_type: String,
    pub remote: Option<String>,
    pub deps: Vec<Dep>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Dependency {
    pub name: String,
    pub requirement: Option<String>,
    pub pinned: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Lockfile {
    pub sources: Vec<Source>,
    pub specs: Vec<Spec>,
    pub dependencies: Vec<Dependency>,
    pub platforms: Vec<String>,
    pub ruby_version: Option<String>,
    pub bundled_with: Option<String>,
}

struct NameVersion {
    name: String,
    inner: String,
    pinned: bool,
}

fn parse_name_version(line: &str) -> Option<NameVersion> {
    let m = RE_NAME_VERSION.captures(line.trim())?;
    Some(NameVersion {
        name: m[1].to_string(),
        inner: m.get(2).map_or("", |x| x.as_str()).to_string(),
        pinned: m.get(3).is_some(),
    })
}

fn non_empty(s: String) -> Option<String> {
    if s.is_empty() { None } else { Some(s) }
}

pub fn parse_lockfile(text: &str) -> Lockfile {
    let mut result = Lockfile::default();
    let mut section = String::new();
    let mut in_source = false;
    let mut has_spec = false;

    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        if !line.starts_with(char::is_whitespace) {
            section = line.trim().to_string();
            has_spec = false;
            in_source = matches!(section.as_str(), "GEM" | "GIT" | "PATH" | "PLUGIN SOURCE");
            if in_source {
                result.sources.push(Source { kind: section.clone(), ..Default::default() });
            }
            continue;
        }
        let indent = line.len() - line.trim_start_matches(' ').len();
        if in_source {
            let source = result.sources.last_mut().unwrap();
            if indent == 2 {
                if let Some(kv) = RE_SOURCE_KV.captures(line.trim()) {
                    let val = Some(kv[2].to_string());
                    match &kv[1] {
                        "remote" => source.remote = val,
                        "revision" => source.revision = val,
                        "branch" => source.branch = val,
                        "ref" => source.reference = val,
                        "tag" => source.tag = val,
                        _ => {}
                    }
                }
                continue; // "specs:" など
            }
            if indent == 4 {
                let Some(nv) = parse_name_version(line) else { continue };
                let (version, platform) = match nv.inner.find('-') {
                    Some(i) => (nv.inner[..i].to_string(), Some(nv.inner[i + 1..].to_string())),
                    None => (nv.inner.clone(), None),
                };
                let (source_type, remote) = (source.kind.clone(), source.remote.clone());
                result.specs.push(Spec { name: nv.name, version, platform, source_type, remote, deps: vec![] });
                has_spec = true;
            } else if indent == 6 && has_spec {
                if let Some(nv) = parse_name_version(line) {
                    result.specs.last_mut().unwrap().deps.push(Dep { name: nv.name, requirement: non_empty(nv.inner) });
                }
            }
            continue;
        }
        match section.as_str() {
            "PLATFORMS" => result.platforms.push(line.trim().to_string()),
            "DEPENDENCIES" => {
                if let Some(nv) = parse_name_version(line) {
                    result.dependencies.push(Dependency { name: nv.name, requirement: non_empty(nv.inner), pinned: nv.pinned });
                }
            }
            "RUBY VERSION" => result.ruby_version = Some(RE_RUBY_PREFIX.replace(line.trim(), "").into_owned()),
            "BUNDLED WITH" => result.bundled_with = Some(line.trim().to_string()),
            _ => {}
        }
    }
    result
}

/// `bundle outdated --parseable` の出力を解析。{ gem名: { name, newest, installed, requested } }
pub fn parse_outdated(text: &str) -> Map<String, Value> {
    let mut out = Map::new();
    for line in text.lines() {
        let Some(m) = RE_OUTDATED.captures(line.trim()) else { continue };
        let mut info = Map::new();
        info.insert("name".into(), Value::from(&m[1]));
        for part in m[2].split(',') {
            if let Some(kv) = RE_OUTDATED_KV.captures(part.trim()) {
                info.insert(kv[1].to_string(), Value::from(kv[2].trim()));
            }
        }
        if info.contains_key("newest") {
            out.insert(m[1].to_string(), Value::Object(info));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_sample_lockfile() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/sample/Gemfile.lock");
        let lock = parse_lockfile(&std::fs::read_to_string(path).unwrap());
        assert_eq!(lock.bundled_with.as_deref(), Some("2.5.22"));
        assert_eq!(lock.ruby_version.as_deref(), Some("3.3.6p108"));
        assert_eq!(lock.platforms, ["arm64-darwin", "x86_64-linux"]);
        assert_eq!(lock.specs.len(), 4);
        let noko = lock.specs.iter().find(|s| s.name == "nokogiri").unwrap();
        assert_eq!(noko.version, "1.16.0");
        assert_eq!(noko.platform.as_deref(), Some("arm64-darwin"));
        assert_eq!(noko.deps, [Dep { name: "racc".into(), requirement: Some("~> 1.4".into()) }]);
        assert_eq!(lock.specs.iter().find(|s| s.name == "mygem").unwrap().source_type, "GIT");
        let deps: Vec<_> = lock.dependencies.iter().map(|d| (d.name.as_str(), d.pinned)).collect();
        assert_eq!(deps, [("mygem", true), ("rails", false)]);
        assert_eq!(lock.sources[0].branch.as_deref(), Some("main"));
    }

    #[test]
    fn parse_outdated_output() {
        let o = parse_outdated(
            "Fetching gem metadata\nrack (newest 3.0.8, installed 2.2.8, requested ~> 2.2)\nrake (newest 13.2.1, installed 13.0.6)\n",
        );
        assert_eq!(o.keys().collect::<Vec<_>>(), ["rack", "rake"]);
        assert_eq!(o["rack"]["requested"], "~> 2.2");
    }
}
