//! Monitor enumeration, selection and placement math.
//!
//! Kept free of Tauri types so the rules can be unit-tested without a display:
//! `main.rs` converts `tauri::Monitor` into [`DisplayInfo`].

/// One monitor in the window system's coordinate space.
///
/// `physical_*` are the raw pixel values reported by the platform; `scale` maps
/// logical pixels to physical pixels for that monitor. Logical values are derived
/// on demand (see [`DisplayInfo::logical_x`]).
#[derive(Debug, Clone, PartialEq)]
pub struct DisplayInfo {
    pub index: usize,
    pub name: Option<String>,
    pub physical_x: i32,
    pub physical_y: i32,
    pub physical_width: u32,
    pub physical_height: u32,
    pub scale: f64,
    pub primary: bool,
}

impl DisplayInfo {
    fn safe_scale(&self) -> f64 {
        if self.scale.is_finite() && self.scale > 0.0 {
            self.scale
        } else {
            1.0
        }
    }

    pub fn logical_x(&self) -> f64 {
        f64::from(self.physical_x) / self.safe_scale()
    }

    pub fn logical_y(&self) -> f64 {
        f64::from(self.physical_y) / self.safe_scale()
    }

    pub fn logical_width(&self) -> f64 {
        f64::from(self.physical_width) / self.safe_scale()
    }

    pub fn logical_height(&self) -> f64 {
        f64::from(self.physical_height) / self.safe_scale()
    }
}

/// Pick a monitor from a `--display` spec: `primary`, a 0-based index, or a name
/// (case-insensitive). `None` selects the primary monitor (first one as fallback).
pub fn select_display(displays: &[DisplayInfo], spec: Option<&str>) -> Result<usize, String> {
    if displays.is_empty() {
        return Err("no monitors reported by the window system".to_string());
    }
    let spec = spec.map(str::trim).filter(|s| !s.is_empty());
    let Some(spec) = spec else {
        return Ok(primary_index(displays));
    };
    if spec.eq_ignore_ascii_case("primary") {
        return Ok(primary_index(displays));
    }
    if let Ok(index) = spec.parse::<usize>() {
        if index < displays.len() {
            return Ok(index);
        }
        return Err(format!(
            "display index {index} out of range ({} monitor(s))",
            displays.len()
        ));
    }
    let lower = spec.to_ascii_lowercase();
    if let Some(found) = displays.iter().find(|d| {
        d.name
            .as_deref()
            .map(|name| name.to_ascii_lowercase() == lower)
            .unwrap_or(false)
    }) {
        return Ok(found.index);
    }
    let names: Vec<&str> = displays
        .iter()
        .map(|d| d.name.as_deref().unwrap_or("(unnamed)"))
        .collect();
    Err(format!(
        "display {spec:?} not found; available: {}",
        names.join(", ")
    ))
}

pub fn primary_index(displays: &[DisplayInfo]) -> usize {
    displays
        .iter()
        .position(|d| d.primary)
        .unwrap_or(0)
        .min(displays.len().saturating_sub(1))
}

/// Some backends (observed: tao 0.37 + macOS 11.7) report no monitors through
/// `available_monitors()` even though `primary_monitor()` is available. Fall back to
/// the primary monitor so `--display`/`--center` still work instead of dying.
pub fn ensure_primary(
    mut displays: Vec<DisplayInfo>,
    primary: Option<DisplayInfo>,
) -> Vec<DisplayInfo> {
    if displays.is_empty() {
        if let Some(mut monitor) = primary {
            monitor.index = 0;
            monitor.primary = true;
            displays.push(monitor);
        }
    }
    displays
}

/// Logical offset of a `width`x`height` window inside `display`.
///
/// A missing axis is centered on that axis (so `--display 1` alone centers the
/// window on that monitor). `center` forces both axes to the center and wins over
/// explicit `x`/`y`.
pub fn logical_offset(
    display: &DisplayInfo,
    width: f64,
    height: f64,
    x: Option<f64>,
    y: Option<f64>,
    center: bool,
) -> (f64, f64) {
    let centered_x = (display.logical_width() - width) / 2.0;
    let centered_y = (display.logical_height() - height) / 2.0;
    if center {
        return (centered_x, centered_y);
    }
    (x.unwrap_or(centered_x), y.unwrap_or(centered_y))
}

/// Convert a logical offset inside `display` into a physical screen position,
/// which is what the window manager expects on every platform.
pub fn physical_position(display: &DisplayInfo, offset: (f64, f64)) -> (i32, i32) {
    let scale = display.safe_scale();
    let dx = (offset.0 * scale).round();
    let dy = (offset.1 * scale).round();
    (
        display.physical_x + dx as i32,
        display.physical_y + dy as i32,
    )
}

/// Index of the monitor containing the logical point, if any.
pub fn display_at(displays: &[DisplayInfo], x: f64, y: f64) -> Option<usize> {
    displays
        .iter()
        .find(|d| {
            let (w, h) = (d.logical_width(), d.logical_height());
            x >= d.logical_x()
                && x < d.logical_x() + w
                && y >= d.logical_y()
                && y < d.logical_y() + h
        })
        .map(|d| d.index)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn display(
        index: usize,
        x: i32,
        y: i32,
        w: u32,
        h: u32,
        scale: f64,
        primary: bool,
    ) -> DisplayInfo {
        DisplayInfo {
            index,
            name: Some(format!("MON-{index}")),
            physical_x: x,
            physical_y: y,
            physical_width: w,
            physical_height: h,
            scale,
            primary,
        }
    }

    #[test]
    fn selects_primary_index_name_and_spec_errors() {
        let displays = vec![
            display(0, 0, 0, 1920, 1080, 1.0, true),
            display(1, 1920, 0, 2560, 1440, 1.0, false),
        ];
        assert_eq!(select_display(&displays, None).unwrap(), 0);
        assert_eq!(select_display(&displays, Some("primary")).unwrap(), 0);
        assert_eq!(select_display(&displays, Some("1")).unwrap(), 1);
        assert_eq!(select_display(&displays, Some("mon-1")).unwrap(), 1);
        assert!(select_display(&displays, Some("2")).is_err());
        assert!(select_display(&displays, Some("HDMI-A-0")).is_err());
        assert!(select_display(&[], Some("0")).is_err());
    }

    #[test]
    fn explicit_offsets_are_relative_to_the_display() {
        let second = display(1, 1920, 0, 1920, 1080, 1.0, false);
        let offset = logical_offset(&second, 900.0, 140.0, Some(190.0), Some(650.0), false);
        assert_eq!(offset, (190.0, 650.0));
        assert_eq!(physical_position(&second, offset), (2110, 650));
    }

    #[test]
    fn missing_axes_center_within_the_display() {
        let second = display(1, 1920, 0, 1920, 1080, 1.0, false);
        let offset = logical_offset(&second, 900.0, 140.0, Some(10.0), None, false);
        assert_eq!(offset.0, 10.0);
        assert_eq!(offset.1, 470.0);
        let centered = logical_offset(&second, 900.0, 140.0, Some(10.0), Some(20.0), true);
        assert_eq!(centered, (510.0, 470.0));
        assert_eq!(physical_position(&second, centered), (2430, 470));
    }

    #[test]
    fn scale_is_applied_to_offsets_and_origins() {
        let retina = display(1, 3840, 0, 3840, 2160, 2.0, false);
        assert_eq!(retina.logical_x(), 1920.0);
        assert_eq!(retina.logical_width(), 1920.0);
        let offset = logical_offset(&retina, 900.0, 140.0, Some(10.0), Some(20.0), false);
        assert_eq!(physical_position(&retina, offset), (3860, 40));
    }

    #[test]
    fn falls_back_to_the_primary_monitor_when_enumeration_is_empty() {
        let primary = display(7, 100, 50, 1440, 900, 2.0, false);
        let displays = ensure_primary(Vec::new(), Some(primary));
        assert_eq!(displays.len(), 1);
        assert_eq!(displays[0].index, 0);
        assert!(displays[0].primary);
        assert_eq!(select_display(&displays, Some("0")).unwrap(), 0);
        assert_eq!(select_display(&displays, Some("primary")).unwrap(), 0);
        // Existing enumeration is left untouched.
        let existing = vec![display(0, 0, 0, 1920, 1080, 1.0, true)];
        assert_eq!(
            ensure_primary(existing, Some(display(1, 0, 0, 1, 1, 1.0, false))).len(),
            1
        );
    }

    #[test]
    fn hit_testing_uses_logical_rectangles() {
        let displays = vec![
            display(0, 0, 0, 1920, 1080, 1.0, true),
            display(1, 1920, 0, 2560, 1440, 1.0, false),
        ];
        assert_eq!(display_at(&displays, 10.0, 10.0), Some(0));
        assert_eq!(display_at(&displays, 2000.0, 10.0), Some(1));
        assert_eq!(display_at(&displays, 5000.0, 10.0), None);
    }
}
