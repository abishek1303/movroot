use super::DeviceError;
use std::{
    ffi::OsStr,
    io,
    mem::{size_of, size_of_val},
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::{Component, Path, Prefix},
    ptr::{null, null_mut},
};
use windows_sys::{
    Wdk::{Foundation::OBJECT_ATTRIBUTES, Storage::FileSystem as nt},
    Win32::{Foundation::*, Storage::FileSystem as fs, System::IO::IO_STATUS_BLOCK},
};

const REJECTED_ATTRIBUTES: u32 = fs::FILE_ATTRIBUTE_REPARSE_POINT
    | fs::FILE_ATTRIBUTE_OFFLINE
    | fs::FILE_ATTRIBUTE_RECALL_ON_OPEN
    | fs::FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS;

const SHARING: u32 = fs::FILE_SHARE_READ | fs::FILE_SHARE_WRITE | fs::FILE_SHARE_DELETE;

pub(super) struct Root {
    _handle: OwnedHandle,
}

fn io_error(error: io::Error) -> DeviceError {
    match error.kind() {
        io::ErrorKind::PermissionDenied => DeviceError::PermissionDenied,
        _ => DeviceError::Unavailable,
    }
}

fn attributes(handle: &OwnedHandle) -> Result<u32, DeviceError> {
    let mut info = fs::FILE_ATTRIBUTE_TAG_INFO::default();
    // The live handle is borrowed and the output buffer has the matching fixed layout.
    let succeeded = unsafe {
        fs::GetFileInformationByHandleEx(
            handle.as_raw_handle(),
            fs::FileAttributeTagInfo,
            (&mut info as *mut fs::FILE_ATTRIBUTE_TAG_INFO).cast(),
            size_of_val(&info) as u32,
        )
    };
    if succeeded == 0 {
        return Err(io_error(io::Error::last_os_error()));
    }
    if info.FileAttributes & REJECTED_ATTRIBUTES != 0 {
        return Err(DeviceError::UnsupportedResource);
    }
    Ok(info.FileAttributes)
}

fn open_component(
    parent: &OwnedHandle,
    name: &OsStr,
    access: u32,
) -> Result<OwnedHandle, DeviceError> {
    let mut name: Vec<u16> = name.encode_wide().collect();
    if name.is_empty()
        || name.len() > 255
        || name == [46]
        || name == [46, 46]
        || name.iter().any(|unit| matches!(*unit, 0 | 47 | 58 | 92))
    {
        return Err(DeviceError::UnsupportedResource);
    }
    let length = (name.len() * size_of::<u16>()) as u16;
    let name = UNICODE_STRING {
        Length: length,
        MaximumLength: length,
        Buffer: name.as_mut_ptr(),
    };
    let request = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: parent.as_raw_handle(),
        ObjectName: &name,
        Attributes: OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE,
        ..Default::default()
    };
    let mut status_block = IO_STATUS_BLOCK::default();
    let mut child = null_mut();
    // The name and parent remain alive throughout the synchronous call. FILE_OPEN
    // never creates a file. A successful call transfers one handle to OwnedHandle.
    let status = unsafe {
        nt::NtCreateFile(
            &mut child,
            access | fs::SYNCHRONIZE,
            &request,
            &mut status_block,
            null(),
            0,
            SHARING,
            nt::FILE_OPEN,
            nt::FILE_OPEN_REPARSE_POINT
                | nt::FILE_OPEN_NO_RECALL
                | nt::FILE_SYNCHRONOUS_IO_NONALERT,
            null(),
            0,
        )
    };
    if status < 0 {
        if status == STATUS_REPARSE_POINT_ENCOUNTERED {
            return Err(DeviceError::UnsupportedResource);
        }
        // This conversion takes a scalar NTSTATUS and has no pointer arguments.
        let code = unsafe { RtlNtStatusToDosError(status) };
        return Err(io_error(io::Error::from_raw_os_error(code as i32)));
    }
    if child.is_null() || child == INVALID_HANDLE_VALUE {
        return Err(DeviceError::Unavailable);
    }
    // The successful call returned a unique, closeable Win32 handle.
    let handle = unsafe { OwnedHandle::from_raw_handle(child) };
    attributes(&handle)?;
    Ok(handle)
}

impl Root {
    pub(super) fn open(path: &Path) -> Result<Self, DeviceError> {
        let parts: Vec<_> = path.components().collect();
        let [Component::Prefix(prefix), Component::RootDir, rest @ ..] = parts.as_slice() else {
            return Err(DeviceError::UnsupportedResource);
        };
        let (Prefix::Disk(drive) | Prefix::VerbatimDisk(drive)) = prefix.kind() else {
            return Err(DeviceError::UnsupportedResource);
        };
        if !(2..=128).contains(&rest.len())
            || (matches!(rest.first(), Some(Component::Normal(name)) if name.eq_ignore_ascii_case("Users"))
                && rest.len() < 3)
            || rest.iter().any(|part| matches!(part, Component::Normal(name) if name.to_string_lossy().to_ascii_lowercase().starts_with("onedrive")))
        {
            return Err(DeviceError::UnsupportedResource);
        }
        let drive_name = [u16::from(drive), 58, 92, 0];
        // The four-element path is a NUL-terminated drive root. DRIVE_FIXED is 3.
        if unsafe { fs::GetDriveTypeW(drive_name.as_ptr()) } != 3 {
            return Err(DeviceError::UnsupportedResource);
        }
        // CreateFileW opens only the drive root. Descendants use relative opens.
        let raw = unsafe {
            fs::CreateFileW(
                drive_name.as_ptr(),
                fs::FILE_READ_ATTRIBUTES,
                SHARING,
                null(),
                fs::OPEN_EXISTING,
                fs::FILE_FLAG_BACKUP_SEMANTICS | fs::FILE_FLAG_OPEN_REPARSE_POINT,
                null_mut(),
            )
        };
        if raw == INVALID_HANDLE_VALUE {
            return Err(io_error(io::Error::last_os_error()));
        }
        // Ownership is transferred by CreateFileW.
        let mut handle = unsafe { OwnedHandle::from_raw_handle(raw) };
        let mut filesystem = [0_u16; 32];
        // The optional outputs are null. The filesystem output has 32 UTF-16 units.
        let succeeded = unsafe {
            fs::GetVolumeInformationByHandleW(
                handle.as_raw_handle(),
                null_mut(),
                0,
                null_mut(),
                null_mut(),
                null_mut(),
                filesystem.as_mut_ptr(),
                filesystem.len() as u32,
            )
        };
        if succeeded == 0 || !filesystem.starts_with(&[78, 84, 70, 83, 0]) {
            return Err(DeviceError::UnsupportedResource);
        }
        for (index, component) in rest.iter().enumerate() {
            let Component::Normal(name) = component else {
                return Err(DeviceError::UnsupportedResource);
            };
            let access = if index + 1 == rest.len() {
                fs::FILE_READ_ATTRIBUTES | fs::FILE_LIST_DIRECTORY
            } else {
                fs::FILE_READ_ATTRIBUTES
            };
            handle = open_component(&handle, name, access)?;
            if attributes(&handle)? & fs::FILE_ATTRIBUTE_DIRECTORY == 0 {
                return Err(DeviceError::UnsupportedResource);
            }
        }
        Ok(Self { _handle: handle })
    }
}

pub(super) type Identity = ([u8; 16], i64, i64, i64);

impl Root {
    pub(super) fn visit(
        &self,
        running: &mut impl FnMut() -> bool,
        visit: &mut impl FnMut(super::discovery::Entry) -> bool,
    ) -> Result<(), DeviceError> {
        use super::discovery::Entry;
        use std::{mem::offset_of, os::windows::ffi::OsStringExt};
        let mut buffer = [0_u64; 2048];
        let mut class = fs::FileIdExtdDirectoryRestartInfo;
        while running() {
            // The live directory handle and aligned, writable buffer outlive the call.
            let ok = unsafe {
                fs::GetFileInformationByHandleEx(
                    self._handle.as_raw_handle(),
                    class,
                    buffer.as_mut_ptr().cast(),
                    size_of_val(&buffer) as u32,
                )
            };
            if ok == 0 {
                let error = io::Error::last_os_error();
                if error.raw_os_error() == Some(ERROR_NO_MORE_FILES as i32) {
                    return Ok(());
                }
                return Err(io_error(error));
            }
            class = fs::FileIdExtdDirectoryInfo;
            let mut offset = 0;
            let capacity = size_of_val(&buffer);
            while running() {
                let header = offset_of!(fs::FILE_ID_EXTD_DIR_INFO, FileName);
                if offset + size_of::<fs::FILE_ID_EXTD_DIR_INFO>() > capacity {
                    return Err(DeviceError::Unavailable);
                }
                // A full record header fits inside the initialized buffer.
                let record = unsafe {
                    buffer
                        .as_ptr()
                        .cast::<u8>()
                        .add(offset)
                        .cast::<fs::FILE_ID_EXTD_DIR_INFO>()
                        .read_unaligned()
                };
                let start = offset + header;
                let end = start
                    .checked_add(record.FileNameLength as usize)
                    .ok_or(DeviceError::Unavailable)?;
                let next = record.NextEntryOffset as usize;
                if start % 2 != 0
                    || end % 2 != 0
                    || end > capacity
                    || (next != 0 && (next < end - offset || next > capacity - offset))
                {
                    return Err(DeviceError::Unavailable);
                }
                // The filename is a checked, aligned UTF-16 slice in the buffer.
                let name = unsafe {
                    std::slice::from_raw_parts(
                        buffer.as_ptr().cast::<u8>().add(start).cast::<u16>(),
                        (end - start) / 2,
                    )
                };
                if name != [46] && name != [46, 46] {
                    let entry = if record.FileAttributes
                        & (REJECTED_ATTRIBUTES | fs::FILE_ATTRIBUTE_DIRECTORY)
                        != 0
                    {
                        Entry::Skipped
                    } else {
                        Entry::File {
                            name: std::ffi::OsString::from_wide(name),
                            size: record.EndOfFile.try_into().ok(),
                            identity: (
                                record.FileId.Identifier,
                                record.ChangeTime,
                                record.LastWriteTime,
                                record.EndOfFile,
                            ),
                        }
                    };
                    if !visit(entry) {
                        return Ok(());
                    }
                }
                if next == 0 {
                    break;
                }
                offset += next;
            }
        }
        Ok(())
    }
}

fn query<T: Default>(
    handle: HANDLE,
    class: fs::FILE_INFO_BY_HANDLE_CLASS,
) -> Result<T, DeviceError> {
    let mut info = T::default();
    // Callers pair the information class with its fixed Win32 output structure.
    let ok = unsafe {
        fs::GetFileInformationByHandleEx(
            handle,
            class,
            (&mut info as *mut T).cast(),
            size_of::<T>() as u32,
        )
    };
    if ok == 0 {
        return Err(io_error(io::Error::last_os_error()));
    }
    Ok(info)
}

impl Root {
    pub(super) fn open_file(
        &self,
        resource: &super::discovery::Resource,
    ) -> Result<(std::fs::File, u64), DeviceError> {
        let handle = open_component(
            &self._handle,
            &resource.name,
            fs::FILE_READ_ATTRIBUTES | fs::FILE_READ_DATA,
        )?;
        let file = std::fs::File::from(handle);
        let length = self.verify_file(&file, resource)?;
        Ok((file, length))
    }

    pub(super) fn verify_file(
        &self,
        file: &std::fs::File,
        resource: &super::discovery::Resource,
    ) -> Result<u64, DeviceError> {
        let handle = file.as_raw_handle();
        // The File owns the live handle until this method returns.
        if unsafe { fs::GetFileType(handle) } != fs::FILE_TYPE_DISK {
            return Err(DeviceError::UnsupportedResource);
        }
        let tag: fs::FILE_ATTRIBUTE_TAG_INFO = query(handle, fs::FileAttributeTagInfo)?;
        let id: fs::FILE_ID_INFO = query(handle, fs::FileIdInfo)?;
        let root_id: fs::FILE_ID_INFO = query(self._handle.as_raw_handle(), fs::FileIdInfo)?;
        let basic: fs::FILE_BASIC_INFO = query(handle, fs::FileBasicInfo)?;
        let standard: fs::FILE_STANDARD_INFO = query(handle, fs::FileStandardInfo)?;
        if tag.FileAttributes & (REJECTED_ATTRIBUTES | fs::FILE_ATTRIBUTE_DIRECTORY) != 0
            || standard.NumberOfLinks != 1
            || standard.DeletePending
            || standard.Directory
            || id.VolumeSerialNumber != root_id.VolumeSerialNumber
            || (
                id.FileId.Identifier,
                basic.ChangeTime,
                basic.LastWriteTime,
                standard.EndOfFile,
            ) != resource.identity
        {
            return Err(DeviceError::ResourceChanged);
        }
        standard
            .EndOfFile
            .try_into()
            .map_err(|_| DeviceError::UnsupportedResource)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::mem::offset_of;

    fn file_id(handle: &OwnedHandle) -> [u8; 16] {
        let mut info = fs::FILE_ID_INFO::default();
        // The output buffer matches FileIdInfo and the handle remains alive.
        assert_ne!(
            unsafe {
                fs::GetFileInformationByHandleEx(
                    handle.as_raw_handle(),
                    fs::FileIdInfo,
                    (&mut info as *mut fs::FILE_ID_INFO).cast(),
                    size_of_val(&info) as u32,
                )
            },
            0
        );
        info.FileId.Identifier
    }

    fn listed_id(root: &Root, filename: &str) -> [u8; 16] {
        // Use an aligned buffer, and copy unaligned records only after bounding each read.
        let mut buffer = [0_u64; 1024];
        assert_ne!(
            unsafe {
                fs::GetFileInformationByHandleEx(
                    root._handle.as_raw_handle(),
                    fs::FileIdExtdDirectoryRestartInfo,
                    buffer.as_mut_ptr().cast(),
                    size_of_val(&buffer) as u32,
                )
            },
            0
        );
        let mut offset = 0;
        loop {
            assert!(offset + size_of::<fs::FILE_ID_EXTD_DIR_INFO>() <= size_of_val(&buffer));
            let record = unsafe {
                buffer
                    .as_ptr()
                    .cast::<u8>()
                    .add(offset)
                    .cast::<fs::FILE_ID_EXTD_DIR_INFO>()
                    .read_unaligned()
            };
            let start = offset + offset_of!(fs::FILE_ID_EXTD_DIR_INFO, FileName);
            let end = start + record.FileNameLength as usize;
            assert!(start % 2 == 0 && end % 2 == 0 && end <= size_of_val(&buffer));
            let name = unsafe {
                std::slice::from_raw_parts(
                    buffer.as_ptr().cast::<u8>().add(start).cast::<u16>(),
                    (end - start) / 2,
                )
            };
            if name.iter().copied().eq(filename.encode_utf16()) {
                return record.FileId.Identifier;
            }
            assert_ne!(record.NextEntryOffset, 0, "fixture missing from listing");
            offset += record.NextEntryOffset as usize;
        }
    }

    #[test]
    fn relative_open_matches_listing_identity_and_detects_replacement() {
        let path = std::env::temp_dir().join(format!("movroot-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        let name = "résumé.txt";
        std::fs::write(path.join(name), b"first").unwrap();
        let root = Root::open(&path).unwrap();
        let moved = path.with_extension("moved");
        let original_id = file_id(&root._handle);
        std::fs::rename(&path, &moved).unwrap();
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("outside.txt"), b"outside").unwrap();
        let replacement_root = Root::open(&path).unwrap();
        assert_ne!(original_id, file_id(&replacement_root._handle));
        assert_eq!(original_id, file_id(&root._handle));
        for rejected in ["..", "../outside.txt", "child:stream", "child\\outside.txt"] {
            assert!(matches!(
                open_component(
                    &root._handle,
                    OsStr::new(rejected),
                    fs::FILE_READ_ATTRIBUTES
                ),
                Err(DeviceError::UnsupportedResource)
            ));
        }
        assert!(
            open_component(
                &root._handle,
                OsStr::new("outside.txt"),
                fs::FILE_READ_ATTRIBUTES
            )
            .is_err()
        );
        let listed = listed_id(&root, name);
        let opened =
            open_component(&root._handle, OsStr::new(name), fs::FILE_READ_ATTRIBUTES).unwrap();
        assert_eq!(listed, file_id(&opened));
        std::fs::rename(moved.join(name), moved.join("previous.txt")).unwrap();
        std::fs::write(moved.join(name), b"second").unwrap();
        let replacement =
            open_component(&root._handle, OsStr::new(name), fs::FILE_READ_ATTRIBUTES).unwrap();
        assert_ne!(listed, file_id(&replacement));
        let junction = moved.join("junction");
        let result = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(&junction)
            .arg(&path)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "could not create synthetic junction"
        );
        assert!(matches!(
            open_component(
                &root._handle,
                OsStr::new("junction"),
                fs::FILE_READ_ATTRIBUTES
            ),
            Err(DeviceError::UnsupportedResource)
        ));
        std::fs::remove_dir(junction).unwrap();
        drop((opened, replacement, root, replacement_root));
        std::fs::remove_dir_all(moved).unwrap();
        std::fs::remove_dir_all(path).unwrap();
    }
}
