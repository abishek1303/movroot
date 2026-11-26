use super::{DeviceError, read};
use image::{DynamicImage, ImageDecoder, ImageEncoder, ImageFormat, ImageReader, Limits};
use serde::{Deserialize, Serialize};
use std::{
    io::{self, Cursor, Write},
    sync::atomic::AtomicBool,
    time::Instant,
};

const TEXT_LIMIT: usize = 16 * 1024;
pub const ORIGINAL_IMAGE_LIMIT: usize = 2 * 1024 * 1024;
pub const PDF_LIMIT: usize = 256 * 1024;
const PDF_XREF_ENTRIES: usize = 64;
const IMAGE_LIMIT: usize = 2 * 1024 * 1024;
const DECODE_LIMIT: u64 = 64 * 1024 * 1024;

pub enum Content {
    Text(String),
    Image { mime: &'static str, bytes: Vec<u8> },
    Original(Vec<u8>),
}

#[derive(Clone, Copy, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Coverage {
    Original {
        source_bytes: usize,
        dimensions: Option<[u32; 2]>,
    },
    Text {
        source_bytes: usize,
        covered_bytes: usize,
        transmitted_bytes: usize,
        bom_removed: bool,
        line_endings_normalized: bool,
    },
    Image {
        original: [u32; 2],
        transmitted: [u32; 2],
        resized: bool,
        orientation_applied: bool,
        source_bytes: usize,
        transmitted_bytes: usize,
    },
}

pub struct Prepared {
    pub format: &'static str,
    pub content: Content,
    pub coverage: Coverage,
}

#[derive(Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ImageMode {
    #[default]
    Prepared,
    Original,
}

pub fn prepare(
    bytes: Vec<u8>,
    suffix: &str,
    image_mode: ImageMode,
    cancel: &AtomicBool,
    start: Instant,
) -> Result<Prepared, DeviceError> {
    read::check(cancel, start)?;
    if bytes.starts_with(b"%PDF-") {
        admit_pdf(&bytes)?;
        read::check(cancel, start)?;
        return Ok(original(bytes, "pdf", None));
    }
    match image::guess_format(&bytes) {
        Ok(format @ (ImageFormat::Png | ImageFormat::Jpeg)) => {
            if image_mode == ImageMode::Prepared {
                return prepare_image(&bytes, format, cancel, start);
            }
            if bytes.len() > ORIGINAL_IMAGE_LIMIT {
                return Err(DeviceError::LimitExceeded);
            }
            let terminator: &[u8] = match format {
                ImageFormat::Png => b"\x00\x00\x00\x00IEND\xaeB`\x82",
                _ => b"\xff\xd9",
            };
            if !bytes.ends_with(terminator) {
                return Err(DeviceError::DecodeFailed);
            }
            let dimensions = {
                let decoder = image_decoder(&bytes, format)?;
                let (width, height) = decoder.dimensions();
                [width, height]
            };
            read::check(cancel, start)?;
            return Ok(original(
                bytes,
                if format == ImageFormat::Png {
                    "png"
                } else {
                    "jpeg"
                },
                Some(dimensions),
            ));
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
        _ => "text",
    };
    let source = std::str::from_utf8(&bytes).map_err(|_| DeviceError::DecodeFailed)?;
    let text = source.strip_prefix('\u{feff}').unwrap_or(source);
    if text.trim().is_empty()
        || text
            .chars()
            .any(|ch| ch.is_control() && !matches!(ch, '\t' | '\n' | '\r'))
    {
        return Err(DeviceError::DecodeFailed);
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
            bom_removed: source.len() != text.len(),
            line_endings_normalized: source[..covered].contains('\r'),
        },
        content: Content::Text(normalized),
    })
}

fn original(bytes: Vec<u8>, format: &'static str, dimensions: Option<[u32; 2]>) -> Prepared {
    Prepared {
        format,
        coverage: Coverage::Original {
            source_bytes: bytes.len(),
            dimensions,
        },
        content: Content::Original(bytes),
    }
}

// Admit a narrow class of small, single-revision PDFs. The checks describe the
// envelope, not the page tree or validity of the objects inside it.
fn admit_pdf(bytes: &[u8]) -> Result<(), DeviceError> {
    if bytes.len() > PDF_LIMIT {
        return Err(DeviceError::LimitExceeded);
    }
    let Some(version) = bytes.get(5..8) else {
        return Err(DeviceError::DecodeFailed);
    };
    if !matches!(version, [b'1', b'.', b'0'..=b'7'] | [b'2', b'.', b'0'])
        || !matches!(bytes.get(8), Some(b'\r' | b'\n'))
    {
        return Err(DeviceError::DecodeFailed);
    }
    let end = bytes.trim_ascii_end();
    let body = end
        .strip_suffix(b"%%EOF")
        .ok_or(DeviceError::DecodeFailed)?;
    let start = body
        .windows(9)
        .rposition(|window| window == b"startxref")
        .ok_or(DeviceError::DecodeFailed)?;
    let offset = std::str::from_utf8(body[start + 9..].trim_ascii())
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .ok_or(DeviceError::DecodeFailed)?;
    let xref = body.get(offset..start).ok_or(DeviceError::DecodeFailed)?;
    if !xref.starts_with(b"xref\n") && !xref.starts_with(b"xref\r") {
        // Modern xref streams are outside the intentionally narrow initial policy.
        return Err(DeviceError::UnsupportedResource);
    }
    let trailer = xref
        .windows(7)
        .rposition(|window| window == b"trailer")
        .ok_or(DeviceError::DecodeFailed)?;
    let mut entries = xref[4..trailer]
        .split(|byte| byte.is_ascii_whitespace())
        .filter(|part| !part.is_empty());
    if entries.next() != Some(b"0") {
        return Err(DeviceError::UnsupportedResource);
    }
    let count = entries
        .next()
        .and_then(|value| std::str::from_utf8(value).ok())
        .and_then(|value| value.parse::<usize>().ok())
        .ok_or(DeviceError::DecodeFailed)?;
    if count == 0 || count > PDF_XREF_ENTRIES {
        return Err(DeviceError::LimitExceeded);
    }
    for _ in 0..count {
        if !entries
            .next()
            .is_some_and(|offset| offset.len() == 10 && offset.iter().all(u8::is_ascii_digit))
            || !entries.next().is_some_and(|generation| {
                generation.len() == 5 && generation.iter().all(u8::is_ascii_digit)
            })
            || !matches!(entries.next(), Some(b"n" | b"f"))
        {
            return Err(DeviceError::DecodeFailed);
        }
    }
    if entries.next().is_some() {
        return Err(DeviceError::UnsupportedResource);
    }
    let dictionary = xref[trailer + 7..].trim_ascii();
    if !dictionary.starts_with(b"<<") || !dictionary.ends_with(b">>") {
        return Err(DeviceError::DecodeFailed);
    }
    // Escaped names and incremental/hybrid dictionaries are outside this
    // profile so the encryption decision cannot depend on interpreting them.
    for (index, byte) in bytes.iter().enumerate() {
        if *byte != b'/' {
            continue;
        }
        let name = bytes[index + 1..]
            .split(|byte| byte.is_ascii_whitespace() || b"()<>[]{}/%".contains(byte))
            .next()
            .unwrap_or_default();
        match name {
            b"Encrypt" => return Err(DeviceError::PdfEncrypted),
            b"Prev" | b"XRefStm" | b"ObjStm" => return Err(DeviceError::UnsupportedResource),
            _ if name.contains(&b'#') => return Err(DeviceError::UnsupportedResource),
            _ => {}
        }
    }
    let root = dictionary.windows(5).any(|window| window == b"/Root");
    if !root {
        return Err(DeviceError::DecodeFailed);
    }
    Ok(())
}

fn image_decoder(input: &[u8], format: ImageFormat) -> Result<impl ImageDecoder + '_, DeviceError> {
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
    let decoder = reader.into_decoder().map_err(decode_error)?;
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
    Ok(decoder)
}

fn prepare_image(
    input: &[u8],
    format: ImageFormat,
    cancel: &AtomicBool,
    start: Instant,
) -> Result<Prepared, DeviceError> {
    let mut decoder = image_decoder(input, format)?;
    let (w, h) = decoder.dimensions();
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
                    orientation_applied: orientation != image::metadata::Orientation::NoTransforms,
                    source_bytes: input.len(),
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
    fn prepare_sample(
        bytes: &[u8],
        suffix: &str,
        mode: ImageMode,
    ) -> Result<Prepared, DeviceError> {
        prepare(
            bytes.to_vec(),
            suffix,
            mode,
            &AtomicBool::new(false),
            Instant::now(),
        )
    }

    #[test]
    fn sends_original_binary_fixtures_without_metadata_hints() {
        use base64::{Engine, engine::general_purpose::STANDARD};
        for (format, bytes) in [
            (
                "png",
                include_bytes!("../../../fixtures/ingestion-experiment/receipt.png").as_slice(),
            ),
            (
                "jpeg",
                include_bytes!("../../../fixtures/ingestion-experiment/apple.jpg").as_slice(),
            ),
            (
                "pdf",
                include_bytes!("../../../fixtures/ingestion-experiment/calibration.pdf").as_slice(),
            ),
        ] {
            let mode = if format == "pdf" {
                ImageMode::Prepared
            } else {
                ImageMode::Original
            };
            let prepared = prepare_sample(bytes, "unknown", mode).unwrap();
            assert_eq!(prepared.format, format);
            assert!(matches!(&prepared.content, Content::Original(original) if original == bytes));
            assert!(
                matches!(prepared.coverage, Coverage::Original { source_bytes, dimensions } if source_bytes == bytes.len() && dimensions.is_none() == (format == "pdf"))
            );
            let body = crate::inference::file::request(&prepared).unwrap();
            let wire: serde_json::Value = serde_json::from_str(&body).unwrap();
            let part = &wire["input"][0]["content"][1];
            assert_eq!(part["type"], "input_file");
            assert_eq!(part.as_object().unwrap().len(), 2);
            assert_eq!(
                STANDARD
                    .decode(part["file_data"].as_str().unwrap())
                    .unwrap(),
                bytes
            );
            assert_eq!(
                wire["input"][0]["content"][0]["text"],
                "Analyze the supplied content."
            );
            assert_eq!(wire["reasoning"]["effort"], "minimal");
            assert_eq!(wire["max_output_tokens"], 1024);
            assert_eq!(wire["text"]["format"]["strict"], true);
            assert_eq!(wire["store"], false);
        }
    }

    #[test]
    fn pdf_admission_is_small_unencrypted_classic_xref_only() {
        let sample = include_bytes!("../../../fixtures/ingestion-experiment/calibration.pdf");
        let insert = |name: &str| {
            String::from_utf8(sample.to_vec())
                .unwrap()
                .replace("/Root 1 0 R", &format!("/Root 1 0 R {name}"))
        };
        assert_eq!(admit_pdf(sample), Ok(()));
        let excessive_entries = String::from_utf8(sample.to_vec())
            .unwrap()
            .replace("xref\n0 6", "xref\n0 65");
        assert_eq!(
            admit_pdf(excessive_entries.as_bytes()),
            Err(DeviceError::LimitExceeded)
        );
        assert_eq!(
            admit_pdf(insert("/Encrypt 7 0 R").as_bytes()),
            Err(DeviceError::PdfEncrypted)
        );
        assert_eq!(
            admit_pdf(insert("/Encr#79pt 7 0 R").as_bytes()),
            Err(DeviceError::UnsupportedResource)
        );
        assert_eq!(
            admit_pdf(insert("/Prev 123").as_bytes()),
            Err(DeviceError::UnsupportedResource)
        );
        assert_eq!(
            admit_pdf(insert("/XRefStm 123").as_bytes()),
            Err(DeviceError::UnsupportedResource)
        );
        assert_eq!(
            admit_pdf(&sample[..sample.len() - 10]),
            Err(DeviceError::DecodeFailed)
        );
        let mut large = sample.to_vec();
        large.resize(PDF_LIMIT + 1, b' ');
        assert_eq!(admit_pdf(&large), Err(DeviceError::LimitExceeded));
    }

    #[test]
    fn defaults_to_stripping_jpeg_metadata_and_uses_content_for_admission() {
        let sample = include_bytes!("../../../fixtures/ingestion-experiment/apple.jpg");
        let marker = b"private-comment-fixture";
        let mut bytes = sample[..2].to_vec();
        bytes.extend_from_slice(&[0xff, 0xfe]);
        bytes.extend_from_slice(&((marker.len() + 2) as u16).to_be_bytes());
        bytes.extend_from_slice(marker);
        bytes.extend_from_slice(&sample[2..]);
        let prepared = prepare_sample(&bytes, "", ImageMode::default()).unwrap();
        assert!(
            matches!(prepared.content, Content::Image { bytes, .. } if !bytes.windows(marker.len()).any(|part| part == marker))
        );
        let original = prepare_sample(&bytes, "txt", ImageMode::Original).unwrap();
        assert!(matches!(original.content, Content::Original(original) if original == bytes));
        assert!(matches!(
            prepare_sample(&bytes[..bytes.len() - 2], "jpg", ImageMode::Original),
            Err(DeviceError::DecodeFailed)
        ));
        let text = prepare_sample(b"extensionless text", "", ImageMode::Prepared).unwrap();
        assert!(matches!(text.content, Content::Text(text) if text == "extensionless text"));
        assert!(matches!(
            prepare_sample(b"MZ executable", "txt", ImageMode::Original),
            Err(DeviceError::UnsupportedResource)
        ));
    }

    #[test]
    fn preparation_reports_original_coverage_and_rejects_malformed_formats() {
        let flag = AtomicBool::new(false);
        let mut source = "\u{feff}".to_owned() + &"a".repeat(TEXT_LIMIT - 2) + "\r\néx";
        let prepared = prepare(
            source.as_bytes().to_vec(),
            "txt",
            ImageMode::Prepared,
            &flag,
            Instant::now(),
        )
        .unwrap();
        assert!(
            matches!(prepared.coverage, Coverage::Text { source_bytes, covered_bytes, transmitted_bytes, bom_removed: true, line_endings_normalized: true } if source_bytes == source.len() && covered_bytes == source.len() - 3 && transmitted_bytes == TEXT_LIMIT - 1)
        );
        source.clear();
        assert!(matches!(
            prepare(b"{broken".to_vec(), "json", ImageMode::Prepared, &flag, Instant::now()).unwrap().content,
            Content::Text(text) if text == "{broken"
        ));
        assert!(matches!(
            prepare(
                b"%PDF-1.7".to_vec(),
                "txt",
                ImageMode::Prepared,
                &flag,
                Instant::now()
            ),
            Err(DeviceError::DecodeFailed)
        ));
        assert!(matches!(
            prepare(
                b"a\x00".to_vec(),
                "txt",
                ImageMode::Prepared,
                &flag,
                Instant::now()
            ),
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
            input.into_inner(),
            "txt",
            ImageMode::Prepared,
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
