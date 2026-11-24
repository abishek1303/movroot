use super::{DeviceError, Root, discovery::Resource};
use serde::Deserialize;
use std::{
    io::Read,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

pub(super) const MAX_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReadMode {
    Content,
    ImagePreview,
}

pub(super) fn check(cancel: &AtomicBool, started: Instant) -> Result<(), DeviceError> {
    if cancel.load(Ordering::Acquire) {
        return Err(DeviceError::Cancelled);
    }
    if started.elapsed() >= Duration::from_secs(3) {
        return Err(DeviceError::LimitExceeded);
    }
    Ok(())
}

pub(super) fn read(
    root: &Root,
    resource: &Resource,
    max_bytes: usize,
    cancel: &AtomicBool,
    started: Instant,
) -> Result<Vec<u8>, DeviceError> {
    check(cancel, started)?;
    let (mut file, length) = root.open_file(resource)?;
    if length > max_bytes as u64 {
        return Err(DeviceError::LimitExceeded);
    }
    let bytes = read_bounded(&mut file, max_bytes, cancel, started)?;
    root.verify_file(&file, resource)?;
    check(cancel, started)?;
    Ok(bytes)
}

fn read_bounded(
    file: &mut impl Read,
    max_bytes: usize,
    cancel: &AtomicBool,
    started: Instant,
) -> Result<Vec<u8>, DeviceError> {
    let mut bytes = Vec::new();
    let mut chunk = [0; 32 * 1024];
    loop {
        check(cancel, started)?;
        let limit = chunk.len().min(max_bytes - bytes.len() + 1);
        let count = match file.read(&mut chunk[..limit]) {
            Ok(0) => break,
            Ok(count) => count,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return Err(DeviceError::Unavailable),
        };
        if count > max_bytes - bytes.len() {
            return Err(DeviceError::LimitExceeded);
        }
        // Allocate only the admitted bytes.
        if bytes.capacity() - bytes.len() < count {
            let next = (bytes.capacity() * 2)
                .max(bytes.len() + count)
                .min(max_bytes);
            bytes
                .try_reserve_exact(next - bytes.len())
                .map_err(|_| DeviceError::LimitExceeded)?;
        }
        bytes.extend_from_slice(&chunk[..count]);
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_read_rejects_overflow_and_returns_exact_bytes() {
        let flag = AtomicBool::new(false);
        let now = Instant::now();
        let sample = [0, 255, 17, 128];
        assert_eq!(
            read_bounded(&mut sample.as_slice(), 4, &flag, now).unwrap(),
            sample
        );
        assert_eq!(
            read_bounded(&mut sample.as_slice(), 3, &flag, now),
            Err(DeviceError::LimitExceeded)
        );
        flag.store(true, Ordering::Release);
        assert_eq!(
            read_bounded(&mut sample.as_slice(), 4, &flag, now),
            Err(DeviceError::Cancelled)
        );
    }
}
