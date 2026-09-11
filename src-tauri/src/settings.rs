use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub mode: DisplayMode,
    pub opacity: f64,
    pub refresh_interval_seconds: u64,
    pub always_on_top: bool,
    pub launch_on_startup: bool,
    pub normal_width: u32,
    pub normal_height: u32,
    pub position_x: Option<i32>,
    pub position_y: Option<i32>,
}

#[derive(Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DisplayMode {
    Normal,
    Mini,
    Collapsed,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            mode: DisplayMode::Normal,
            opacity: 1.0,
            refresh_interval_seconds: 60,
            always_on_top: true,
            launch_on_startup: false,
            normal_width: 280,
            normal_height: 440,
            position_x: None,
            position_y: None,
        }
    }
}

pub struct SettingsStore {
    path: PathBuf,
}

impl SettingsStore {
    pub fn new(mut directory: PathBuf) -> Self {
        if directory.as_os_str().is_empty() {
            directory = PathBuf::from(".");
        }
        Self {
            path: directory.join("settings.json"),
        }
    }

    pub fn load(&self) -> AppSettings {
        fs::read_to_string(&self.path)
            .ok()
            .and_then(|contents| serde_json::from_str(&contents).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, settings: &AppSettings) -> Result<(), String> {
        self.write_file(settings)?;
        set_startup(settings.launch_on_startup)
    }

    fn write_file(&self, settings: &AppSettings) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let contents = serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?;
        fs::write(&self.path, contents).map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn update_position(&self, x: i32, y: i32) -> Result<(), String> {
        let mut settings = self.load();
        settings.position_x = Some(x);
        settings.position_y = Some(y);
        self.write_file(&settings)
    }

    pub fn update_mode(&self, mode: DisplayMode) -> Result<(), String> {
        let mut settings = self.load();
        settings.mode = mode;
        self.write_file(&settings)
    }
}

#[cfg(windows)]
fn set_startup(enabled: bool) -> Result<(), String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let key = RegKey::predef(HKEY_CURRENT_USER)
        .create_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Run")
        .map_err(|error| error.to_string())?
        .0;
    if enabled {
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        key.set_value("AILimits", &executable.to_string_lossy().to_string())
            .map_err(|error| error.to_string())
    } else {
        match key.delete_value("AILimits") {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }
}

#[cfg(not(windows))]
fn set_startup(_enabled: bool) -> Result<(), String> {
    Ok(())
}
