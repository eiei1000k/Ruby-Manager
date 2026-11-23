//! 各 Ruby バージョンマネージャのアダプタ。
//! どのアダプタも detect / list / get_global / set_global / list_remote / install_cmd / uninstall_cmd / exec_cmd を持つ。

use crate::exec::{home, path_key, run_simple, split_path, Env, RunResult, IS_WIN};
use crate::versions::{self as v, Lifecycle};
use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::thread;
use std::time::Duration;

static VERSION_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9._+\-]+$").unwrap());
static RVM_KNOWN_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\[ruby-\]([\d.]+)(?:\[([^\]]+)\])?$").unwrap());
static SHIM_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)[\\/]shims[\\/]?$").unwrap());
static RUBYINSTALLER_DIR_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^ruby\d").unwrap());
static TOOL_VERSIONS_RUBY_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^ruby\s+(\S+)").unwrap());

const REMOTE_TIMEOUT: Duration = Duration::from_secs(60);

pub fn is_valid_version(s: &str) -> bool {
    VERSION_RE.is_match(s)
}

pub fn assert_version(s: &str) -> Result<(), String> {
    if is_valid_version(s) { Ok(()) } else { Err(format!("不正なバージョン指定: {s}")) }
}

pub fn ruby_exe(bin_dir: &Path) -> PathBuf {
    bin_dir.join(if IS_WIN { "ruby.exe" } else { "ruby" })
}

fn lines(text: &str) -> Vec<String> {
    text.lines().map(str::trim).filter(|l| !l.is_empty()).map(String::from).collect()
}

struct DirEnt {
    name: String,
    is_dir: bool,
    is_symlink: bool,
}

fn readdir_safe(dir: &Path) -> Vec<DirEnt> {
    let Ok(rd) = std::fs::read_dir(dir) else { return vec![] };
    let mut out: Vec<DirEnt> = rd
        .flatten()
        .filter_map(|e| {
            let ft = e.file_type().ok()?;
            Some(DirEnt { name: e.file_name().to_string_lossy().into_owned(), is_dir: ft.is_dir(), is_symlink: ft.is_symlink() })
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// マネージャの list が返す候補（バージョン不明なものは ruby を実行して調べる）
#[derive(Debug, Default, Clone)]
pub struct Candidate {
    pub version: Option<String>,
    pub bin_dir: PathBuf,
    pub alias: Option<bool>,
    pub rvm_name: Option<String>,
    pub dir: Option<String>,
    pub label: Option<String>,
}

/// インストール済みの Ruby（レンダラーにそのまま渡す）
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ruby {
    pub version: String,
    pub bin_dir: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alias: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rvm_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub id: String,
    pub manager: String,
    pub manager_name: String,
    pub is_global: bool,
    pub lifecycle: Lifecycle,
    pub series: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagerInfo {
    pub id: &'static str,
    pub name: &'static str,
    pub url: Option<&'static str>,
    pub available: bool,
    pub can_install: bool,
    pub readonly: bool,
    pub global: Option<String>,
}

pub struct CmdSpec {
    pub cmd: String,
    pub args: Vec<String>,
}

pub enum Uninstall {
    Cmd(CmdSpec),
    Remove(PathBuf),
}

pub struct ExecSpec {
    pub cmd: String,
    pub args: Vec<String>,
    /// PATH 先頭に置く bin。None ならマネージャ自身が環境を整える（RVM）
    pub bin_dir: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Rbenv,
    Mise,
    Asdf,
    Rvm,
    Chruby,
    RubyInstaller,
    System,
}

pub const ALL: [Kind; 7] = [Kind::Rbenv, Kind::Mise, Kind::Asdf, Kind::Rvm, Kind::Chruby, Kind::RubyInstaller, Kind::System];

#[derive(Debug, Clone)]
pub struct Manager {
    pub kind: Kind,
    /// rbenv / RVM のルート、asdf のデータディレクトリ
    root: PathBuf,
    /// RVM の rvm 実行ファイル
    bin: PathBuf,
    can_install: bool,
}

fn cmd(c: &str, args: &[&str]) -> CmdSpec {
    CmdSpec { cmd: c.into(), args: args.iter().map(|a| a.to_string()).collect() }
}

fn chruby_dirs() -> [PathBuf; 2] {
    [home().join(".rubies"), PathBuf::from("/opt/rubies")]
}

pub fn ruby_version_of(bin_dir: &Path, env: &Env) -> Option<String> {
    let r = run_simple(&s(&ruby_exe(bin_dir)), &["-e", "print RUBY_VERSION"], env, None, Some(Duration::from_secs(10)));
    let out = r.stdout.trim();
    (r.code == 0 && !out.is_empty()).then(|| out.to_string())
}

/// PATH 上で ruby を持つディレクトリ。shims（mise など）は shim = true
fn path_ruby_dirs(env: &Env) -> Vec<(String, bool)> {
    split_path(env.get(&path_key(env)).map(String::as_str).unwrap_or(""))
        .into_iter()
        .map(|d| {
            let shim = SHIM_RE.is_match(&d);
            (d, shim)
        })
        .filter(|(d, shim)| {
            let p = Path::new(d);
            ruby_exe(p).exists() || (*shim && ["ruby.cmd", "ruby.bat"].iter().any(|f| p.join(f).exists()))
        })
        .collect()
}

impl Manager {
    pub fn new(kind: Kind) -> Self {
        Self { kind, root: PathBuf::new(), bin: PathBuf::new(), can_install: matches!(kind, Kind::Mise | Kind::Asdf | Kind::Rvm) }
    }

    pub fn id(&self) -> &'static str {
        match self.kind {
            Kind::Rbenv => "rbenv",
            Kind::Mise => "mise",
            Kind::Asdf => "asdf",
            Kind::Rvm => "rvm",
            Kind::Chruby => "chruby",
            Kind::RubyInstaller => "rubyinstaller",
            Kind::System => "system",
        }
    }

    pub fn name(&self) -> &'static str {
        match self.kind {
            Kind::Rbenv => "rbenv",
            Kind::Mise => "mise",
            Kind::Asdf => "asdf",
            Kind::Rvm => "RVM",
            Kind::Chruby => "chruby / ruby-install",
            Kind::RubyInstaller => "RubyInstaller (winget)",
            Kind::System => "システム / Homebrew",
        }
    }

    fn url(&self) -> Option<&'static str> {
        match self.kind {
            Kind::Rbenv => Some("https://github.com/rbenv/rbenv"),
            Kind::Mise => Some("https://mise.jdx.dev/"),
            Kind::Asdf => Some("https://asdf-vm.com/"),
            Kind::Rvm => Some("https://rvm.io/"),
            Kind::Chruby => Some("https://github.com/postmodern/chruby"),
            Kind::RubyInstaller => Some("https://rubyinstaller.org/"),
            Kind::System => None,
        }
    }

    pub fn readonly(&self) -> bool {
        self.kind == Kind::System
    }

    pub fn detect(&mut self, env: &Env) -> bool {
        let h = home();
        match self.kind {
            Kind::Rbenv => {
                if IS_WIN {
                    return false;
                }
                let r = run_simple("rbenv", &["root"], env, None, None);
                if r.code != 0 {
                    return false;
                }
                self.root = PathBuf::from(r.stdout.trim());
                self.can_install = run_simple("rbenv", &["install", "--version"], env, None, None).code == 0;
                true
            }
            Kind::Mise => run_simple("mise", &["--version"], env, None, None).code == 0,
            Kind::Asdf => {
                if IS_WIN || run_simple("asdf", &["--version"], env, None, None).code != 0 {
                    return false;
                }
                let p = run_simple("asdf", &["plugin", "list"], env, None, None);
                self.root = env.get("ASDF_DATA_DIR").map(PathBuf::from).unwrap_or_else(|| h.join(".asdf"));
                lines(&p.stdout).iter().any(|l| l == "ruby")
            }
            Kind::Rvm => {
                if IS_WIN {
                    return false;
                }
                self.root = env.get("rvm_path").map(PathBuf::from).unwrap_or_else(|| h.join(".rvm"));
                self.bin = self.root.join("bin").join("rvm");
                self.bin.exists()
            }
            Kind::Chruby => {
                if IS_WIN {
                    return false;
                }
                self.can_install = run_simple("ruby-install", &["--version"], env, None, None).code == 0;
                self.can_install || chruby_dirs().iter().any(|d| !readdir_safe(d).is_empty())
            }
            Kind::RubyInstaller => {
                if !IS_WIN {
                    return false;
                }
                self.can_install = run_simple("winget", &["--version"], env, None, None).code == 0;
                true
            }
            Kind::System => !IS_WIN,
        }
    }

    pub fn list(&self, env: &Env) -> Vec<Candidate> {
        let exists = |c: &Candidate| ruby_exe(&c.bin_dir).exists();
        match self.kind {
            Kind::Rbenv => {
                let base = self.root.join("versions");
                readdir_safe(&base)
                    .into_iter()
                    .filter(|d| d.is_dir || d.is_symlink)
                    .map(|d| Candidate {
                        version: Some(d.name.clone()),
                        bin_dir: base.join(&d.name).join("bin"),
                        alias: Some(d.is_symlink),
                        ..Default::default()
                    })
                    .filter(exists)
                    .collect()
            }
            Kind::Mise => {
                let r = run_simple("mise", &["ls", "--installed", "--json", "ruby"], env, Some(home().as_path()), None);
                let arr: Vec<Value> = serde_json::from_str(&r.stdout).unwrap_or_default();
                arr.iter()
                    .filter_map(|t| {
                        Some(Candidate {
                            version: Some(t.get("version")?.as_str()?.to_string()),
                            bin_dir: PathBuf::from(t.get("install_path")?.as_str()?).join("bin"),
                            ..Default::default()
                        })
                    })
                    .collect()
            }
            Kind::Asdf => {
                let base = self.root.join("installs").join("ruby");
                readdir_safe(&base)
                    .into_iter()
                    .filter(|d| d.is_dir)
                    .map(|d| Candidate { version: Some(d.name.clone()), bin_dir: base.join(&d.name).join("bin"), ..Default::default() })
                    .filter(exists)
                    .collect()
            }
            Kind::Rvm => {
                let base = self.root.join("rubies");
                readdir_safe(&base)
                    .into_iter()
                    .filter(|d| d.is_dir && d.name != "default")
                    .map(|d| Candidate {
                        version: Some(d.name.strip_prefix("ruby-").unwrap_or(&d.name).to_string()),
                        rvm_name: Some(d.name.clone()),
                        bin_dir: base.join(&d.name).join("bin"),
                        ..Default::default()
                    })
                    .filter(exists)
                    .collect()
            }
            Kind::Chruby => {
                let mut out = vec![];
                for base in chruby_dirs() {
                    for d in readdir_safe(&base).into_iter().filter(|d| d.is_dir) {
                        let dir = base.join(&d.name);
                        let c = Candidate {
                            version: Some(d.name.strip_prefix("ruby-").unwrap_or(&d.name).to_string()),
                            bin_dir: dir.join("bin"),
                            dir: Some(s(&dir)),
                            ..Default::default()
                        };
                        if exists(&c) {
                            out.push(c);
                        }
                    }
                }
                out
            }
            Kind::RubyInstaller => {
                let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_default();
                let roots = [PathBuf::from("C:\\"), PathBuf::from("C:\\tools"), local.join("Programs")];
                let mut out: Vec<Candidate> = vec![];
                let mut seen = HashSet::new();
                let mut add = |bin_dir: PathBuf, label: String| {
                    let key = s(&std::path::absolute(&bin_dir).unwrap_or_else(|_| bin_dir.clone()))
                        .trim_end_matches(['\\', '/'])
                        .to_lowercase();
                    if seen.insert(key) {
                        out.push(Candidate { bin_dir, label: Some(label), ..Default::default() });
                    }
                };
                for root in &roots {
                    for d in readdir_safe(root) {
                        if !d.is_dir || !RUBYINSTALLER_DIR_RE.is_match(&d.name) {
                            continue;
                        }
                        let bin_dir = root.join(&d.name).join("bin");
                        if ruby_exe(&bin_dir).exists() {
                            add(bin_dir, d.name);
                        }
                    }
                }
                for (dir, shim) in path_ruby_dirs(env) {
                    if shim {
                        continue;
                    }
                    let p = PathBuf::from(&dir);
                    let label = p.parent().and_then(|x| x.file_name()).map(|x| x.to_string_lossy().into_owned()).unwrap_or_default();
                    add(p, label);
                }
                out
            }
            Kind::System => ["/usr/bin", "/opt/homebrew/opt/ruby/bin", "/usr/local/opt/ruby/bin", "/home/linuxbrew/.linuxbrew/opt/ruby/bin"]
                .iter()
                .map(|b| Candidate { bin_dir: PathBuf::from(b), ..Default::default() })
                .filter(exists)
                .collect(),
        }
    }

    pub fn get_global(&self, env: &Env) -> Option<String> {
        let h = home();
        let non_empty = |x: &str| {
            let t = x.trim();
            (!t.is_empty()).then(|| t.to_string())
        };
        match self.kind {
            Kind::Rbenv => {
                let r = run_simple("rbenv", &["global"], env, Some(h.as_path()), None);
                if r.code == 0 { non_empty(&r.stdout) } else { None }
            }
            Kind::Mise => {
                let r = run_simple("mise", &["ls", "--global", "--json", "ruby"], env, Some(h.as_path()), None);
                let arr: Vec<Value> = serde_json::from_str(&r.stdout).ok()?;
                let hit = arr.iter().find(|t| t.get("active").and_then(Value::as_bool).unwrap_or(false)).or(arr.first())?;
                hit.get("version")?.as_str().map(String::from)
            }
            Kind::Asdf => {
                let file = env.get("ASDF_DEFAULT_TOOL_VERSIONS_FILENAME").map(String::as_str).unwrap_or(".tool-versions");
                let txt = std::fs::read_to_string(h.join(file)).ok()?;
                TOOL_VERSIONS_RUBY_RE.captures(&txt).map(|m| m[1].to_string())
            }
            Kind::Rvm => {
                let r = run_simple(&s(&self.bin), &["alias", "show", "default"], env, None, None);
                let out = r.stdout.trim();
                if r.code != 0 || out.is_empty() {
                    return None;
                }
                let out = out.strip_prefix("ruby-").unwrap_or(out);
                Some(out.split('@').next().unwrap_or(out).to_string())
            }
            Kind::Chruby => std::fs::read_to_string(h.join(".ruby-version")).ok().and_then(|t| non_empty(&t)),
            Kind::RubyInstaller => {
                // PATH で最初に見つかる ruby がグローバル。shims が先なら mise などが決めるので関与しない
                let (dir, shim) = path_ruby_dirs(env).into_iter().next()?;
                if shim { None } else { ruby_version_of(Path::new(&dir), env) }
            }
            Kind::System => None,
        }
    }

    pub fn set_global(&self, env: &Env, ver: &str) -> Result<RunResult, String> {
        let fail = |msg: &str| Ok(RunResult { code: 1, stdout: String::new(), stderr: msg.into() });
        match self.kind {
            Kind::RubyInstaller => return fail("RubyInstaller ではシステム環境変数 PATH の順序でグローバルが決まります。"),
            Kind::System => return fail("システム Ruby はグローバルに設定できません。"),
            _ => {}
        }
        assert_version(ver)?;
        let h = home();
        Ok(match self.kind {
            Kind::Rbenv => run_simple("rbenv", &["global", ver], env, None, None),
            Kind::Mise => run_simple("mise", &["use", "--global", &format!("ruby@{ver}")], env, None, None),
            Kind::Asdf => {
                let r = run_simple("asdf", &["set", "--home", "ruby", ver], env, Some(h.as_path()), None); // asdf >= 0.16
                if r.code == 0 {
                    r
                } else {
                    run_simple("asdf", &["global", "ruby", ver], env, Some(h.as_path()), None)
                }
            }
            Kind::Rvm => run_simple(&s(&self.bin), &["alias", "create", "default", &format!("ruby-{ver}")], env, None, None),
            Kind::Chruby => {
                std::fs::write(h.join(".ruby-version"), format!("{ver}\n")).map_err(|e| e.to_string())?;
                RunResult { code: 0, stdout: "~/.ruby-version を更新しました (chruby auto.sh 用)".into(), stderr: String::new() }
            }
            Kind::RubyInstaller | Kind::System => unreachable!(),
        })
    }

    pub fn list_remote(&self, env: &Env, all: bool) -> Vec<String> {
        let t = Some(REMOTE_TIMEOUT);
        let valid = |l: &String| is_valid_version(l);
        match self.kind {
            Kind::Rbenv => {
                let r = run_simple("rbenv", &["install", if all { "--list-all" } else { "--list" }], env, None, t);
                lines(&r.stdout).into_iter().filter(valid).collect()
            }
            Kind::Mise => lines(&run_simple("mise", &["ls-remote", "ruby"], env, None, t).stdout).into_iter().filter(valid).collect(),
            Kind::Asdf => lines(&run_simple("asdf", &["list", "all", "ruby"], env, None, t).stdout).into_iter().filter(valid).collect(),
            Kind::Rvm => lines(&run_simple(&s(&self.bin), &["list", "known"], env, None, t).stdout)
                .iter()
                .filter_map(|l| RVM_KNOWN_RE.captures(l).map(|m| format!("{}{}", &m[1], m.get(2).map_or("", |x| x.as_str()))))
                .collect(),
            Kind::Chruby => lines(&run_simple("ruby-install", &["--list", "ruby"], env, None, t).stdout)
                .into_iter()
                .filter(|l| l.starts_with(|c: char| c.is_ascii_digit()) && is_valid_version(l))
                .collect(),
            Kind::RubyInstaller => ["4.0", "3.4", "3.3", "3.2", "3.1"].iter().map(|x| x.to_string()).collect(),
            Kind::System => vec![],
        }
    }

    fn winget_id(ver: &str) -> String {
        format!("RubyInstallerTeam.RubyWithDevKit.{}", v::series(ver))
    }

    pub fn install_cmd(&self, ver: &str) -> Result<Option<CmdSpec>, String> {
        if self.kind == Kind::System {
            return Ok(None);
        }
        assert_version(ver)?;
        let bin = s(&self.bin);
        Ok(Some(match self.kind {
            Kind::Rbenv => cmd("rbenv", &["install", "--skip-existing", ver]),
            Kind::Mise => cmd("mise", &["install", &format!("ruby@{ver}")]),
            Kind::Asdf => cmd("asdf", &["install", "ruby", ver]),
            Kind::Rvm => cmd(&bin, &["install", &format!("ruby-{ver}")]),
            Kind::Chruby => cmd("ruby-install", &["--no-reinstall", "ruby", ver]),
            Kind::RubyInstaller => cmd(
                "winget",
                &["install", "--id", &Self::winget_id(ver), "-e", "--accept-package-agreements", "--accept-source-agreements"],
            ),
            Kind::System => unreachable!(),
        }))
    }

    pub fn uninstall_cmd(&self, ver: &str) -> Result<Option<Uninstall>, String> {
        if self.kind == Kind::System {
            return Ok(None);
        }
        assert_version(ver)?;
        let bin = s(&self.bin);
        Ok(Some(match self.kind {
            Kind::Rbenv => Uninstall::Cmd(cmd("rbenv", &["uninstall", "--force", ver])),
            Kind::Mise => Uninstall::Cmd(cmd("mise", &["uninstall", &format!("ruby@{ver}")])),
            Kind::Asdf => Uninstall::Cmd(cmd("asdf", &["uninstall", "ruby", ver])),
            Kind::Rvm => Uninstall::Cmd(cmd(&bin, &["remove", &format!("ruby-{ver}")])),
            Kind::Chruby => Uninstall::Remove(home().join(".rubies").join(format!("ruby-{ver}"))),
            Kind::RubyInstaller => Uninstall::Cmd(cmd("winget", &["uninstall", "--id", &Self::winget_id(ver), "-e"])),
            Kind::System => unreachable!(),
        }))
    }

    /// 指定 Ruby でコマンドを実行するための形に包む
    pub fn exec_cmd(&self, ruby: &Ruby, c: &str, args: &[String]) -> ExecSpec {
        if self.kind == Kind::Rvm {
            let name = ruby.rvm_name.clone().unwrap_or_else(|| format!("ruby-{}", ruby.version));
            let mut a = vec![name, "do".into(), c.into()];
            a.extend(args.iter().cloned());
            return ExecSpec { cmd: s(&self.bin), args: a, bin_dir: None };
        }
        ExecSpec { cmd: c.into(), args: args.to_vec(), bin_dir: Some(ruby.bin_dir.clone()) }
    }
}

#[derive(Debug, Clone, Default)]
pub struct Scan {
    pub managers: Vec<ManagerInfo>,
    pub rubies: Vec<Ruby>,
    /// 検出時の状態（ルートディレクトリなど）を持ったアダプタ
    pub detected: Vec<Manager>,
}

impl Scan {
    pub fn manager(&self, id: &str) -> Result<&Manager, String> {
        self.detected.iter().find(|m| m.id() == id).ok_or_else(|| format!("unknown manager: {id}"))
    }

    /// グローバルとして使われる Ruby のバージョン
    pub fn global_version(&self) -> Option<String> {
        if let Some(g) = self.rubies.iter().find(|r| r.is_global) {
            return Some(g.version.clone());
        }
        self.managers.iter().find(|m| m.available && m.global.is_some()).and_then(|m| m.global.clone())
    }
}

/// 全マネージャを検出し、インストール済み Ruby を一覧化（マネージャごとの検出は並列）
pub fn scan(env: &Env) -> Scan {
    let detected: Vec<(Manager, bool, Option<String>, Vec<Candidate>)> = thread::scope(|sc| {
        let handles: Vec<_> = ALL
            .iter()
            .map(|&kind| {
                sc.spawn(move || {
                    let mut m = Manager::new(kind);
                    let available = m.detect(env);
                    let (global, list) = if available { (m.get_global(env), m.list(env)) } else { (None, vec![]) };
                    (m, available, global, list)
                })
            })
            .collect();
        handles
            .into_iter()
            .zip(ALL)
            .map(|(h, kind)| h.join().unwrap_or_else(|_| (Manager::new(kind), false, None, vec![])))
            .collect()
    });

    let mut out = Scan::default();
    let mut seen_bin = HashSet::new();
    for (m, available, global, list) in detected {
        out.managers.push(ManagerInfo {
            id: m.id(),
            name: m.name(),
            url: m.url(),
            available,
            can_install: available && m.can_install,
            readonly: m.readonly(),
            global: global.clone(),
        });
        for c in list {
            let real = std::fs::canonicalize(&c.bin_dir).unwrap_or_else(|_| c.bin_dir.clone());
            if !seen_bin.insert(real) {
                continue;
            }
            let Some(version) = c.version.clone().or_else(|| ruby_version_of(&c.bin_dir, env)) else { continue };
            out.rubies.push(Ruby {
                id: format!("{}:{}:{}", m.id(), version, out.rubies.len()),
                manager: m.id().into(),
                manager_name: m.name().into(),
                is_global: global.as_deref().is_some_and(|g| v::normalize(g) == v::normalize(&version)),
                lifecycle: v::lifecycle(&version),
                series: v::series(&version),
                bin_dir: s(&c.bin_dir),
                alias: c.alias,
                rvm_name: c.rvm_name,
                dir: c.dir,
                label: c.label,
                version,
            });
        }
        if available {
            out.detected.push(m);
        }
    }
    if !out.managers.iter().any(|m| m.available && m.id != "system") {
        out.managers.push(ManagerInfo {
            id: "none",
            name: "バージョンマネージャ未検出",
            url: None,
            available: false,
            can_install: false,
            readonly: false,
            global: None,
        });
    }
    out.rubies.sort_by(|a, b| v::compare(&b.version, &a.version));
    out
}
