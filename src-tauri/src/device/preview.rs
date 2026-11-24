use super::{DeviceError, read};
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, Limits};
use std::{
    io::{self, Cursor, Write},
    sync::atomic::AtomicBool,
    time::Instant,
};

const MAX_AXIS: u32 = 4096;
const MAX_PIXELS: u64 = 8_000_000;
const MAX_DECODE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES: usize = 2 * 1024 * 1024;

pub(super) fn thumbnail(
    input: &[u8],
    cancel: &AtomicBool,
    started: Instant,
) -> Result<Vec<u8>, DeviceError> {
    read::check(cancel, started)?;
    let format = if input.starts_with(b"\x89PNG\r\n\x1a\n") {
        ImageFormat::Png
    } else if input.starts_with(&[0xff, 0xd8, 0xff]) {
        ImageFormat::Jpeg
    } else {
        return Err(DeviceError::UnsupportedResource);
    };
    let mut reader = ImageReader::with_format(Cursor::new(input), format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_AXIS);
    limits.max_image_height = Some(MAX_AXIS);
    limits.max_alloc = Some(MAX_DECODE_BYTES);
    reader.limits(limits);
    let decoder = reader.into_decoder().map_err(decode_error)?;
    let (width, height) = decoder.dimensions();
    if width == 0
        || height == 0
        || width > MAX_AXIS
        || height > MAX_AXIS
        || u64::from(width) * u64::from(height) > MAX_PIXELS
        || decoder.total_bytes() > MAX_DECODE_BYTES
    {
        return Err(DeviceError::LimitExceeded);
    }
    read::check(cancel, started)?;
    let pixels = DynamicImage::from_decoder(decoder).map_err(decode_error)?;
    read::check(cancel, started)?;
    let thumbnail = pixels.thumbnail(512, 512).into_rgba8();
    drop(pixels);
    let mut output = CappedOutput(Vec::new());
    use image::ImageEncoder;
    image::codecs::png::PngEncoder::new(&mut output)
        .write_image(
            thumbnail.as_raw(),
            thumbnail.width(),
            thumbnail.height(),
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|_| DeviceError::LimitExceeded)?;
    read::check(cancel, started)?;
    Ok(output.0)
}

fn decode_error(error: image::ImageError) -> DeviceError {
    match error {
        image::ImageError::Limits(_) => DeviceError::LimitExceeded,
        _ => DeviceError::DecodeFailed,
    }
}

struct CappedOutput(Vec<u8>);

impl Write for CappedOutput {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > MAX_THUMBNAIL_BYTES - self.0.len() {
            return Err(io::Error::other("thumbnail limit exceeded"));
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
    fn thumbnail_validates_format_dimensions_and_output() {
        let cancel = AtomicBool::new(false);
        let now = Instant::now();
        for format in [ImageFormat::Png, ImageFormat::Jpeg] {
            let pixels = DynamicImage::new_rgb8(600, 120);
            let mut input = Cursor::new(Vec::new());
            pixels.write_to(&mut input, format).unwrap();
            let result = thumbnail(input.get_ref(), &cancel, now).unwrap();
            let decoded = image::load_from_memory_with_format(&result, ImageFormat::Png).unwrap();
            assert_eq!((decoded.width(), decoded.height()), (512, 102));
        }
        let mut large = Cursor::new(Vec::new());
        DynamicImage::new_rgb8(4097, 1)
            .write_to(&mut large, ImageFormat::Png)
            .unwrap();
        assert_eq!(
            thumbnail(large.get_ref(), &cancel, now),
            Err(DeviceError::LimitExceeded)
        );
        assert_eq!(
            thumbnail(b"<svg></svg>", &cancel, now),
            Err(DeviceError::UnsupportedResource)
        );
        assert_eq!(
            thumbnail(b"\x89PNG\r\n\x1a\n", &cancel, now),
            Err(DeviceError::DecodeFailed)
        );
    }
}
