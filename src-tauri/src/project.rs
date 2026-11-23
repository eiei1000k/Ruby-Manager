//! リポジトリ（プロジェクト）単位の Ruby 指定・Bundler 状態の解析

use crate::lockfile::{parse_lockfile, Spec};
use crate::managers::Ruby;
use crate::versions as v;
use regex::Regex;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::path::Path;
use std::sync::LazyLock;

static RE_TOOL_VERSIONS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^ruby\s+(\S+)").unwrap());
static RE_MISE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?m)^\s*ruby\s*=\s*(?:\[\s*)?["']([^"']+)["']"#).unwrap());
static RE_GEMFILE_RUBY_FILE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?m)^\s*ruby\s*\(?\s*file:\s*["']([^"']+)["']"#).unwrap());
static RE_GEMFILE_RUBY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?m)^\s*ruby\s*\(?\s*((?:["'][^"']+["']\s*,?\s*)+)"#).unwrap());
static RE_QUOTED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"["']([^"']+)["']"#).unwrap());
static RE_BUNDLE_CONFIG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"^(BUNDLE_[A-Z0-9_]+):\s*"?(.*?)"?\s*$"#).unwrap());
static RE_HEAD_REF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"ref:\s*refs/heads/(.+)").unwrap());

/// 書き換え用（.tool-versions / mise.toml の ruby 行）
pub static RE_TOOL_VERSIONS_LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^ruby\s+\S+").unwrap());
pub static RE_MISE_LINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?m)^(\s*ruby\s*=\s*(?:\[\s*)?["'])[^"']+(["'])"#).unwrap());

/// UTF-8 として読む（BOM は除く）。読めなければ None
pub fn read(file: &Path) -> Option<String> {
    let bytes = std::fs::read(file).ok()?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    Some(text.strip_prefix('\u{feff}').map(String::from).unwrap_or(text))
}

fn first_existing<'a>(dir: &Path, names: &[&'a str]) -> Option<&'a str> {
    names.iter().copied().find(|n| dir.join(n).exists())
}

#[derive(Debug, Clone, Serialize)]
pub struct VersionSource {
    pub file: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct GemRuby {
    pub requirement: String,
    pub raw: String,
}

/// Gemfile の `ruby "..."` 指定を取り出す
pub fn gemfile_ruby(gemfile: &str, dir: &Path) -> Option<GemRuby> {
    if let Some(m) = RE_GEMFILE_RUBY_FILE.captures(gemfile) {
        let txt = read(&dir.join(&m[1]))?;
        let ver = RE_TOOL_VERSIONS.captures(&txt).map(|x| x[1].to_string()).unwrap_or_else(|| txt.trim().to_string());
        return (!ver.is_empty()).then(|| GemRuby { requirement: ver, raw: format!("file: \"{}\"", &m[1]) });
    }
    let m = RE_GEMFILE_RUBY.captures(gemfile)?;
    let reqs: Vec<String> = RE_QUOTED.captures_iter(&m[1]).map(|x| x[1].to_string()).collect();
    Some(GemRuby {
        requirement: reqs.join(", "),
        raw: reqs.iter().map(|r| format!("\"{r}\"")).collect::<Vec<_>>().join(", "),
    })
}

pub fn parse_bundle_config(text: &str) -> Map<String, Value> {
    let mut cfg = Map::new();
    for line in text.lines() {
        if let Some(m) = RE_BUNDLE_CONFIG.captures(line) {
            cfg.insert(m[1].to_string(), Value::from(&m[2]));
        }
    }
    cfg
}

fn git_branch(dir: &Path) -> Option<String> {
    let mut head = read(&dir.join(".git").join("HEAD"));
    if head.is_none() {
        // worktree / submodule: .git がファイルで "gitdir: <path>" を指している
        let pointer = read(&dir.join(".git"))?;
        let gitdir = pointer.trim().strip_prefix("gitdir:")?.trim().to_string();
        head = read(&dir.join(gitdir).join("HEAD"));
    }
    let head = head?;
    match RE_HEAD_REF.captures(&head) {
        Some(m) => Some(m[1].trim().to_string()),
        None => Some(head.trim().chars().take(8).collect()),
    }
}

#[derive(Serialize)]
struct Gem<'a> {
    #[serde(flatten)]
    spec: &'a Spec,
    direct: bool,
}

fn issue(level: &str, text: String) -> Value {
    json!({ "level": level, "text": text })
}

fn base_name(dir: &str) -> String {
    Path::new(dir).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| dir.to_string())
}

/// プロジェクトを解析。installed はインストール済み Ruby 一覧（managers::scan の rubies）。
pub fn analyze(dir_str: &str, installed: &[Ruby], global_version: Option<&str>) -> Value {
    let dir = Path::new(dir_str);
    if !dir.exists() {
        return json!({ "path": dir_str, "name": base_name(dir_str), "exists": false });
    }

    let mut sources: Vec<VersionSource> = vec![];
    if let Some(rv) = read(&dir.join(".ruby-version")) {
        if let Some(first) = rv.split_whitespace().next() {
            sources.push(VersionSource { file: ".ruby-version".into(), version: first.into() });
        }
    }
    if let Some(m) = read(&dir.join(".tool-versions")).as_deref().and_then(|t| RE_TOOL_VERSIONS.captures(t)) {
        sources.push(VersionSource { file: ".tool-versions".into(), version: m[1].into() });
    }
    let mise_name = first_existing(dir, &["mise.toml", ".mise.toml", "mise.local.toml"]);
    if let Some(name) = mise_name {
        if let Some(m) = read(&dir.join(name)).as_deref().and_then(|t| RE_MISE.captures(t)) {
            sources.push(VersionSource { file: name.into(), version: m[1].into() });
        }
    }

    let gemfile_name = first_existing(dir, &["Gemfile", "gems.rb"]);
    let lock_name = if gemfile_name == Some("gems.rb") { "gems.locked" } else { "Gemfile.lock" };
    let gemfile_text = gemfile_name.and_then(|n| read(&dir.join(n)));
    let lock = read(&dir.join(lock_name)).filter(|t| !t.is_empty()).map(|t| parse_lockfile(&t));
    let gem_req = gemfile_text.as_deref().and_then(|t| gemfile_ruby(t, dir));

    // 実際に使われる版：mise.toml > .tool-versions > .ruby-version（どのマネージャも概ねこの順）
    let order = [mise_name, Some(".tool-versions"), Some(".ruby-version")];
    let pinned = order.iter().flatten().find_map(|f| sources.iter().find(|s| s.file == *f)).cloned();
    let wanted = pinned.as_ref().map(|p| p.version.clone()).or_else(|| global_version.map(String::from));
    let resolved = wanted.as_deref().and_then(|w| v::resolve(w, installed, |r| r.version.as_str()));

    let mut issues: Vec<Value> = vec![];
    if pinned.is_none() {
        issues.push(issue("info", "Ruby バージョンファイルがありません（グローバル設定が使われます）".into()));
    }
    if let (Some(p), None) = (&pinned, &resolved) {
        issues.push(issue("error", format!("Ruby {} がインストールされていません", p.version)));
    }
    let mut distinct: Vec<String> = vec![];
    for s in &sources {
        let n = v::normalize(&s.version);
        if !distinct.contains(&n) {
            distinct.push(n);
        }
    }
    if distinct.len() > 1 {
        let detail = sources.iter().map(|s| format!("{}={}", s.file, s.version)).collect::<Vec<_>>().join(" / ");
        issues.push(issue("warn", format!("バージョンファイル同士が不一致: {detail}")));
    }
    let effective = resolved.map(|(r, _)| r.version.clone()).or_else(|| wanted.clone());
    if let Some(eff) = &effective {
        if let Some(g) = &gem_req {
            if !v::satisfies(eff, &g.requirement) {
                issues.push(issue("error", format!("{} の ruby {} を {} は満たしていません", gemfile_name.unwrap_or("Gemfile"), g.raw, eff)));
            }
        }
        if let Some(lrv) = lock.as_ref().and_then(|l| l.ruby_version.as_deref()) {
            if v::normalize(lrv) != v::normalize(eff) && v::series(lrv) != v::series(eff) {
                issues.push(issue("warn", format!("Gemfile.lock の RUBY VERSION ({lrv}) と使用版 {eff} のシリーズが異なります")));
            }
        }
    }
    if gemfile_name.is_some() && lock.is_none() {
        issues.push(issue("warn", format!("{lock_name} がありません（bundle install 未実行）")));
    }
    if let Some(eff) = &effective {
        if v::lifecycle(eff).status == "eol" {
            issues.push(issue("warn", format!("Ruby {} はサポート終了 (EOL) です", v::series(eff))));
        }
    }

    let bundle_config = parse_bundle_config(&read(&dir.join(".bundle").join("config")).unwrap_or_default());
    let level = |l: &str| issues.iter().any(|i| i["level"] == l);
    let status = if level("error") { "error" } else if level("warn") { "warn" } else { "ok" };

    let bundle = lock.as_ref().map(|l| {
        let direct: std::collections::HashSet<&str> = l.dependencies.iter().map(|d| d.name.as_str()).collect();
        json!({
            "bundledWith": l.bundled_with,
            "rubyVersion": l.ruby_version,
            "platforms": l.platforms,
            "sources": l.sources.iter().map(|s| json!({ "type": s.kind, "remote": s.remote, "revision": s.revision, "branch": s.branch })).collect::<Vec<_>>(),
            "dependencies": l.dependencies,
            "gems": l.specs.iter().map(|s| Gem { spec: s, direct: direct.contains(s.name.as_str()) }).collect::<Vec<_>>(),
        })
    });

    json!({
        "path": dir_str,
        "name": base_name(dir_str),
        "exists": true,
        "branch": git_branch(dir),
        "sources": sources,
        "pinned": pinned,
        "wanted": wanted,
        "usingGlobal": pinned.is_none(),
        "resolved": resolved.map(|(r, exact)| json!({ "id": r.id, "version": r.version, "manager": r.manager, "exact": exact })),
        "gemfile": gemfile_name,
        "lockfile": lock.as_ref().map(|_| lock_name),
        "gemRuby": gem_req,
        "bundle": bundle,
        "bundleConfig": bundle_config,
        "issues": issues,
        "status": status,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> String {
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/sample").to_string()
    }

    fn ruby(id: &str, version: &str, manager: &str) -> Ruby {
        Ruby { id: id.into(), version: version.into(), manager: manager.into(), ..Default::default() }
    }

    #[test]
    fn analyze_project() {
        let a = analyze(&sample(), &[ruby("r1", "3.3.6", "rbenv")], None);
        assert_eq!(a["resolved"]["id"], "r1");
        assert_eq!(a["gemRuby"]["requirement"], "~> 3.3");
        let rails = a["bundle"]["gems"].as_array().unwrap().iter().find(|g| g["name"] == "rails").unwrap();
        assert_eq!(rails["direct"], true);
        assert_eq!(rails["sourceType"], "GEM");
        assert_eq!(a["status"], "ok");
    }

    #[test]
    fn analyze_project_with_missing_ruby() {
        let a = analyze(&sample(), &[ruby("x", "3.4.1", "mise")], None);
        assert!(a["resolved"].is_null());
        assert_eq!(a["status"], "error");
    }

    #[test]
    fn analyze_missing_dir() {
        let a = analyze("/no/such/dir/xyz", &[], None);
        assert_eq!(a["exists"], false);
        assert_eq!(a["name"], "xyz");
    }

    #[test]
    fn gemfile_ruby_variants() {
        let d = Path::new(".");
        assert_eq!(gemfile_ruby("ruby \">= 3.1\", \"< 4\"\n", d).unwrap().requirement, ">= 3.1, < 4");
        assert_eq!(gemfile_ruby("source 'x'\nruby '3.3.6'\n", d).unwrap().raw, "\"3.3.6\"");
        assert!(gemfile_ruby("gem 'rails'\n", d).is_none());
    }

    #[test]
    fn bundle_config() {
        let c = parse_bundle_config("---\nBUNDLE_PATH: \"vendor/bundle\"\nBUNDLE_FROZEN: \"true\"\n");
        assert_eq!(c["BUNDLE_PATH"], "vendor/bundle");
        assert_eq!(c["BUNDLE_FROZEN"], "true");
    }
}
