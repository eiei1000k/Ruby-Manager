//! Ruby Manager のバックエンド（Tauri）。
//! レンダラーからのコマンド、長時間コマンド（ジョブ）のストリーミング、登録リポジトリの永続化を扱う。

mod exec;
mod lockfile;
mod managers;
mod project;
mod versions;

use exec::{ChildHandle, Env, RunOpts, RunResult};
use managers::{Scan, Uninstall};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::window::Color;
use tauri::{AppHandle, Emitter, Manager, RunEvent, Theme, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

type Res<T> = Result<T, String>;

fn e2s(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[derive(Default)]
struct AppState {
    env: Mutex<Option<Arc<Env>>>,
    cache: Mutex<Arc<Scan>>,
    jobs: Mutex<HashMap<u64, ChildHandle>>,
    seq: AtomicU64,
}

/// Node.js の process.platform と同じ表記（レンダラーの分岐用）
const PLATFORM: &str = if cfg!(windows) {
    "win32"
} else if cfg!(target_os = "macos") {
    "darwin"
} else {
    "linux"
};

// ------------------------------------------------------------ 状態

fn state(app: &AppHandle) -> tauri::State<'_, AppState> {
    app.state::<AppState>()
}

/// 環境変数（ログインシェル由来）。reload でシェルから読み直す
fn env(app: &AppHandle, reload: bool) -> Arc<Env> {
    let st = state(app);
    if !reload {
        if let Some(e) = st.env.lock().unwrap().clone() {
            return e;
        }
    }
    let e = Arc::new(exec::load_shell_env());
    *st.env.lock().unwrap() = Some(e.clone());
    e
}

fn cache(app: &AppHandle) -> Arc<Scan> {
    state(app).cache.lock().unwrap().clone()
}

fn rescan(app: &AppHandle, reload_env: bool) -> Arc<Scan> {
    let e = env(app, reload_env);
    let s = Arc::new(managers::scan(&e));
    *state(app).cache.lock().unwrap() = s.clone();
    s
}

fn analyze_project(app: &AppHandle, dir: &str) -> Value {
    let c = cache(app);
    project::analyze(dir, &c.rubies, c.global_version().as_deref())
}

/// 重い処理はメインスレッド（UI）を塞がないよう別スレッドで実行する
async fn blocking<T: Send + 'static>(app: AppHandle, f: impl FnOnce(&AppHandle) -> Res<T> + Send + 'static) -> Res<T> {
    tauri::async_runtime::spawn_blocking(move || f(&app)).await.map_err(e2s)?
}

fn main_window(app: &AppHandle) -> Res<WebviewWindow> {
    app.get_webview_window("main").ok_or_else(|| "ウィンドウが見つかりません".to_string())
}

// ------------------------------------------------------------ 永続化（登録したプロジェクト）

/// 旧 Electron 版と同じ場所（<設定ディレクトリ>/Ruby Manager/projects.json）を使い、登録を引き継ぐ
fn store_file(app: &AppHandle) -> PathBuf {
    let base = app.path().config_dir().unwrap_or_else(|_| exec::home());
    base.join("Ruby Manager").join("projects.json")
}

fn load_projects(app: &AppHandle) -> Vec<String> {
    std::fs::read_to_string(store_file(app)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn save_projects(app: &AppHandle, list: Vec<String>) -> Res<()> {
    let mut uniq: Vec<String> = Vec::with_capacity(list.len());
    for p in list {
        if !uniq.contains(&p) {
            uniq.push(p);
        }
    }
    let file = store_file(app);
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(e2s)?;
    }
    std::fs::write(&file, serde_json::to_string_pretty(&uniq).map_err(e2s)?).map_err(e2s)
}

fn analyzed_projects(app: &AppHandle) -> Vec<Value> {
    load_projects(app).iter().map(|d| analyze_project(app, d)).collect()
}

// ------------------------------------------------------------ ジョブ（長時間コマンドのストリーミング）

type OnEnd = Box<dyn FnOnce(&AppHandle, &RunResult) -> Res<Value> + Send>;

struct JobSpec {
    title: String,
    cmd: String,
    args: Vec<String>,
    cwd: Option<PathBuf>,
    env: Option<Env>,
    on_end: Option<OnEnd>,
}

fn start_job(app: &AppHandle, job: JobSpec) -> u64 {
    let id = state(app).seq.fetch_add(1, Ordering::SeqCst) + 1;
    let command = std::iter::once(job.cmd.as_str()).chain(job.args.iter().map(String::as_str)).collect::<Vec<_>>().join(" ");
    let _ = app.emit(
        "job:start",
        json!({ "id": id, "title": job.title, "command": command, "cwd": job.cwd.as_ref().map(|p| p.to_string_lossy()) }),
    );
    let app = app.clone();
    std::thread::spawn(move || {
        let job_env = job.env.unwrap_or_else(|| (*env(&app, false)).clone());
        let emitter = app.clone();
        let on_data = move |chunk: &str, stream: &'static str| {
            let _ = emitter.emit("job:data", json!({ "id": id, "chunk": chunk, "stream": stream }));
        };
        let on_spawn = |h: ChildHandle| {
            state(&app).jobs.lock().unwrap().insert(id, h);
        };
        let res = exec::run(
            &job.cmd,
            &job.args,
            RunOpts { cwd: job.cwd.as_deref(), env: Some(&job_env), on_data: Some(&on_data), on_spawn: Some(&on_spawn), timeout: None },
        );
        state(&app).jobs.lock().unwrap().remove(&id);
        let extra = match job.on_end {
            Some(f) => f(&app, &res).unwrap_or_else(|e| json!({ "error": e })),
            None => Value::Null,
        };
        let _ = app.emit("job:end", json!({ "id": id, "code": res.code, "extra": extra }));
    });
    id
}

fn rescan_on_end() -> Option<OnEnd> {
    Some(Box::new(|app: &AppHandle, _: &RunResult| {
        rescan(app, false);
        Ok(json!({ "rescanned": true }))
    }))
}

struct RubyCommand {
    cmd: String,
    args: Vec<String>,
    env: Env,
    version: String,
}

/// 指定 Ruby で実行するためのコマンドと環境
fn ruby_command(app: &AppHandle, ruby_id: &str, cmd: &str, args: &[String]) -> Res<RubyCommand> {
    let c = cache(app);
    let ruby = c.rubies.iter().find(|r| r.id == ruby_id).ok_or("対象の Ruby が見つかりません。再スキャンしてください。")?;
    let wrapped = c.manager(&ruby.manager)?.exec_cmd(ruby, cmd, args);
    let base = env(app, false);
    let env = match &wrapped.bin_dir {
        Some(bin) => exec::env_with_ruby(&base, bin, Some(&ruby.version)),
        None => (*base).clone(),
    };
    Ok(RubyCommand { cmd: wrapped.cmd, args: wrapped.args, env, version: ruby.version.clone() })
}

fn is_gem_name(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
}

fn strings(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| s.to_string()).collect()
}

// ------------------------------------------------------------ コマンド

#[tauri::command]
async fn env_scan(app: AppHandle) -> Res<Value> {
    blocking(app, |app| {
        let c = rescan(app, true);
        Ok(json!({ "platform": PLATFORM, "managers": c.managers, "rubies": c.rubies }))
    })
    .await
}

const DETAIL_SCRIPT: &str = r#"require "json"; require "rbconfig"
specs = Gem::Specification.to_a
puts JSON.generate({
  description: RUBY_DESCRIPTION, gem: Gem::VERSION, gemDir: Gem.dir, prefix: RbConfig::CONFIG["prefix"],
  bundlers: specs.select { |s| s.name == "bundler" }.map { |s| s.version.to_s }.sort,
  gems: specs.map { |s| [s.name, s.version.to_s, (s.respond_to?(:default_gem?) && s.default_gem?) ? true : false] }.sort_by { |n, v| [n, Gem::Version.new(v)] }
})"#;

#[tauri::command]
async fn ruby_detail(app: AppHandle, ruby_id: String) -> Res<Value> {
    blocking(app, move |app| {
        let script = std::env::temp_dir().join("ruby-manager-detail.rb");
        std::fs::write(&script, DETAIL_SCRIPT).map_err(e2s)?;
        let c = ruby_command(app, &ruby_id, "ruby", &[script.to_string_lossy().into_owned()])?;
        let r = exec::run(&c.cmd, &c.args, RunOpts { env: Some(&c.env), timeout: Some(Duration::from_secs(30)), ..Default::default() });
        if r.code != 0 {
            return Err(if r.stderr.is_empty() { "ruby の実行に失敗しました".into() } else { r.stderr });
        }
        let line = r.stdout.trim().lines().last().unwrap_or("");
        serde_json::from_str(line).map_err(e2s)
    })
    .await
}

#[tauri::command]
async fn ruby_remote(app: AppHandle, manager: String, all: Option<bool>) -> Res<Vec<String>> {
    blocking(app, move |app| {
        let e = env(app, false);
        Ok(cache(app).manager(&manager)?.list_remote(&e, all.unwrap_or(false)))
    })
    .await
}

#[tauri::command]
async fn ruby_set_global(app: AppHandle, manager: String, version: String) -> Res<bool> {
    blocking(app, move |app| {
        let e = env(app, false);
        let r = cache(app).manager(&manager)?.set_global(&e, &version)?;
        if r.code != 0 {
            let msg = if !r.stderr.is_empty() { r.stderr } else if !r.stdout.is_empty() { r.stdout } else { "失敗しました".into() };
            return Err(msg);
        }
        Ok(true)
    })
    .await
}

#[tauri::command]
async fn ruby_install(app: AppHandle, manager: String, version: String) -> Res<u64> {
    blocking(app, move |app| {
        let c = cache(app).manager(&manager)?.install_cmd(&version)?.ok_or("このマネージャはインストールに対応していません")?;
        Ok(start_job(
            app,
            JobSpec {
                title: format!("Ruby {version} をインストール ({manager})"),
                cmd: c.cmd,
                args: c.args,
                cwd: None,
                env: None,
                on_end: rescan_on_end(),
            },
        ))
    })
    .await
}

#[tauri::command]
async fn ruby_uninstall(app: AppHandle, manager: String, version: String) -> Res<Option<u64>> {
    blocking(app, move |app| {
        let u = cache(app).manager(&manager)?.uninstall_cmd(&version)?.ok_or("このマネージャはアンインストールに対応していません")?;
        match u {
            Uninstall::Remove(dir) => {
                if dir.exists() {
                    std::fs::remove_dir_all(&dir).map_err(e2s)?;
                }
                rescan(app, false);
                Ok(None)
            }
            Uninstall::Cmd(c) => Ok(Some(start_job(
                app,
                JobSpec {
                    title: format!("Ruby {version} をアンインストール ({manager})"),
                    cmd: c.cmd,
                    args: c.args,
                    cwd: None,
                    env: None,
                    on_end: rescan_on_end(),
                },
            ))),
        }
    })
    .await
}

#[tauri::command]
async fn ruby_gem_install(app: AppHandle, ruby_id: String, gem: String, version: Option<String>) -> Res<u64> {
    blocking(app, move |app| {
        let version = version.filter(|v| !v.is_empty());
        if !is_gem_name(&gem) || version.as_deref().is_some_and(|v| !is_gem_name(v)) {
            return Err("不正な gem 指定".into());
        }
        let mut args = strings(&["install", &gem]);
        if let Some(v) = &version {
            args.extend(strings(&["-v", v]));
        }
        let c = ruby_command(app, &ruby_id, "gem", &args)?;
        let title = format!("gem install {gem}{} (Ruby {})", version.map(|v| format!(" -v {v}")).unwrap_or_default(), c.version);
        Ok(start_job(app, JobSpec { title, cmd: c.cmd, args: c.args, cwd: None, env: Some(c.env), on_end: None }))
    })
    .await
}

#[tauri::command]
async fn projects_list(app: AppHandle) -> Res<Vec<Value>> {
    blocking(app, |app| Ok(analyzed_projects(app))).await
}

fn is_ruby_project(d: &Path) -> bool {
    ["Gemfile", "gems.rb", ".ruby-version", ".tool-versions"].iter().any(|f| d.join(f).exists())
}

#[tauri::command]
async fn projects_add(app: AppHandle) -> Res<Vec<Value>> {
    blocking(app, |app| {
        let mut dialog = app.dialog().file().set_title("リポジトリを追加（Gemfile のないフォルダを選ぶと配下のリポジトリを一括追加）");
        if let Ok(w) = main_window(app) {
            dialog = dialog.set_parent(&w);
        }
        let Some(picked) = dialog.blocking_pick_folders() else { return Ok(analyzed_projects(app)) };
        let mut list = load_projects(app);
        for dir in picked.into_iter().filter_map(|p| p.into_path().ok()) {
            if is_ruby_project(&dir) {
                list.push(dir.to_string_lossy().into_owned());
                continue;
            }
            let mut subs: Vec<PathBuf> = std::fs::read_dir(&dir)
                .map_err(e2s)?
                .flatten()
                .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
                .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
                .map(|e| e.path())
                .filter(|p| is_ruby_project(p))
                .collect();
            subs.sort();
            if subs.is_empty() {
                list.push(dir.to_string_lossy().into_owned());
            } else {
                list.extend(subs.iter().map(|p| p.to_string_lossy().into_owned()));
            }
        }
        save_projects(app, list)?;
        Ok(analyzed_projects(app))
    })
    .await
}

#[tauri::command]
async fn projects_remove(app: AppHandle, dir: String) -> Res<bool> {
    blocking(app, move |app| {
        let list = load_projects(app).into_iter().filter(|p| *p != dir).collect();
        save_projects(app, list)?;
        Ok(true)
    })
    .await
}

#[tauri::command]
async fn project_analyze(app: AppHandle, dir: String) -> Res<Value> {
    blocking(app, move |app| Ok(analyze_project(app, &dir))).await
}

#[tauri::command]
async fn project_set_ruby(app: AppHandle, dir: String, version: String) -> Res<Value> {
    blocking(app, move |app| {
        managers::assert_version(&version)?;
        let a = analyze_project(app, &dir);
        let mut touched: Vec<String> = vec![];
        for s in a["sources"].as_array().into_iter().flatten() {
            let name = s["file"].as_str().unwrap_or_default();
            let file = Path::new(&dir).join(name);
            let txt = project::read(&file).ok_or_else(|| format!("{name} を読めません"))?;
            let new = match name {
                ".ruby-version" => format!("{version}\n"),
                ".tool-versions" => project::RE_TOOL_VERSIONS_LINE.replace(&txt, format!("ruby {version}").as_str()).into_owned(),
                _ => project::RE_MISE_LINE.replace(&txt, format!("${{1}}{version}${{2}}").as_str()).into_owned(),
            };
            std::fs::write(&file, new).map_err(e2s)?;
            touched.push(name.to_string());
        }
        if touched.is_empty() {
            std::fs::write(Path::new(&dir).join(".ruby-version"), format!("{version}\n")).map_err(e2s)?;
            touched.push(".ruby-version".into());
        }
        Ok(json!({ "touched": touched, "project": analyze_project(app, &dir) }))
    })
    .await
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct BundleOpts {
    value: bool,
    platform: Option<String>,
    gems: Vec<String>,
}

#[tauri::command]
async fn project_bundle(app: AppHandle, dir: String, action: String, opts: Option<BundleOpts>) -> Res<u64> {
    blocking(app, move |app| {
        let opts = opts.unwrap_or_default();
        let a = analyze_project(app, &dir);
        let ruby_id = a["resolved"]["id"].as_str().ok_or("このプロジェクト用の Ruby がインストールされていません")?.to_string();
        let name = a["name"].as_str().unwrap_or_default().to_string();
        let platform = || -> Res<String> {
            opts.platform.clone().filter(|p| is_gem_name(p)).ok_or_else(|| "不正なプラットフォーム".to_string())
        };
        let mut on_end: Option<OnEnd> = None;
        let args: Vec<String> = match action.as_str() {
            "install" | "check" | "clean" | "lock" => vec![action.clone()],
            "update" => {
                let gems: Vec<String> = opts.gems.iter().filter(|g| is_gem_name(g)).cloned().collect();
                if gems.is_empty() {
                    strings(&["update", "--all"])
                } else {
                    std::iter::once("update".to_string()).chain(gems).collect()
                }
            }
            "outdated" => {
                on_end = Some(Box::new(|_: &AppHandle, res: &RunResult| Ok(json!({ "outdated": lockfile::parse_outdated(&res.stdout) }))));
                strings(&["outdated", "--parseable"])
            }
            "addPlatform" => strings(&["lock", "--add-platform", &platform()?]),
            "removePlatform" => strings(&["lock", "--remove-platform", &platform()?]),
            "setPath" => {
                if opts.value {
                    strings(&["config", "set", "--local", "path", "vendor/bundle"])
                } else {
                    strings(&["config", "unset", "--local", "path"])
                }
            }
            "installBundler" => {
                let v = a["bundle"]["bundledWith"].as_str().filter(|v| is_gem_name(v)).ok_or("Gemfile.lock に BUNDLED WITH がありません")?;
                let c = ruby_command(app, &ruby_id, "gem", &strings(&["install", "bundler", "-v", v]))?;
                return Ok(start_job(
                    app,
                    JobSpec {
                        title: format!("bundler {v} をインストール ({name})"),
                        cmd: c.cmd,
                        args: c.args,
                        cwd: Some(PathBuf::from(&dir)),
                        env: Some(c.env),
                        on_end: None,
                    },
                ));
            }
            other => return Err(format!("unknown action: {other}")),
        };
        let c = ruby_command(app, &ruby_id, "bundle", &args)?;
        Ok(start_job(
            app,
            JobSpec {
                title: format!("bundle {} ({name} / Ruby {})", args.join(" "), c.version),
                cmd: c.cmd,
                args: c.args,
                cwd: Some(PathBuf::from(&dir)),
                env: Some(c.env),
                on_end,
            },
        ))
    })
    .await
}

#[tauri::command]
async fn job_cancel(app: AppHandle, id: u64) -> Res<bool> {
    blocking(app, move |app| {
        let h = state(app).jobs.lock().unwrap().get(&id).cloned();
        if let Some(h) = h {
            exec::kill(&h);
        }
        Ok(true)
    })
    .await
}

/// iOS の systemGroupedBackground に合わせる
fn window_background(dark: bool) -> Color {
    if dark { Color(0, 0, 0, 255) } else { Color(0xf2, 0xf2, 0xf7, 255) }
}

#[tauri::command]
async fn theme_set(app: AppHandle, theme: String) -> Res<bool> {
    let w = main_window(&app)?;
    let t = match theme.as_str() {
        "light" => Some(Theme::Light),
        "dark" => Some(Theme::Dark),
        _ => None,
    };
    w.set_theme(t).map_err(e2s)?;
    let dark = matches!(w.theme(), Ok(Theme::Dark));
    let _ = w.set_background_color(Some(window_background(dark)));
    Ok(dark)
}

#[tauri::command]
async fn shell_open_path(app: AppHandle, path: String) -> Res<()> {
    app.opener().open_path(path, None::<&str>).map_err(e2s)
}

#[tauri::command]
async fn shell_open_external(app: AppHandle, url: String) -> Res<()> {
    if !url.starts_with("https://") {
        return Err("https のみ".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(e2s)
}

/// window.confirm の代わり（WebView によってはネイティブの confirm が使えないため）
#[tauri::command]
async fn dialog_confirm(app: AppHandle, message: String) -> Res<bool> {
    blocking(app, move |app| {
        let mut d = app
            .dialog()
            .message(message)
            .title("Ruby Manager")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancel);
        if let Ok(w) = main_window(app) {
            d = d.parent(&w);
        }
        Ok(d.blocking_show())
    })
    .await
}

// ------------------------------------------------------------ 起動

fn create_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let init = format!("window.__RUBY_MANAGER__ = {{ platform: {PLATFORM:?} }};");
    #[allow(unused_mut)]
    let mut b = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Ruby Manager")
        .inner_size(1280.0, 820.0)
        .min_inner_size(900.0, 600.0)
        .background_color(window_background(false))
        .initialization_script(&init);
    #[cfg(target_os = "macos")]
    {
        b = b
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(tauri::LogicalPosition::new(18.0, 18.0));
    }
    b.build()
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            env_scan,
            ruby_detail,
            ruby_remote,
            ruby_set_global,
            ruby_install,
            ruby_uninstall,
            ruby_gem_install,
            projects_list,
            projects_add,
            projects_remove,
            project_analyze,
            project_set_ruby,
            project_bundle,
            job_cancel,
            theme_set,
            shell_open_path,
            shell_open_external,
            dialog_confirm,
        ])
        .setup(|app| {
            let w = create_window(app.handle())?;
            if let Ok(t) = w.theme() {
                let _ = w.set_background_color(Some(window_background(t == Theme::Dark)));
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Tauri アプリケーションの起動に失敗しました")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                let jobs: Vec<ChildHandle> = state(app).jobs.lock().unwrap().values().cloned().collect();
                for j in jobs {
                    exec::kill(&j);
                }
            }
        });
}
