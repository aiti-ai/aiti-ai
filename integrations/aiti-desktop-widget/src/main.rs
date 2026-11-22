#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! aiti-desktop-widget — a business-agnostic desktop widget shell.
//!
//! Loads an http(s) page into a frameless transparent always-on-top window and exposes a
//! tiny JSONL control channel on stdin plus JSONL events on stdout. It knows nothing about
//! captions, icons or pets: the caller provides the page (and its own data channel, e.g. SSE).
//!
//! CLI / runtime config: see `docs/aiti-desktop-widget-overlay-shell-plan.md`.
//! Build: `cargo build --release` (or `npx tauri build` when bundling).

mod display;
mod local_server;

use std::io::{BufRead, Write};

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, LogicalUnit, PhysicalPosition, PixelUnit, Url,
    WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowSizeConstraints,
};

const DEFAULT_WIDTH: f64 = 800.0;
const DEFAULT_HEIGHT: f64 = 120.0;

#[derive(Debug, Clone, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct WindowCfg {
    width: f64,
    height: f64,
    x: Option<f64>,
    y: Option<f64>,
    title: String,
    decorations: bool,
    transparent: bool,
    always_on_top: bool,
    skip_taskbar: bool,
    focusable: bool,
    shadow: bool,
    resizable: bool,
    click_through: bool,
    draggable: bool,
    drag_region: String,
    all_workspaces: bool,
    zoom: f64,
    /// Monitor index, name or `primary`; `--x/--y` are then relative to it.
    display: Option<String>,
    /// Center the window on the selected (or primary) monitor.
    center: bool,
}

impl Default for WindowCfg {
    fn default() -> Self {
        Self {
            width: DEFAULT_WIDTH,
            height: DEFAULT_HEIGHT,
            x: None,
            y: None,
            title: "aiti-desktop-widget".to_string(),
            // Frameless by creation: runtime set_decorations is not honored by every WM.
            decorations: false,
            transparent: true,
            always_on_top: true,
            skip_taskbar: true,
            focusable: false,
            shadow: false,
            resizable: false,
            click_through: false,
            draggable: false,
            drag_region: String::new(),
            // A desktop widget should stay visible when the user switches Spaces (macOS).
            all_workspaces: true,
            zoom: 1.0,
            display: None,
            center: false,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Config {
    schema: u32,
    url: String,
    /// Local HTML entry point; served over a loopback origin (mutually exclusive with `url`).
    html: String,
    /// Static root for `html` (default: the HTML file's directory).
    root: String,
    allow_remote: bool,
    window: WindowCfg,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            schema: 1,
            url: String::new(),
            html: String::new(),
            root: String::new(),
            allow_remote: false,
            window: WindowCfg::default(),
        }
    }
}

fn die(msg: &str) -> ! {
    eprintln!("aiti-desktop-widget: {msg}");
    std::process::exit(2);
}

fn emit(value: Value) {
    let line = serde_json::to_string(&value).unwrap_or_else(|_| "{}".to_string());
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}

fn parse_bool(s: &str) -> Option<bool> {
    match s.to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

fn need_f64(key: &str, value: &str) -> f64 {
    value
        .parse()
        .unwrap_or_else(|_| die(&format!("--{key} expects a number, got {value:?}")))
}

fn need_bool(key: &str, value: &str) -> bool {
    parse_bool(value).unwrap_or_else(|| die(&format!("--{key} expects true/false, got {value:?}")))
}

fn is_local_host(url: &Url) -> bool {
    matches!(
        url.host_str(),
        Some("localhost") | Some("127.0.0.1") | Some("::1")
    )
}

fn allowed_url(raw: &str, allow_remote: bool) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|e| format!("invalid url {raw:?}: {e}"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(format!("url must use http(s): {raw}"));
    }
    if !allow_remote && !is_local_host(&url) {
        return Err(format!(
            "url host is not localhost ({raw}); pass --allow-remote true to allow it"
        ));
    }
    Ok(url)
}

fn merge(base: &mut Value, patch: Value) {
    match (base, patch) {
        (Value::Object(base), Value::Object(patch)) => {
            for (key, value) in patch {
                match base.get_mut(&key) {
                    Some(slot) => merge(slot, value),
                    None => {
                        base.insert(key, value);
                    }
                }
            }
        }
        (base, patch) => *base = patch,
    }
}

fn apply_cli(cfg: &mut Config, key: &str, value: &str) {
    let win = &mut cfg.window;
    match key {
        "url" => cfg.url = value.to_string(),
        "html" => cfg.html = value.to_string(),
        "root" => cfg.root = value.to_string(),
        "title" => win.title = value.to_string(),
        "width" => win.width = need_f64(key, value),
        "height" => win.height = need_f64(key, value),
        "x" => win.x = Some(need_f64(key, value)),
        "y" => win.y = Some(need_f64(key, value)),
        "zoom" => win.zoom = need_f64(key, value),
        "display" => win.display = Some(value.to_string()),
        "center" => win.center = need_bool(key, value),
        "decorations" => win.decorations = need_bool(key, value),
        "transparent" => win.transparent = need_bool(key, value),
        "always-on-top" => win.always_on_top = need_bool(key, value),
        "skip-taskbar" => win.skip_taskbar = need_bool(key, value),
        "focusable" => win.focusable = need_bool(key, value),
        "shadow" => win.shadow = need_bool(key, value),
        "resizable" => win.resizable = need_bool(key, value),
        "click-through" => win.click_through = need_bool(key, value),
        "draggable" => win.draggable = need_bool(key, value),
        "drag-region" => win.drag_region = value.to_string(),
        "all-workspaces" => win.all_workspaces = need_bool(key, value),
        "allow-remote" => cfg.allow_remote = need_bool(key, value),
        other => die(&format!("unknown option --{other}")),
    }
}

fn main() {
    let raw: Vec<String> = std::env::args().skip(1).collect();
    if raw.iter().any(|a| a == "--help" || a == "-h") {
        print_help();
        return;
    }
    if raw.iter().any(|a| a == "--version" || a == "-V") {
        println!("aiti-desktop-widget {}", env!("CARGO_PKG_VERSION"));
        return;
    }

    let mut config_file: Option<String> = None;
    let mut config_json: Option<String> = None;
    let mut positional_url: Option<String> = None;
    let mut cli: Vec<(String, String)> = Vec::new();
    let mut cli_url = false;
    let mut cli_html = false;

    let mut i = 0;
    while i < raw.len() {
        let arg = &raw[i];
        if !arg.starts_with("--") {
            if arg.starts_with('-') {
                die(&format!("unknown option {arg:?} (try --help)"));
            }
            if positional_url.is_some() {
                die(&format!("unexpected argument {arg:?} (url already given)"));
            }
            positional_url = Some(arg.clone());
            i += 1;
            continue;
        }
        let body = &arg[2..];
        let (key, value) = match body.split_once('=') {
            Some((key, value)) => (key.to_string(), Some(value.to_string())),
            None => {
                let key = body.to_string();
                let value = match raw.get(i + 1) {
                    Some(next) if !next.starts_with("--") => {
                        let value = next.clone();
                        i += 1;
                        Some(value)
                    }
                    _ => None,
                };
                (key, value)
            }
        };
        match key.as_str() {
            "config" => {
                config_file = Some(value.unwrap_or_else(|| die("--config requires a path")))
            }
            "config-json" => {
                config_json = Some(value.unwrap_or_else(|| die("--config-json requires JSON")))
            }
            "html" | "root" | "display" => {
                // These need a real value; a bare `--html` must not become "true".
                let value = value.unwrap_or_else(|| die(&format!("--{key} requires a value")));
                if key == "html" {
                    cli_html = true;
                }
                cli.push((key, value));
            }
            _ => {
                if key == "url" {
                    cli_url = true;
                }
                cli.push((key, value.unwrap_or_else(|| "true".to_string())));
            }
        }
        i += 1;
    }

    let mut merged = Value::Object(Default::default());
    if let Some(path) = &config_file {
        let text = std::fs::read_to_string(path)
            .unwrap_or_else(|e| die(&format!("cannot read config {path:?}: {e}")));
        let value: Value = serde_json::from_str(&text)
            .unwrap_or_else(|e| die(&format!("invalid config JSON {path:?}: {e}")));
        merge(&mut merged, value);
    }
    if let Some(text) = &config_json {
        let value: Value = serde_json::from_str(text)
            .unwrap_or_else(|e| die(&format!("invalid --config-json: {e}")));
        merge(&mut merged, value);
    }

    let mut cfg: Config =
        serde_json::from_value(merged).unwrap_or_else(|e| die(&format!("invalid config: {e}")));
    for (key, value) in &cli {
        apply_cli(&mut cfg, key, value);
    }
    if let Some(url) = positional_url {
        if cli.iter().any(|(key, _)| key == "url") {
            die("url given twice (positional and --url)");
        }
        // Positional url is CLI-level: it overrides config.url.
        cfg.url = url;
        cli_url = true;
    }
    // CLI beats config on the url/html choice too: an explicit side clears the other.
    if cli_html && !cli_url {
        cfg.url.clear();
    }
    if cli_url && !cli_html {
        cfg.html.clear();
    }

    if cfg.schema > 1 {
        eprintln!(
            "aiti-desktop-widget: config schema {} is newer than supported (1); unknown fields ignored",
            cfg.schema
        );
    }
    let has_url = !cfg.url.trim().is_empty();
    let has_html = !cfg.html.trim().is_empty();
    if has_url && has_html {
        die("--url and --html are mutually exclusive");
    }
    if !has_url && !has_html {
        die("--url or --html is required");
    }
    if has_html {
        let root = cfg.root.trim();
        let raw = cfg.html.trim();
        // `--html <file>[?query]`: keep the query string on the generated loopback URL.
        let (path, suffix) = if let Some((path, query)) = raw.split_once('?') {
            (path, format!("?{query}"))
        } else if let Some((path, fragment)) = raw.split_once('#') {
            (path, format!("#{fragment}"))
        } else {
            (raw, String::new())
        };
        match local_server::start_page(path, Some(root).filter(|r| !r.is_empty())) {
            Ok(page) => {
                let mut url = page.url;
                url.push_str(&suffix);
                eprintln!(
                    "aiti-desktop-widget: --html served from {} at {}",
                    page.root.display(),
                    url
                );
                cfg.url = url;
            }
            Err(e) => die(&e),
        }
    }
    cfg.window.display = cfg
        .window
        .display
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    if let Err(e) = allowed_url(cfg.url.trim(), cfg.allow_remote) {
        die(&e);
    }
    if cfg.window.width <= 0.0 || cfg.window.height <= 0.0 {
        die("width/height must be > 0");
    }
    if !(0.1..=5.0).contains(&cfg.window.zoom) {
        die("zoom must be in 0.1..=5.0");
    }
    if cfg.window.click_through && cfg.window.draggable {
        die("--click-through and --draggable are mutually exclusive (a click-through window cannot receive drag events)");
    }

    run(cfg);
}

fn print_help() {
    println!(
        "aiti-desktop-widget {} — frameless desktop widget shell",
        env!("CARGO_PKG_VERSION")
    );
    println!();
    println!("Usage: aiti-desktop-widget <url> [options]");
    println!("       aiti-desktop-widget --url <url> [options]");
    println!("       aiti-desktop-widget --html <file> [--root <dir>] [options]");
    println!("       aiti-desktop-widget --config <path> [options]");
    println!();
    println!("Core options:");
    println!(
        "  --url <url>              page to load (http/https; or pass as the first positional arg)"
    );
    println!(
        "  --html <file>            local HTML page, served over a loopback origin (no --url)"
    );
    println!(
        "  --root <dir>             static root for --html (default: the HTML file's directory)"
    );
    println!("  --width <px>             window width (default 800)");
    println!("  --height <px>            window height (default 120)");
    println!("  --x <px> --y <px>        initial position (relative to --display when set)");
    println!("  --display <index|name>   monitor to place the window on; missing x/y are centered");
    println!("  --center <bool>          center on the selected/primary monitor (default false)");
    println!("  --title <text>           window title (default aiti-desktop-widget)");
    println!("  --click-through <bool>   pass mouse events through (default false)");
    println!(
        "  --draggable <bool>       enable drag (default false; exclusive with click-through)"
    );
    println!("  --drag-region <css>      elements used as drag handles (default: 16px top strip)");
    println!("  --all-workspaces <bool>  show on every Space (macOS; default true)");
    println!("  --always-on-top <bool>   default true");
    println!("  --decorations <bool>     default false");
    println!("  --transparent <bool>     default true");
    println!("  --skip-taskbar <bool>    default true");
    println!("  --focusable <bool>       default false");
    println!("  --shadow <bool>          default false");
    println!("  --resizable <bool>       default false (size locked via min=max constraints)");
    println!("  --zoom <factor>          page zoom 0.1..5.0 (default 1.0; macOS 11+)");
    println!("  --allow-remote <bool>    allow non-localhost URLs (default false)");
    println!("  --config <path>          runtime JSON config");
    println!("  --config-json <json>     inline runtime JSON config");
    println!("  -h, --help               show this help");
    println!("  -V, --version            show version");
    println!();
    println!("Precedence: CLI > --config / --config-json > defaults.");
    println!("stdin JSONL: {{\"cmd\":\"move\",\"x\":..,\"y\":..}} / move+display / center / resize / navigate / set / displays / close");
    println!("stdout JSONL: ready (url, display, monitors) / displays / moved / resized / closed");
}

fn run(cfg: Config) {
    let init_script = if cfg.window.draggable {
        Some(drag_script(&cfg.window.drag_region))
    } else {
        None
    };
    let allow_remote = cfg.allow_remote;
    let initial_url = cfg.url.clone();

    tauri::Builder::default()
        .setup(move |app| {
            let win = &cfg.window;
            let displays = displays_from_app(app.handle());
            let selected = if win.display.is_some() || win.center {
                match display::select_display(&displays, win.display.as_deref()) {
                    Ok(index) => Some(index),
                    Err(e) => {
                        eprintln!("aiti-desktop-widget: {e}");
                        std::process::exit(2);
                    }
                }
            } else {
                None
            };
            let placement = selected.map(|index| {
                let target = &displays[index];
                let offset = display::logical_offset(
                    target, win.width, win.height, win.x, win.y, win.center,
                );
                display::physical_position(target, offset)
            });
            let url = Url::parse(cfg.url.trim()).expect("validated url");
            let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title(&win.title)
                .inner_size(win.width, win.height)
                .decorations(win.decorations)
                .transparent(win.transparent)
                .always_on_top(win.always_on_top)
                .skip_taskbar(win.skip_taskbar)
                .visible_on_all_workspaces(win.all_workspaces)
                .focusable(win.focusable)
                .focused(false)
                .shadow(win.shadow)
                .resizable(true)
                .visible(false);
            if placement.is_none() {
                if let (Some(x), Some(y)) = (win.x, win.y) {
                    builder = builder.position(x, y);
                }
            }
            if let Some(script) = &init_script {
                builder = builder.initialization_script(script.clone());
            }
            let window = builder.build()?;
            // Position before show() so a placement on a secondary monitor never flashes
            // at the default location. Physical coordinates avoid mixed-DPI scaling errors
            // in the window manager's logical space.
            if let Some((x, y)) = placement {
                let _ = window.set_position(PhysicalPosition::new(x, y));
            }
            if (win.zoom - 1.0).abs() > f64::EPSILON {
                let _ = window.set_zoom(win.zoom);
            }
            window.show()?;
            #[cfg(target_os = "macos")]
            {
                // macOS assigns new windows to the Space that is current when the app is
                // launched; a HUD should follow the user across Spaces.
                let _ = window.set_visible_on_all_workspaces(win.all_workspaces);
            }
            // GTK ignores inner_size for non-resizable windows (it falls back to the
            // webview's natural size), so keep the window resizable and lock the size
            // through min=max constraints instead.
            if !win.resizable {
                let _ = window.set_size_constraints(WindowSizeConstraints {
                    min_width: Some(PixelUnit::Logical(LogicalUnit::new(win.width))),
                    min_height: Some(PixelUnit::Logical(LogicalUnit::new(win.height))),
                    max_width: Some(PixelUnit::Logical(LogicalUnit::new(win.width))),
                    max_height: Some(PixelUnit::Logical(LogicalUnit::new(win.height))),
                });
            }
            // Cursor-ignore must run after the GTK window is realized: tao's
            // CursorIgnoreEvents handler unwraps the GtkWindow, which is None before show().
            if win.click_through {
                let _ = window.set_ignore_cursor_events(true);
            }
            emit(json!({
                "t": "ready",
                "label": "main",
                "url": initial_url,
                "display": selected,
                "monitors": monitors_json(&displays),
            }));
            watch_events(window.clone());
            start_stdin(window, allow_remote, !win.resizable, win.width, win.height);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running aiti-desktop-widget");
}

fn displays_from_app(app: &AppHandle) -> Vec<display::DisplayInfo> {
    let primary = app.primary_monitor().ok().flatten();
    let available = app.available_monitors().unwrap_or_default();
    collect_displays(&available, primary.as_ref())
}

fn displays_from_window(window: &WebviewWindow) -> Vec<display::DisplayInfo> {
    let primary = window.primary_monitor().ok().flatten();
    let available = window.available_monitors().unwrap_or_default();
    collect_displays(&available, primary.as_ref())
}

fn collect_displays(
    available: &[tauri::Monitor],
    primary: Option<&tauri::Monitor>,
) -> Vec<display::DisplayInfo> {
    let primary_key = primary.map(display_key);
    let displays: Vec<display::DisplayInfo> = available
        .iter()
        .enumerate()
        .map(|(index, monitor)| {
            display_info(index, monitor, primary_key == Some(display_key(monitor)))
        })
        .collect();
    let primary_info = primary.map(|monitor| display_info(0, monitor, true));
    display::ensure_primary(displays, primary_info)
}

fn display_key(
    monitor: &tauri::Monitor,
) -> (tauri::PhysicalPosition<i32>, tauri::PhysicalSize<u32>) {
    (*monitor.position(), *monitor.size())
}

fn display_info(index: usize, monitor: &tauri::Monitor, primary: bool) -> display::DisplayInfo {
    display::DisplayInfo {
        index,
        name: monitor.name().cloned(),
        physical_x: monitor.position().x,
        physical_y: monitor.position().y,
        physical_width: monitor.size().width,
        physical_height: monitor.size().height,
        scale: monitor.scale_factor(),
        primary,
    }
}

fn monitors_json(displays: &[display::DisplayInfo]) -> Value {
    Value::Array(
        displays
            .iter()
            .map(|d| {
                json!({
                    "index": d.index,
                    "name": d.name,
                    "primary": d.primary,
                    "x": d.logical_x(),
                    "y": d.logical_y(),
                    "width": d.logical_width(),
                    "height": d.logical_height(),
                    "scale": d.scale,
                    "physical": {
                        "x": d.physical_x,
                        "y": d.physical_y,
                        "width": d.physical_width,
                        "height": d.physical_height,
                    }
                })
            })
            .collect(),
    )
}

/// Index of the monitor that currently contains the window's center.
fn current_display(window: &WebviewWindow, displays: &[display::DisplayInfo]) -> Option<usize> {
    let position = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    let scale = window.scale_factor().unwrap_or(1.0).max(0.001);
    let cx = f64::from(position.x + size.width as i32 / 2) / scale;
    let cy = f64::from(position.y + size.height as i32 / 2) / scale;
    display::display_at(displays, cx, cy)
}

fn watch_events(window: WebviewWindow) {
    let handle = window.clone();
    window.on_window_event(move |event| match event {
        tauri::WindowEvent::Moved(pos) => {
            let scale = handle.scale_factor().unwrap_or(1.0);
            emit(json!({
                "t": "moved",
                "x": f64::from(pos.x) / scale,
                "y": f64::from(pos.y) / scale,
            }));
        }
        tauri::WindowEvent::Resized(size) => {
            let scale = handle.scale_factor().unwrap_or(1.0);
            emit(json!({
                "t": "resized",
                "width": f64::from(size.width) / scale,
                "height": f64::from(size.height) / scale,
            }));
        }
        tauri::WindowEvent::CloseRequested { .. } => emit(json!({ "t": "closed" })),
        tauri::WindowEvent::Destroyed => emit(json!({ "t": "destroyed" })),
        _ => {}
    });
}

fn start_stdin(
    window: WebviewWindow,
    allow_remote: bool,
    size_locked: bool,
    width: f64,
    height: f64,
) {
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        for line in stdin.lock().lines() {
            let Ok(line) = line else { break };
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let value: Value = match serde_json::from_str(line) {
                Ok(value) => value,
                Err(e) => {
                    eprintln!("aiti-desktop-widget: stdin JSON error: {e}");
                    continue;
                }
            };
            match value.get("cmd").and_then(Value::as_str).unwrap_or("") {
                "navigate" => {
                    let Some(raw) = value.get("url").and_then(Value::as_str) else {
                        eprintln!("aiti-desktop-widget: navigate needs url");
                        continue;
                    };
                    match allowed_url(raw, allow_remote) {
                        Ok(url) => {
                            if let Err(e) = window.navigate(url) {
                                eprintln!("aiti-desktop-widget: navigate failed: {e}");
                            }
                        }
                        Err(e) => eprintln!("aiti-desktop-widget: {e}"),
                    }
                }
                "move" => {
                    let display = display_field(&value);
                    if display.is_some() {
                        if let Err(e) = place_on_display(
                            &window,
                            display.as_deref(),
                            num(&value, "x"),
                            num(&value, "y"),
                            false,
                            width,
                            height,
                        ) {
                            eprintln!("aiti-desktop-widget: move failed: {e}");
                        }
                    } else if let (Some(x), Some(y)) = (num(&value, "x"), num(&value, "y")) {
                        let _ = window.set_position(LogicalPosition::new(x, y));
                    } else {
                        eprintln!("aiti-desktop-widget: move needs x and y (or a display)");
                    }
                }
                "center" => {
                    let display = display_field(&value);
                    if let Err(e) = place_on_display(
                        &window,
                        display.as_deref(),
                        None,
                        None,
                        true,
                        width,
                        height,
                    ) {
                        eprintln!("aiti-desktop-widget: center failed: {e}");
                    }
                }
                "displays" => {
                    let displays = displays_from_window(&window);
                    emit(json!({
                        "t": "displays",
                        "display": current_display(&window, &displays),
                        "monitors": monitors_json(&displays),
                    }));
                }
                "resize" => {
                    if let (Some(width), Some(height)) =
                        (num(&value, "width"), num(&value, "height"))
                    {
                        // A locked (non user-resizable) window still accepts programmatic
                        // resize: move the min=max constraints first, then apply the size.
                        if size_locked {
                            let _ = window.set_size_constraints(WindowSizeConstraints {
                                min_width: Some(PixelUnit::Logical(LogicalUnit::new(width))),
                                min_height: Some(PixelUnit::Logical(LogicalUnit::new(height))),
                                max_width: Some(PixelUnit::Logical(LogicalUnit::new(width))),
                                max_height: Some(PixelUnit::Logical(LogicalUnit::new(height))),
                            });
                        }
                        let _ = window.set_size(LogicalSize::new(width, height));
                    } else {
                        eprintln!("aiti-desktop-widget: resize needs width and height");
                    }
                }
                "set" => {
                    if let Some(on) = value.get("alwaysOnTop").and_then(Value::as_bool) {
                        let _ = window.set_always_on_top(on);
                    }
                    if let Some(on) = value.get("clickThrough").and_then(Value::as_bool) {
                        let _ = window.set_ignore_cursor_events(on);
                    }
                    if let Some(on) = value.get("decorations").and_then(Value::as_bool) {
                        let _ = window.set_decorations(on);
                    }
                    if let Some(on) = value.get("allWorkspaces").and_then(Value::as_bool) {
                        let _ = window.set_visible_on_all_workspaces(on);
                    }
                    if let Some(zoom) = value.get("zoom").and_then(Value::as_f64) {
                        let _ = window.set_zoom(zoom);
                    }
                }
                "close" => {
                    let _ = window.close();
                    break;
                }
                other => eprintln!("aiti-desktop-widget: unknown stdin cmd {other:?}"),
            }
        }
    });
}

fn num(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(Value::as_f64)
}

fn display_field(value: &Value) -> Option<String> {
    match value.get("display") {
        Some(Value::String(s)) if !s.trim().is_empty() => Some(s.trim().to_string()),
        Some(Value::Number(n)) => Some(n.to_string()),
        _ => None,
    }
}

/// Place the window on a monitor. `spec` = index/name/`primary`; `None` uses the
/// monitor currently containing the window (falling back to the primary one).
fn place_on_display(
    window: &WebviewWindow,
    spec: Option<&str>,
    x: Option<f64>,
    y: Option<f64>,
    center: bool,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let displays = displays_from_window(window);
    let index = match spec {
        Some(spec) => display::select_display(&displays, Some(spec))?,
        None => current_display(window, &displays)
            .or_else(|| Some(display::primary_index(&displays)))
            .ok_or_else(|| "no monitors reported by the window system".to_string())?,
    };
    let target = &displays[index];
    let offset = display::logical_offset(target, width, height, x, y, center);
    let (px, py) = display::physical_position(target, offset);
    window
        .set_position(PhysicalPosition::new(px, py))
        .map_err(|e| e.to_string())
}

/// Inject a drag handle. Priority: page-provided `data-tauri-drag-region` > `--drag-region`
/// selector > a 16px transparent strip at the top of the window.
fn drag_script(selector: &str) -> String {
    let selector = serde_json::to_string(selector).unwrap_or_else(|_| "\"\"".to_string());
    r#"
(function () {
  var SEL = __SELECTOR__;
  function install() {
    if (SEL) {
      var nodes = document.querySelectorAll(SEL);
      for (var i = 0; i < nodes.length; i += 1) {
        nodes[i].setAttribute('data-tauri-drag-region', 'deep');
      }
      return;
    }
    var grip = document.createElement('div');
    grip.setAttribute('data-tauri-drag-region', 'deep');
    grip.style.cssText = 'position:fixed;left:0;right:0;top:0;height:16px;z-index:2147483647;cursor:grab';
    (document.body || document.documentElement).appendChild(grip);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install);
  } else {
    install();
  }
})();
"#
    .replace("__SELECTOR__", &selector)
}
