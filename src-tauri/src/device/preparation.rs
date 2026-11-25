use super::{DeviceError, read};
use image::{DynamicImage, ImageDecoder, ImageEncoder, ImageFormat, ImageReader, Limits};
use serde::Serialize;
use std::{
    io::{self, Cursor, Write},
    sync::atomic::AtomicBool,
    time::Instant,
};

const TEXT_LIMIT: usize = 16 * 1024;
const IMAGE_LIMIT: usize = 2 * 1024 * 1024;
const DECODE_LIMIT: u64 = 64 * 1024 * 1024;

pub enum Content {
    Text(String),
    Image { mime: &'static str, bytes: Vec<u8> },
}

#[derive(Clone, Copy, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Coverage {
    Text {
        source_bytes: usize,
        covered_bytes: usize,
        transmitted_bytes: usize,
    },
    Image {
        original: [u32; 2],
        transmitted: [u32; 2],
        resized: bool,
        transmitted_bytes: usize,
    },
}

pub struct Prepared {
    pub format: &'static str,
    pub content: Content,
    pub coverage: Coverage,
}

pub fn prepare(
    bytes: &[u8],
    suffix: &str,
    cancel: &AtomicBool,
    start: Instant,
) -> Result<Prepared, DeviceError> {
    read::check(cancel, start)?;
    if bytes.starts_with(b"%PDF-") {
        return Err(DeviceError::PdfDeferred);
    }
    match image::guess_format(bytes) {
        Ok(format @ (ImageFormat::Png | ImageFormat::Jpeg)) => {
            return prepare_image(bytes, format, cancel, start);
        }
        Ok(_) => return Err(DeviceError::UnsupportedResource),
        Err(_) => {}
    }
    if bytes.starts_with(b"#!")
        || bytes.starts_with(b"PK\x03\x04")
        || bytes.starts_with(b"\x7fELF")
        || bytes.starts_with(b"MZ")
    {
        return Err(DeviceError::UnsupportedResource);
    }
    let format = match suffix {
        "txt" => "text",
        "md" | "markdown" => "markdown",
        "json" => "json",
        "csv" => "csv",
        _ => return Err(DeviceError::UnsupportedResource),
    };
    let source = std::str::from_utf8(bytes).map_err(|_| DeviceError::DecodeFailed)?;
    let text = source.strip_prefix('\u{feff}').unwrap_or(source);
    if text.trim().is_empty()
        || text
            .chars()
            .any(|ch| ch.is_control() && !matches!(ch, '\t' | '\n' | '\r'))
    {
        return Err(DeviceError::DecodeFailed);
    }
    if format == "json" {
        if bytes.len() > 256 * 1024 {
            return Err(DeviceError::LimitExceeded);
        }
        serde_json::from_str::<serde_json::Value>(text).map_err(|_| DeviceError::DecodeFailed)?;
    }
    let mut normalized = String::new();
    let mut covered = source.len() - text.len();
    let mut chars = text.chars().peekable();
    let mut line_end = None;
    while let Some(ch) = chars.next() {
        if normalized.len() + ch.len_utf8() > TEXT_LIMIT {
            break;
        }
        covered += ch.len_utf8();
        if ch == '\r' {
            if chars.next_if_eq(&'\n').is_some() {
                covered += 1;
            }
            normalized.push('\n');
        } else {
            normalized.push(ch);
        }
        if matches!(ch, '\r' | '\n') && normalized.len() >= TEXT_LIMIT * 3 / 4 {
            line_end = Some((normalized.len(), covered));
        }
    }
    if covered < source.len()
        && let Some((length, source_end)) = line_end
    {
        normalized.truncate(length);
        covered = source_end;
    }
    read::check(cancel, start)?;
    Ok(Prepared {
        format,
        coverage: Coverage::Text {
            source_bytes: bytes.len(),
            covered_bytes: covered,
            transmitted_bytes: normalized.len(),
        },
        content: Content::Text(normalized),
    })
}

fn prepare_image(
    input: &[u8],
    format: ImageFormat,
    cancel: &AtomicBool,
    start: Instant,
) -> Result<Prepared, DeviceError> {
    let mut limits = Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(DECODE_LIMIT);
    if format == ImageFormat::Png {
        let decoder =
            image::codecs::png::PngDecoder::with_limits(Cursor::new(input), limits.clone())
                .map_err(decode_error)?;
        if decoder.is_apng().map_err(decode_error)? {
            return Err(DeviceError::UnsupportedResource);
        }
    }
    let mut reader = ImageReader::with_format(Cursor::new(input), format);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(decode_error)?;
    let (w, h) = decoder.dimensions();
    if w == 0
        || h == 0
        || w > 4096
        || h > 4096
        || u64::from(w) * u64::from(h) > 8_000_000
        || decoder.total_bytes() > DECODE_LIMIT
    {
        return Err(DeviceError::LimitExceeded);
    }
    let orientation = decoder.orientation().map_err(decode_error)?;
    read::check(cancel, start)?;
    let mut image = DynamicImage::from_decoder(decoder).map_err(decode_error)?;
    image.apply_orientation(orientation);
    let oriented = [image.width(), image.height()];
    for side in [2560, 2048, 1600] {
        read::check(cancel, start)?;
        if image.width().max(image.height()) > side {
            image = image.resize(side, side, image::imageops::FilterType::Triangle);
        }
        let dimensions = [image.width(), image.height()];
        let mut out = Capped(Vec::new());
        let (format, mime, result) = if format == ImageFormat::Png {
            let pixels = image.to_rgba8();
            (
                "png",
                "image/png",
                image::codecs::png::PngEncoder::new(&mut out).write_image(
                    pixels.as_raw(),
                    dimensions[0],
                    dimensions[1],
                    image::ExtendedColorType::Rgba8,
                ),
            )
        } else {
            (
                "jpeg",
                "image/jpeg",
                image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 85)
                    .encode_image(&image),
            )
        };
        read::check(cancel, start)?;
        if result.is_ok() {
            return Ok(Prepared {
                format,
                coverage: Coverage::Image {
                    original: [w, h],
                    transmitted: dimensions,
                    resized: dimensions != oriented,
                    transmitted_bytes: out.0.len(),
                },
                content: Content::Image { mime, bytes: out.0 },
            });
        }
    }
    Err(DeviceError::LimitExceeded)
}

fn decode_error(error: image::ImageError) -> DeviceError {
    match error {
        image::ImageError::Limits(_) => DeviceError::LimitExceeded,
        _ => DeviceError::DecodeFailed,
    }
}

struct Capped(Vec<u8>);
impl Write for Capped {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > IMAGE_LIMIT - self.0.len() {
            return Err(io::Error::other("analysis image limit"));
        }
        self.0
            .try_reserve_exact(bytes.len())
            .map_err(io::Error::other)?;
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preparation_reports_original_coverage_and_rejects_malformed_formats() {
        let flag = AtomicBool::new(false);
        let mut source = "\u{feff}".to_owned() + &"a".repeat(TEXT_LIMIT - 2) + "\r\néx";
        let prepared = prepare(source.as_bytes(), "txt", &flag, Instant::now()).unwrap();
        assert!(
            matches!(prepared.coverage, Coverage::Text { source_bytes, covered_bytes, transmitted_bytes } if source_bytes == source.len() && covered_bytes == source.len() - 3 && transmitted_bytes == TEXT_LIMIT - 1)
        );
        source.clear();
        assert!(matches!(
            prepare(b"{broken", "json", &flag, Instant::now()),
            Err(DeviceError::DecodeFailed)
        ));
        assert!(matches!(
            prepare(b"%PDF-1.7", "txt", &flag, Instant::now()),
            Err(DeviceError::PdfDeferred)
        ));
        assert!(matches!(
            prepare(b"a\x00", "txt", &flag, Instant::now()),
            Err(DeviceError::DecodeFailed)
        ));
    }

    #[test]
    fn screenshot_preparation_uses_a_separate_resolution() {
        let mut input = Cursor::new(Vec::new());
        DynamicImage::new_rgb8(3000, 900)
            .write_to(&mut input, ImageFormat::Png)
            .unwrap();
        let result = prepare(
            input.get_ref(),
            "txt",
            &AtomicBool::new(false),
            Instant::now(),
        )
        .unwrap();
        assert_eq!(result.format, "png");
        assert!(matches!(
            result.coverage,
            Coverage::Image {
                original: [3000, 900],
                transmitted: [2560, 768],
                resized: true,
                ..
            }
        ));
    }
}
