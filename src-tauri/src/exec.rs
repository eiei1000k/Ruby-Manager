//! コマンド実行と、GUI 起動時でもログインシェルと同じ環境変数を使うためのユーティリティ

use encoding_rs::{DecoderResult, Encoding, UTF_8};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

pub type Env = HashMap<String, String>;
pub type ChildHandle = Arc<Mutex<Child>>;

pub const IS_WIN: bool = cfg!(windows);
const PATH_DELIMITER: &str = if IS_WIN { ";" } else { ":" };

#[derive(Debug, Default, Clone)]
pub struct RunResult {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Default)]
pub struct RunOpts<'a> {
    pub cwd: Option<&'a Path>,
    pub env: Option<&'a Env>,
    pub timeout: Option<Duration>,
    /// 出力のチャンクごとに呼ばれる（第 2 引数は "stdout" / "stderr"）
    pub on_data: Option<&'a (dyn Fn(&str, &'static str) + Sync)>,
    pub on_spawn: Option<&'a dyn Fn(ChildHandle)>,
}

pub fn home() -> PathBuf {
    let var = if IS_WIN { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
}

pub fn process_env() -> Env {
    std::env::vars_os()
        .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)))
        .filter(|(k, _)| !k.is_empty() && !k.starts_with('='))
        .collect()
}

/// PATH のキー（Windows では大文字小文字を区別しないので実際のキー名を探す）
pub fn path_key(env: &Env) -> String {
    if IS_WIN {
        env.keys().find(|k| k.eq_ignore_ascii_case("PATH")).cloned().unwrap_or_else(|| "Path".into())
    } else {
        "PATH".into()
    }
}

pub fn split_path(value: &str) -> Vec<String> {
    value.split(PATH_DELIMITER).filter(|s| !s.is_empty()).map(String::from).collect()
}

#[cfg(windows)]
fn quote_win(arg: &str) -> String {
    if arg.is_empty() {
        return "\"\"".into();
    }
    if arg.chars().any(|c| c.is_whitespace() || "\"&|<>^()".contains(c)) {
        format!("\"{}\"", arg.replace('"', "\"\""))
    } else {
        arg.to_string()
    }
}

/// Windows では .cmd/.bat (bundle.bat 等) を解決するため cmd.exe 経由で起動する
#[cfg(windows)]
fn build_command(cmd: &str, args: &[String]) -> Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let line = std::iter::once(cmd)
        .chain(args.iter().map(String::as_str))
        .map(quote_win)
        .collect::<Vec<_>>()
        .join(" ");
    let mut c = Command::new(std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into()));
    c.raw_arg(format!("/d /s /c \"{line}\""));
    c.creation_flags(CREATE_NO_WINDOW);
    c
}

#[cfg(not(windows))]
fn build_command(cmd: &str, args: &[String]) -> Command {
    let mut c = Command::new(cmd);
    c.args(args);
    c
}

/// 子プロセスを終了する。Windows では cmd.exe 経由で起動しているため、
/// cmd.exe だけを終わらせると bundle.bat などの先の ruby.exe が残る。プロセスツリーごと終了させる。
pub fn kill(handle: &ChildHandle) {
    let Ok(mut child) = handle.lock() else { return };
    if matches!(child.try_wait(), Ok(Some(_))) {
        return;
    }
    #[cfg(windows)]
    {
        let ok = build_command("taskkill", &["/pid".into(), child.id().to_string(), "/T".into(), "/F".into()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if ok {
            return;
        }
    }
    let _ = child.kill();
}

// ---------------------------------------------------------------- 出力のデコード

/// Windows: cmd.exe 自身のメッセージなどはコンソールのコードページ (日本語環境では CP932) で出力される。
/// UTF-8 として読めない出力が来たら、そのストリームはコードページで読み直す。
#[cfg(windows)]
fn legacy_encoding() -> &'static Encoding {
    // SAFETY: 引数なしで現在の OEM コードページを返すだけの API
    let cp = unsafe { windows_sys::Win32::Globalization::GetOEMCP() };
    match cp {
        932 => encoding_rs::SHIFT_JIS,
        936 => encoding_rs::GBK,
        949 => encoding_rs::EUC_KR,
        950 => encoding_rs::BIG5,
        1252 => encoding_rs::WINDOWS_1252,
        _ => UTF_8,
    }
}

#[cfg(not(windows))]
fn legacy_encoding() -> &'static Encoding {
    UTF_8
}

struct StreamDecoder {
    utf8: Option<encoding_rs::Decoder>,
    legacy: Option<encoding_rs::Decoder>,
}

impl StreamDecoder {
    fn new() -> Self {
        Self { utf8: Some(UTF_8.new_decoder_without_bom_handling()), legacy: None }
    }

    fn decode(&mut self, buf: &[u8]) -> String {
        if let Some(dec) = self.utf8.as_mut() {
            if IS_WIN {
                let mut out = String::with_capacity(dec.max_utf8_buffer_length_without_replacement(buf.len()).unwrap_or(buf.len() * 3));
                let (res, _) = dec.decode_to_string_without_replacement(buf, &mut out, false);
                if !matches!(res, DecoderResult::Malformed(..)) {
                    return out;
                }
                self.utf8 = None;
                self.legacy = Some(legacy_encoding().new_decoder_without_bom_handling());
            } else {
                let mut out = String::with_capacity(dec.max_utf8_buffer_length(buf.len()).unwrap_or(buf.len() * 3));
                let _ = dec.decode_to_string(buf, &mut out, false);
                return out;
            }
        }
        let dec = self.legacy.as_mut().unwrap();
        let mut out = String::with_capacity(dec.max_utf8_buffer_length(buf.len()).unwrap_or(buf.len() * 3));
        let _ = dec.decode_to_string(buf, &mut out, false);
        out
    }
}

fn pump(mut src: impl Read, stream: &'static str, on_data: Option<&(dyn Fn(&str, &'static str) + Sync)>) -> String {
    let mut all = String::new();
    let mut dec = StreamDecoder::new();
    let mut buf = [0u8; 8192];
    loop {
        match src.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let s = dec.decode(&buf[..n]);
                if s.is_empty() {
                    continue;
                }
                if let Some(f) = on_data {
                    f(&s, stream);
                }
                all.push_str(&s);
            }
        }
    }
    all
}

/// コマンドを実行し、終了を待つ。起動できなかった場合は code = -1。
pub fn run(cmd: &str, args: &[String], opts: RunOpts) -> RunResult {
    let mut c = build_command(cmd, args);
    c.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(cwd) = opts.cwd {
        c.current_dir(cwd);
    }
    if let Some(env) = opts.env {
        c.env_clear().envs(env);
    }
    let mut child = match c.spawn() {
        Ok(ch) => ch,
        Err(e) => return RunResult { code: -1, stdout: String::new(), stderr: e.to_string() },
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let handle: ChildHandle = Arc::new(Mutex::new(child));
    if let Some(f) = opts.on_spawn {
        f(handle.clone());
    }
    let on_data = opts.on_data;
    let started = Instant::now();

    thread::scope(|s| {
        let out = s.spawn(move || stdout.map(|p| pump(p, "stdout", on_data)).unwrap_or_default());
        let err = s.spawn(move || stderr.map(|p| pump(p, "stderr", on_data)).unwrap_or_default());
        let mut killed = false;
        let mut wait = Duration::from_millis(2);
        let status = loop {
            match handle.lock().map(|mut ch| ch.try_wait()) {
                Ok(Ok(Some(st))) => break Some(st),
                Ok(Ok(None)) => {}
                _ => break None,
            }
            if let Some(t) = opts.timeout {
                if !killed && started.elapsed() >= t {
                    kill(&handle);
                    killed = true;
                }
            }
            thread::sleep(wait);
            wait = (wait * 2).min(Duration::from_millis(25));
        };
        RunResult {
            code: status.and_then(|s| s.code()).unwrap_or(-1),
            stdout: out.join().unwrap_or_default(),
            stderr: err.join().unwrap_or_default(),
        }
    })
}

/// 引数なしで手軽に呼ぶための版
pub fn run_simple(cmd: &str, args: &[&str], env: &Env, cwd: Option<&Path>, timeout: Option<Duration>) -> RunResult {
    let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    run(cmd, &args, RunOpts { cwd, env: Some(env), timeout, ..Default::default() })
}

// ---------------------------------------------------------------- 環境変数

/// よく使われるバージョンマネージャのパス（ログインシェルが読めなかった場合の保険）
fn fallback_paths() -> Vec<PathBuf> {
    let h = home();
    if IS_WIN {
        let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(|| h.join("AppData").join("Local"));
        // winget 本体は WindowsApps にあるが、ユーザー PATH から外れている環境がある
        return vec![
            local.join("mise").join("shims"),
            local.join("Microsoft").join("WinGet").join("Links"),
            local.join("Microsoft").join("WindowsApps"),
        ];
    }
    vec![
        h.join(".rbenv/bin"),
        h.join(".rbenv/shims"),
        h.join(".local/bin"),
        h.join(".local/share/mise/shims"),
        h.join(".asdf/shims"),
        h.join(".asdf/bin"),
        h.join(".rvm/bin"),
        "/opt/homebrew/bin".into(),
        "/usr/local/bin".into(),
        "/home/linuxbrew/.linuxbrew/bin".into(),
    ]
}

/// macOS/Linux ではログインシェルから環境変数を取得する（Finder 起動だと PATH が最小限のため）
#[cfg(windows)]
fn shell_env(_base: &Env) -> Option<Env> {
    None
}

#[cfg(not(windows))]
fn shell_env(base: &Env) -> Option<Env> {
    const MARKER: &str = "__RUBY_MANAGER_ENV__";
    let shell = base.get("SHELL").cloned().unwrap_or_else(|| {
        if cfg!(target_os = "macos") { "/bin/zsh".into() } else { "/bin/bash".into() }
    });
    let script = format!("echo {MARKER}; /usr/bin/env -0; echo {MARKER}");
    let res = run_simple(&shell, &["-ilc", &script], base, None, Some(Duration::from_secs(10)));
    let parts: Vec<&str> = res.stdout.split(MARKER).collect();
    if parts.len() < 3 {
        return None;
    }
    let body = parts[1].trim_start_matches(['\r', '\n']);
    let env: Env = body
        .split('\0')
        .filter_map(|kv| kv.split_once('='))
        .filter(|(k, _)| !k.is_empty() && !k.contains('\n'))
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    if env.is_empty() { None } else { Some(env) }
}

pub fn load_shell_env() -> Env {
    let mut env = process_env();
    if let Some(shell) = shell_env(&env) {
        env.extend(shell);
    }
    let key = path_key(&env);
    let mut current = split_path(env.get(&key).map(String::as_str).unwrap_or(""));
    for p in fallback_paths() {
        let s = p.to_string_lossy().into_owned();
        if !current.contains(&s) && p.exists() {
            current.push(s);
        }
    }
    env.insert(key, current.join(PATH_DELIMITER));
    env
}

/// 特定 Ruby の bin を PATH 先頭に置いた環境を作る（他マネージャの干渉を避ける）
pub fn env_with_ruby(base: &Env, bin_dir: &str, version: Option<&str>) -> Env {
    const STRIP: [&str; 9] = [
        "GEM_HOME", "GEM_PATH", "RUBYOPT", "RUBYLIB", "BUNDLE_GEMFILE", "BUNDLE_BIN_PATH", "RUBY_ROOT", "RUBY_ENGINE",
        "RUBY_VERSION",
    ];
    let mut env: Env = base
        .iter()
        .filter(|(k, _)| !STRIP.iter().any(|s| if IS_WIN { k.eq_ignore_ascii_case(s) } else { k == s }))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    let key = path_key(&env);
    let old = env.get(&key).cloned().unwrap_or_default();
    env.insert(key, format!("{bin_dir}{PATH_DELIMITER}{old}"));
    if let Some(v) = version {
        for k in ["RBENV_VERSION", "ASDF_RUBY_VERSION", "MISE_RUBY_VERSION"] {
            env.insert(k.into(), v.into());
        }
    }
    env
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decoder_handles_split_utf8() {
        let mut d = StreamDecoder::new();
        let bytes = "日本語".as_bytes();
        let s = d.decode(&bytes[..4]) + &d.decode(&bytes[4..]);
        assert_eq!(s, "日本語");
    }

    #[test]
    fn env_with_ruby_prepends_bin() {
        let mut base = Env::new();
        base.insert(if IS_WIN { "Path".into() } else { "PATH".into() }, "/usr/bin".into());
        base.insert("GEM_HOME".into(), "/x".into());
        let e = env_with_ruby(&base, "/r/bin", Some("3.3.6"));
        assert!(e[&path_key(&e)].starts_with("/r/bin"));
        assert!(!e.contains_key("GEM_HOME"));
        assert_eq!(e["RBENV_VERSION"], "3.3.6");
    }

    #[test]
    fn run_captures_output() {
        let env = process_env();
        let r = if IS_WIN {
            run_simple("echo", &["hello"], &env, None, None)
        } else {
            run_simple("sh", &["-c", "echo hello; echo err >&2; exit 3"], &env, None, None)
        };
        assert!(r.stdout.contains("hello"));
        if !IS_WIN {
            assert_eq!(r.code, 3);
            assert!(r.stderr.contains("err"));
        }
        assert_eq!(run_simple("__no_such_command__", &[], &env, None, None).code != 0, true);
    }
}
