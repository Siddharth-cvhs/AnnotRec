//! Screen geometry and snapshots: which monitor a window rectangle lies on,
//! and a PNG of that rectangle. Pixel-exact, physical pixels throughout.

use xcap::{
    image::{
        codecs::png::{CompressionType, FilterType, PngEncoder},
        ExtendedColorType, ImageEncoder,
    },
    Monitor,
};

/// A rectangle on one monitor, in that monitor's physical pixels, relative
/// to its top-left corner. This is what gets recorded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Area {
    /// `xcap` monitor id (the HMONITOR's low 32 bits on Windows).
    pub monitor_id: u32,
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// A rectangle in virtual-desktop physical pixels.
#[derive(Debug, Clone, Copy)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// The area of `rect` on the monitor holding its centre, clipped to that
/// monitor. Errors when the rectangle is (almost) empty.
pub fn area_of(rect: Rect) -> Result<Area, String> {
    let cx = rect.x + (rect.width / 2) as i32;
    let cy = rect.y + (rect.height / 2) as i32;
    let monitors = Monitor::all().map_err(|e| format!("cannot list monitors: {e}"))?;
    for m in monitors {
        let (mx, my) = (m.x().map_err(s)?, m.y().map_err(s)?);
        let (mw, mh) = (m.width().map_err(s)? as i32, m.height().map_err(s)? as i32);
        if cx < mx || cy < my || cx >= mx + mw || cy >= my + mh {
            continue;
        }
        let x = (rect.x - mx).max(0);
        let y = (rect.y - my).max(0);
        let width = (rect.width as i32).min(mw - x);
        let height = (rect.height as i32).min(mh - y);
        if width < 2 || height < 2 {
            return Err("the viewport is too small to record".into());
        }
        return Ok(Area {
            monitor_id: m.id().map_err(s)?,
            x: x as u32,
            y: y as u32,
            width: width as u32,
            height: height as u32,
        });
    }
    Err("the viewport is not on any monitor".into())
}

fn s<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/// A PNG of `area` as it is on screen right now (every visible window,
/// the annotation overlay included; the cursor is not).
pub fn capture_png(area: &Area) -> Result<Vec<u8>, String> {
    let monitor = Monitor::all()
        .map_err(s)?
        .into_iter()
        .find(|m| m.id().ok() == Some(area.monitor_id))
        .ok_or("the monitor disappeared")?;
    let full = monitor.capture_image().map_err(|e| format!("cannot capture the screen: {e}"))?;
    let w = area.width.min(full.width().saturating_sub(area.x));
    let h = area.height.min(full.height().saturating_sub(area.y));
    if w == 0 || h == 0 {
        return Err("nothing to capture".into());
    }
    let cropped = xcap::image::imageops::crop_imm(&full, area.x, area.y, w, h).to_image();
    let mut out = Vec::new();
    PngEncoder::new_with_quality(&mut out, CompressionType::Fast, FilterType::Adaptive)
        .write_image(cropped.as_raw(), cropped.width(), cropped.height(), ExtendedColorType::Rgba8)
        .map_err(|e| format!("cannot encode the picture: {e}"))?;
    Ok(out)
}
