use chrono::{DateTime, Datelike, Local, NaiveDateTime, TimeZone, Timelike, Utc};
use serde::Serialize;
use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

#[derive(Clone, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderStatus {
    Available,
    Partial,
    Unavailable,
    Error,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub used_percent: Option<i32>,
    pub remaining_percent: Option<i32>,
    pub resets_at: Option<String>,
    pub window_minutes: Option<i64>,
    pub label: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsage {
    pub provider: String,
    pub status: ProviderStatus,
    pub windows: Vec<UsageWindow>,
    pub updated_at: String,
    pub message: Option<String>,
    pub source: Option<String>,
}

pub trait UsageProvider: Send + 'static {
    fn get_usage(self) -> ProviderUsageResult;
}

pub struct ProviderUsageResult(ProviderUsage);
impl ProviderUsageResult {
    pub fn into_usage(self) -> ProviderUsage {
        self.0
    }
}

pub fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

fn safe_status_message(text: &str) -> String {
    let lower = text.to_ascii_lowercase();
    if lower.contains("login") || lower.contains("auth") || lower.contains("logged in") {
        "NOT LOGGED IN".to_string()
    } else if lower.contains("timed out") {
        "CLI TIMED OUT".to_string()
    } else {
        "DATA UNAVAILABLE".to_string()
    }
}

fn status_for_message(message: &str) -> ProviderStatus {
    match message {
        "NOT LOGGED IN" | "DATA UNAVAILABLE" => ProviderStatus::Unavailable,
        _ => ProviderStatus::Error,
    }
}

fn hidden_command(program: impl Into<PathBuf>) -> Command {
    let mut command = Command::new(program.into());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}

fn find_executable(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates
        .iter()
        .find(|candidate| candidate.is_file())
        .cloned()
}

fn codex_command() -> Command {
    let mut candidates = Vec::new();
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let root = PathBuf::from(local)
            .join("OpenAI")
            .join("Codex")
            .join("bin");
        if let Ok(entries) = std::fs::read_dir(root) {
            for entry in entries.flatten() {
                candidates.push(entry.path().join("codex.exe"));
            }
        }
    }
    hidden_command(find_executable(&candidates).unwrap_or_else(|| PathBuf::from("codex")))
}

fn claude_command() -> (Command, bool) {
    let mut candidates = Vec::new();
    if let Some(home) = std::env::var_os("USERPROFILE") {
        candidates.push(
            PathBuf::from(home)
                .join(".local")
                .join("bin")
                .join("claude.exe"),
        );
    }
    if let Some(app_data) = std::env::var_os("APPDATA") {
        candidates.push(
            PathBuf::from(app_data)
                .join("npm")
                .join("node_modules")
                .join("@anthropic-ai")
                .join("claude-code")
                .join("bin")
                .join("claude.exe"),
        );
    }
    if let Some(path) = find_executable(&candidates) {
        return (hidden_command(path), true);
    }
    #[cfg(windows)]
    {
        return (hidden_command("cmd"), false);
    }
    #[cfg(not(windows))]
    {
        (hidden_command("claude"), true)
    }
}

fn spawn_capture(
    mut command: Command,
    args: &[&str],
    input: Option<&str>,
) -> Result<(ExitStatus, Vec<u8>), String> {
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    if let Some(input) = input {
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(input.as_bytes())
                .map_err(|error| error.to_string())?;
        }
    } else {
        drop(child.stdin.take());
    }
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "stdout unavailable".to_string())?;
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = BufReader::new(stdout).read_to_end(&mut bytes);
        let _ = sender.send(bytes);
    });
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait().map_err(|error| error.to_string())? {
            let bytes = receiver
                .recv_timeout(Duration::from_secs(2))
                .unwrap_or_default();
            return Ok((status, bytes));
        }
        if started.elapsed() > Duration::from_secs(20) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("timed out".to_string());
        }
        thread::sleep(Duration::from_millis(25));
    }
}

fn spawn_json_lines(
    mut command: Command,
    args: &[&str],
    input: &str,
    wanted_id: i64,
) -> Result<Value, String> {
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(input.as_bytes())
            .map_err(|error| error.to_string())?;
    }
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "stdout unavailable".to_string())?;
    let (sender, receiver) = mpsc::channel::<String>();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().flatten() {
            if sender.send(line).is_err() {
                break;
            }
        }
    });
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(20) {
        let line = match receiver.recv_timeout(Duration::from_millis(500)) {
            Ok(line) => line,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        };
        let value: Value = serde_json::from_str(&line).map_err(|error| error.to_string())?;
        if value.get("id").and_then(Value::as_i64) == Some(wanted_id) {
            let _ = child.kill();
            let _ = child.wait();
            if let Some(error) = value.get("error") {
                return Err(error.to_string());
            }
            return Ok(value.get("result").cloned().unwrap_or(Value::Null));
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    Err("timed out".to_string())
}

pub struct CodexProvider;
impl Default for CodexProvider {
    fn default() -> Self {
        Self
    }
}
impl CodexProvider {
    pub fn unavailable(&self, message: &str) -> ProviderUsageResult {
        ProviderUsageResult(ProviderUsage {
            provider: "codex".to_string(),
            status: status_for_message(message),
            windows: vec![],
            updated_at: now_iso(),
            message: Some(message.to_string()),
            source: Some("Codex app-server account/rateLimits/read".to_string()),
        })
    }
}
impl UsageProvider for CodexProvider {
    fn get_usage(self) -> ProviderUsageResult {
        let init = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"ai-limits","title":"AI Limits","version":"0.1.0"}}}
{"jsonrpc":"2.0","method":"initialized","params":{}}
{"jsonrpc":"2.0","id":2,"method":"account/rateLimits/read","params":{}}
"#;
        let result = match spawn_json_lines(codex_command(), &["app-server", "--stdio"], init, 2) {
            Ok(value) => value,
            Err(error) => return self.unavailable(&safe_status_message(&error)),
        };
        let snapshot = result
            .get("rateLimitsByLimitId")
            .and_then(|value| value.get("codex"))
            .or_else(|| result.get("rateLimits"));
        let Some(snapshot) = snapshot else {
            return self.unavailable("DATA UNAVAILABLE");
        };
        let mut windows = Vec::new();
        for key in ["primary", "secondary"] {
            if let Some(window) = snapshot.get(key) {
                let used = window
                    .get("usedPercent")
                    .and_then(Value::as_i64)
                    .map(|value| value as i32);
                if used.is_none() {
                    continue;
                }
                let minutes = window.get("windowDurationMins").and_then(Value::as_i64);
                let label = match minutes {
                    Some(300) => "5H WINDOW",
                    Some(10080) => "WEEK",
                    _ if key == "primary" => "CURRENT",
                    _ => "SECONDARY",
                };
                let reset = window
                    .get("resetsAt")
                    .and_then(Value::as_i64)
                    .and_then(|seconds| DateTime::<Utc>::from_timestamp(seconds, 0))
                    .map(|date| date.to_rfc3339());
                let used = used.unwrap();
                windows.push(UsageWindow {
                    used_percent: Some(used),
                    remaining_percent: Some((100 - used).max(0)),
                    resets_at: reset,
                    window_minutes: minutes,
                    label: label.to_string(),
                });
            }
        }
        if windows.is_empty() {
            return self.unavailable("DATA UNAVAILABLE");
        }
        let status = if windows.len() >= 2 {
            ProviderStatus::Available
        } else {
            ProviderStatus::Partial
        };
        ProviderUsageResult(ProviderUsage {
            provider: "codex".to_string(),
            status,
            windows,
            updated_at: now_iso(),
            message: None,
            source: Some("Codex app-server account/rateLimits/read".to_string()),
        })
    }
}

pub struct ClaudeProvider;
impl Default for ClaudeProvider {
    fn default() -> Self {
        Self
    }
}
impl ClaudeProvider {
    pub fn unavailable(&self, message: &str) -> ProviderUsageResult {
        ProviderUsageResult(ProviderUsage {
            provider: "claude".to_string(),
            status: status_for_message(message),
            windows: vec![],
            updated_at: now_iso(),
            message: Some(message.to_string()),
            source: Some("Claude Code /usage via official CLI".to_string()),
        })
    }
}
impl UsageProvider for ClaudeProvider {
    fn get_usage(self) -> ProviderUsageResult {
        let (command, direct) = claude_command();
        let args: Vec<&str> = if direct {
            vec![
                "-p",
                "/usage",
                "--output-format",
                "json",
                "--no-session-persistence",
                "--permission-mode",
                "plan",
            ]
        } else {
            vec![
                "/C",
                "claude",
                "-p",
                "/usage",
                "--output-format",
                "json",
                "--no-session-persistence",
                "--permission-mode",
                "plan",
            ]
        };
        let (_status, bytes) = match spawn_capture(command, &args, None) {
            Ok(output) => output,
            Err(error) => return self.unavailable(&safe_status_message(&error)),
        };
        let envelope: Value = match serde_json::from_slice(&bytes) {
            Ok(value) => value,
            Err(_) => return self.unavailable("DATA UNAVAILABLE"),
        };
        let result = envelope.get("result").and_then(Value::as_str).unwrap_or("");
        if envelope
            .get("is_error")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            || result.to_ascii_lowercase().contains("not logged")
            || result.to_ascii_lowercase().contains("log in")
        {
            return self.unavailable("NOT LOGGED IN");
        }
        let mut windows = Vec::new();
        if let Some(window) = parse_claude_line(result, "Current session:", "SESSION") {
            windows.push(window);
        }
        if let Some(window) = parse_claude_line(result, "Current week (all models):", "WEEK") {
            windows.push(window);
        }
        if windows.is_empty() {
            return self.unavailable("DATA UNAVAILABLE");
        }
        let status = if windows.len() >= 2 {
            ProviderStatus::Available
        } else {
            ProviderStatus::Partial
        };
        ProviderUsageResult(ProviderUsage {
            provider: "claude".to_string(),
            status,
            windows,
            updated_at: now_iso(),
            message: None,
            source: Some("Claude Code /usage via official CLI".to_string()),
        })
    }
}

fn parse_claude_line(text: &str, prefix: &str, label: &str) -> Option<UsageWindow> {
    let line = text
        .lines()
        .find(|line| line.trim_start().starts_with(prefix))?
        .trim();
    let used_part = line.split('%').next()?.rsplit(' ').next()?;
    let used = used_part.parse::<i32>().ok()?;
    let reset_text = line
        .split("· resets ")
        .nth(1)
        .map(|value| value.split(" (").next().unwrap_or(value).trim());
    let reset = reset_text.and_then(parse_claude_reset);
    Some(UsageWindow {
        used_percent: Some(used),
        remaining_percent: Some((100 - used).max(0)),
        resets_at: reset,
        window_minutes: None,
        label: label.to_string(),
    })
}

fn parse_claude_reset(text: &str) -> Option<String> {
    let mut value = text.to_string();
    if let Some(am) = value.to_ascii_lowercase().find("am") {
        if !value[..am].contains(':') {
            value.insert(am, ':');
            value.insert(am + 1, '0');
        }
    }
    if let Some(pm) = value.to_ascii_lowercase().find("pm") {
        if !value[..pm].contains(':') {
            value.insert(pm, ':');
            value.insert(pm + 1, '0');
        }
    }
    let year = Local::now().year();
    let naive =
        NaiveDateTime::parse_from_str(&format!("{year} {value}"), "%Y %b %d, %I:%M%p").ok()?;
    let local = Local.from_local_datetime(&naive).single()?;
    let adjusted = if local < Local::now() - chrono::Duration::hours(12) {
        Local
            .with_ymd_and_hms(
                year + 1,
                naive.month(),
                naive.day(),
                naive.hour(),
                naive.minute(),
                0,
            )
            .single()?
    } else {
        local
    };
    Some(adjusted.to_rfc3339())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_claude_usage_windows_without_fabricating_percentages() {
        let text = "Current session: 88% used · resets Aug 30, 2:10am (America/Sao_Paulo)\nCurrent week (all models): 18% used · resets Sep 5, 11am (America/Sao_Paulo)";
        let session =
            parse_claude_line(text, "Current session:", "SESSION").expect("session window");
        let week =
            parse_claude_line(text, "Current week (all models):", "WEEK").expect("week window");
        assert_eq!(session.used_percent, Some(88));
        assert_eq!(session.remaining_percent, Some(12));
        assert_eq!(session.label, "SESSION");
        assert!(session.resets_at.is_some());
        assert_eq!(week.used_percent, Some(18));
        assert_eq!(week.remaining_percent, Some(82));
    }

    #[test]
    fn does_not_parse_unrecognized_provider_text() {
        assert!(parse_claude_line("usage changed", "Current session:", "SESSION").is_none());
        assert_eq!(
            safe_status_message("authentication required"),
            "NOT LOGGED IN"
        );
        assert_eq!(safe_status_message("timed out"), "CLI TIMED OUT");
    }

    #[test]
    #[ignore = "live provider smoke test; requires the local authenticated CLIs"]
    fn live_collectors_smoke_test() {
        let codex = CodexProvider::default().get_usage().into_usage();
        let claude = ClaudeProvider::default().get_usage().into_usage();
        assert!(matches!(
            codex.status,
            ProviderStatus::Available | ProviderStatus::Partial
        ));
        assert!(matches!(
            claude.status,
            ProviderStatus::Available | ProviderStatus::Partial
        ));
        assert!(!codex.windows.is_empty());
        assert!(!claude.windows.is_empty());
    }
}
