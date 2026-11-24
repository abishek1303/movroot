use super::{DeviceError, Root};
use serde::Serialize;
use std::{
    ffi::OsString,
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};
use uuid::Uuid;

pub(super) const MAX_FILES: usize = 500;
const MAX_EXAMINED: usize = 2_000;
const MAX_RESPONSE: usize = 512 * 1024;

pub(super) enum Entry {
    File {
        name: OsString,
        size: Option<u64>,
        identity: super::Identity,
    },
    Skipped,
    Unavailable,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FileMetadata {
    file_id: Uuid,
    display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    extension: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    size_bytes: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ScanStatus {
    Complete,
    Partial,
    Truncated,
    Cancelled,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Discovery {
    status: ScanStatus,
    files: Vec<FileMetadata>,
    examined: usize,
    unavailable: usize,
}

#[derive(Clone)]
pub(super) struct Resource {
    pub id: Uuid,
    pub name: OsString,
    pub identity: super::Identity,
}

impl Discovery {
    pub fn cancelled() -> Self {
        Self {
            status: ScanStatus::Cancelled,
            files: Vec::new(),
            examined: 0,
            unavailable: 0,
        }
    }
}

pub(super) fn scan(
    root: &Root,
    cancelled: &AtomicBool,
) -> Result<(Discovery, Vec<Resource>), DeviceError> {
    let started = Instant::now();
    let mut result = Discovery {
        status: ScanStatus::Complete,
        files: Vec::new(),
        examined: 0,
        unavailable: 0,
    };
    let mut entries = Vec::new();
    // Reserve space for the serialized envelope, counters and separators.
    let mut remaining = MAX_RESPONSE - 4096;

    root.visit(
        &mut || !cancelled.load(Ordering::Acquire) && started.elapsed() < Duration::from_secs(2),
        &mut |entry| {
            if result.examined == MAX_EXAMINED {
                result.status = ScanStatus::Truncated;
                return false;
            }
            result.examined += 1;
            match entry {
                Entry::File {
                    name,
                    size,
                    identity,
                } => {
                    if entries.len() == MAX_FILES {
                        result.status = ScanStatus::Truncated;
                        return false;
                    }
                    let display_name = super::display_label(&name, "Unnamed file");
                    let extension = std::path::Path::new(&display_name)
                        .extension()
                        .and_then(|value| value.to_str())
                        .filter(|value| !value.is_empty() && value.len() <= 32)
                        .map(str::to_owned);
                    let file_id = Uuid::new_v4();
                    let metadata = FileMetadata {
                        file_id,
                        display_name,
                        extension,
                        size_bytes: size.filter(|size| *size <= 9_007_199_254_740_991),
                    };
                    let cost = serde_json::to_vec(&metadata)
                        .expect("serializable metadata")
                        .len()
                        + 1;
                    if cost > remaining {
                        result.status = ScanStatus::Truncated;
                        return false;
                    }
                    remaining -= cost;
                    entries.push((
                        metadata,
                        Resource {
                            id: file_id,
                            name,
                            identity,
                        },
                    ));
                }
                Entry::Unavailable => result.unavailable += 1,
                Entry::Skipped => {}
            }
            true
        },
    )?;

    if cancelled.load(Ordering::Acquire) {
        return Ok((Discovery::cancelled(), Vec::new()));
    }
    if started.elapsed() >= Duration::from_secs(2) {
        result.status = ScanStatus::Truncated;
    } else if matches!(result.status, ScanStatus::Complete) && result.unavailable != 0 {
        result.status = ScanStatus::Partial;
    }
    entries.sort_by(|(left, left_resource), (right, right_resource)| {
        left.display_name
            .cmp(&right.display_name)
            .then_with(|| left_resource.name.cmp(&right_resource.name))
    });
    let (files, resources) = entries.into_iter().unzip();
    result.files = files;
    Ok((result, resources))
}
