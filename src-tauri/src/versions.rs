//! バージョン文字列の比較・要件判定・EOL 情報

use regex::Regex;
use serde::Serialize;
use std::cmp::Ordering;
use std::sync::LazyLock;
use std::time::{SystemTime, UNIX_EPOCH};

static RE_RUBY_PREFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^ruby[-@ ]").unwrap());
static RE_PATCHLEVEL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"p\d+$").unwrap());
static RE_RELEASE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d+(\.\d+)*$").unwrap());
static RE_SERIES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(\d+)\.(\d+)").unwrap());
static RE_REQ: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(~>|>=|<=|!=|>|<|=)?\s*(.+)$").unwrap());
static RE_MAJMIN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d+\.\d+$").unwrap());

/// "ruby-3.3.0" / "3.3.0p108" → "3.3.0"
pub fn normalize(v: &str) -> String {
    let t = RE_RUBY_PREFIX.replace(v.trim(), "");
    RE_PATCHLEVEL.replace(&t, "").into_owned()
}

#[derive(Debug, Clone, PartialEq)]
enum Seg {
    Num(u64),
    /// 片方だけ短いとき、文字列セグメントの相手側に入る「正式版」扱いの無限大
    Inf,
    Str(String),
}

fn segments(v: &str) -> Vec<Seg> {
    normalize(v)
        .split(['.', '-'])
        .map(|s| {
            if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) {
                s.parse::<u64>().map(Seg::Num).unwrap_or(Seg::Inf)
            } else {
                Seg::Str(s.to_string())
            }
        })
        .collect()
}

fn cmp_seg(x: &Seg, y: &Seg) -> Ordering {
    match (x, y) {
        (Seg::Str(a), Seg::Str(b)) => a.cmp(b),
        (Seg::Str(_), _) => Ordering::Less,
        (_, Seg::Str(_)) => Ordering::Greater,
        (Seg::Inf, Seg::Inf) => Ordering::Equal,
        (Seg::Inf, _) => Ordering::Greater,
        (_, Seg::Inf) => Ordering::Less,
        (Seg::Num(a), Seg::Num(b)) => a.cmp(b),
    }
}

/// Gem::Version 風の比較。プレリリース（文字を含む）は正式版より小さい
pub fn compare(a: &str, b: &str) -> Ordering {
    let sa = segments(a);
    let sb = segments(b);
    for i in 0..sa.len().max(sb.len()) {
        let (x, y) = match (sa.get(i), sb.get(i)) {
            (Some(x), Some(y)) => (x.clone(), y.clone()),
            (None, Some(y)) => (if matches!(y, Seg::Str(_)) { Seg::Inf } else { Seg::Num(0) }, y.clone()),
            (Some(x), None) => (x.clone(), if matches!(x, Seg::Str(_)) { Seg::Inf } else { Seg::Num(0) }),
            (None, None) => unreachable!(),
        };
        match cmp_seg(&x, &y) {
            Ordering::Equal => continue,
            o => return o,
        }
    }
    Ordering::Equal
}

#[allow(dead_code)]
pub fn is_release(v: &str) -> bool {
    RE_RELEASE.is_match(&normalize(v))
}

/// "~> 3.2", ">= 3.1, < 4" のような要件を満たすか
pub fn satisfies(version: &str, requirement: &str) -> bool {
    if requirement.is_empty() {
        return true;
    }
    let v = normalize(version);
    requirement.split(',').map(str::trim).filter(|s| !s.is_empty()).all(|part| {
        let Some(m) = RE_REQ.captures(part) else { return false };
        let explicit = m.get(1).map(|x| x.as_str());
        let target = normalize(&m[2]);
        let c = compare(&v, &target);
        match explicit.unwrap_or("=") {
            "=" => c == Ordering::Equal || (explicit.is_none() && v.starts_with(&format!("{target}."))),
            "!=" => c != Ordering::Equal,
            ">" => c == Ordering::Greater,
            "<" => c == Ordering::Less,
            ">=" => c != Ordering::Less,
            "<=" => c != Ordering::Greater,
            "~>" => {
                let segs: Vec<&str> = target.split('.').collect();
                let mut upper: Vec<String> = (if segs.len() > 1 { &segs[..segs.len() - 1] } else { &segs[..] })
                    .iter()
                    .map(|s| s.to_string())
                    .collect();
                let last = upper.last_mut().unwrap();
                *last = match last.parse::<u64>() {
                    Ok(n) => (n + 1).to_string(),
                    Err(_) if last.is_empty() => "1".into(),
                    Err(_) => "NaN".into(),
                };
                c != Ordering::Less && compare(&v, &upper.join(".")) == Ordering::Less
            }
            _ => false,
        }
    })
}

/// 指定（"3.3.0" / "3.3" / "ruby-3.3.0"）にマッチするインストール済みバージョンを返す。
/// 完全一致を優先し、無ければプレフィックス一致の最新版。戻り値の bool は完全一致かどうか。
pub fn resolve<'a, T>(spec: &str, installed: &'a [T], version_of: impl Fn(&T) -> &str) -> Option<(&'a T, bool)> {
    let want = normalize(spec);
    if want.is_empty() {
        return None;
    }
    if let Some(r) = installed.iter().find(|r| normalize(version_of(r)) == want) {
        return Some((r, true));
    }
    let prefix = format!("{want}.");
    let mut best: Option<&T> = None;
    for r in installed.iter().filter(|r| normalize(version_of(r)).starts_with(&prefix)) {
        if best.map_or(true, |b| compare(version_of(r), version_of(b)) == Ordering::Greater) {
            best = Some(r);
        }
    }
    best.map(|r| (r, false))
}

pub fn series(v: &str) -> String {
    let n = normalize(v);
    match RE_SERIES.captures(&n) {
        Some(m) => format!("{}.{}", &m[1], &m[2]),
        None => n,
    }
}

/// 公式のブランチ保守状況（https://www.ruby-lang.org/ja/downloads/branches/）。未来の日付は予定。
const EOL: &[(&str, &str)] = &[
    ("2.6", "2022-04-12"),
    ("2.7", "2023-03-31"),
    ("3.0", "2024-04-23"),
    ("3.1", "2025-03-26"),
    ("3.2", "2026-03-31"),
    ("3.3", "2027-03-31"),
    ("3.4", "2028-03-31"),
    ("4.0", "2029-03-31"),
];

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct Lifecycle {
    pub status: &'static str,
    pub label: &'static str,
    pub eol: Option<&'static str>,
}

const DAY_MS: f64 = 86_400_000.0;

/// "YYYY-MM-DD" → UNIX エポックからのミリ秒（UTC 0 時）
pub fn date_ms(ymd: &str) -> Option<f64> {
    let mut it = ymd.split('-').map(|s| s.parse::<i64>().ok());
    let (y, m, d) = (it.next()??, it.next()??, it.next()??);
    // Howard Hinnant の days_from_civil
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some((era * 146_097 + doe - 719_468) as f64 * DAY_MS)
}

pub fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

pub fn lifecycle(v: &str) -> Lifecycle {
    lifecycle_at(v, now_ms())
}

pub fn lifecycle_at(v: &str, today_ms: f64) -> Lifecycle {
    let s = series(v);
    let Some(&(_, eol)) = EOL.iter().find(|(k, _)| *k == s) else {
        let maj = s.split('.').next().and_then(|x| x.parse::<f64>().ok()).unwrap_or(0.0);
        if maj != 0.0 && maj < 2.0 {
            return Lifecycle { status: "eol", label: "EOL", eol: None };
        }
        if RE_MAJMIN.is_match(&s) && compare(&s, "4.0") == Ordering::Greater {
            return Lifecycle { status: "normal", label: "保守中", eol: None };
        }
        return Lifecycle { status: "unknown", label: "不明", eol: None };
    };
    let end = date_ms(eol).unwrap_or(0.0);
    if end < today_ms {
        return Lifecycle { status: "eol", label: "EOL", eol: Some(eol) };
    }
    let months = (end - today_ms) / (DAY_MS * 30.0);
    if months <= 12.0 {
        Lifecycle { status: "security", label: "セキュリティ保守", eol: Some(eol) }
    } else {
        Lifecycle { status: "normal", label: "保守中", eol: Some(eol) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compare_and_satisfies() {
        assert_eq!(compare("3.3.10", "3.3.9"), Ordering::Greater);
        assert_eq!(compare("3.4.0-preview1", "3.4.0"), Ordering::Less);
        assert_eq!(compare("ruby-3.3.0", "3.3.0"), Ordering::Equal);
        assert!(satisfies("3.3.6", "~> 3.3"));
        assert!(!satisfies("4.0.0", "~> 3.3"));
        assert!(satisfies("3.3.6", "~> 3.3.1"));
        assert!(!satisfies("3.4.0", "~> 3.3.1"));
        assert!(satisfies("3.2.1", ">= 3.1, < 3.3"));
        assert!(!satisfies("3.3.0", ">= 3.1, < 3.3"));
        assert!(satisfies("3.3.6", "3.3"));
        assert!(is_release("3.3.6") && !is_release("3.4.0-preview1"));
    }

    #[test]
    fn resolve_picks_exact_then_highest_prefix() {
        let inst = ["3.3.1", "3.3.6", "3.4.1"];
        fn v<'a>(s: &'a &str) -> &'a str {
            s
        }
        assert_eq!(*resolve("3.3.1", &inst, v).unwrap().0, "3.3.1");
        assert_eq!(*resolve("3.3", &inst, v).unwrap().0, "3.3.6");
        assert_eq!(*resolve("ruby-3.4.1", &inst, v).unwrap().0, "3.4.1");
        assert!(resolve("3.2", &inst, v).is_none());
    }

    #[test]
    fn lifecycle_status() {
        let d = date_ms("2026-11-05").unwrap();
        assert_eq!(lifecycle_at("3.1.4", d).status, "eol");
        assert_eq!(lifecycle_at("3.3.6", d).status, "security");
        assert_eq!(lifecycle_at("3.4.1", d).status, "normal");
        assert_eq!(lifecycle_at("1.9.3", d).status, "eol");
        assert_eq!(lifecycle_at("jruby-9.4", d).status, "unknown");
    }

    #[test]
    fn civil_date() {
        assert_eq!(date_ms("1970-01-01"), Some(0.0));
        assert_eq!(date_ms("2000-03-01"), Some(951_868_800_000.0));
    }
}
