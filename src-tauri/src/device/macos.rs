use super::DeviceError;
use rustix::{
    fd::OwnedFd,
    fs::{self, Mode, OFlags},
    io::Errno,
};
use std::path::{Component, Path};

/// The descriptor pins the selected APFS directory object for the lifetime of the grant.
/// Moving the directory does not retarget this descriptor.
pub(super) struct Root {
    _fd: OwnedFd,
}

fn io_error(error: Errno) -> DeviceError {
    match error {
        Errno::ACCESS | Errno::PERM => DeviceError::PermissionDenied,
        Errno::LOOP | Errno::NOTDIR => DeviceError::UnsupportedResource,
        _ => DeviceError::Unavailable,
    }
}

impl Root {
    pub(super) fn open(path: &Path) -> Result<Self, DeviceError> {
        // File Provider roots can contain remote placeholders. Reject these before opening.
        let components: Vec<_> = path.components().collect();
        if components.len() < 3
            || components.len() > 128
            || components[0] != Component::RootDir
            || path.starts_with("/Volumes")
            || path.starts_with("/Network")
            || path.starts_with("/System")
            || path.starts_with("/dev")
            || path == Path::new("/Users/Shared")
            || (path.starts_with("/Users") && components.len() < 4)
            || components.windows(2).any(|pair| {
                matches!(pair, [Component::Normal(parent), Component::Normal(child)]
                    if parent.eq_ignore_ascii_case("Library") &&
                    (child.eq_ignore_ascii_case("CloudStorage") || child.eq_ignore_ascii_case("Mobile Documents")))
            })
        {
            return Err(DeviceError::UnsupportedResource);
        }

        let flags = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
        let mut fd = fs::open("/", flags, Mode::empty()).map_err(io_error)?;
        for component in &components[1..] {
            let Component::Normal(name) = component else {
                return Err(DeviceError::UnsupportedResource);
            };
            fd = fs::openat(&fd, *name, flags, Mode::empty()).map_err(io_error)?;
            let info = fs::fstat(&fd).map_err(io_error)?;
            // Darwin UF_DATALESS marks a file whose data has not been materialized.
            if info.st_flags & 0x4000_0000 != 0 {
                return Err(DeviceError::UnsupportedResource);
            }
        }
        let volume = fs::fstatfs(&fd).map_err(io_error)?;
        // Darwin MNT_LOCAL is 0x1000. Use only APFS with the local mount flag.
        let fs_name: Vec<_> = volume
            .f_fstypename
            .iter()
            .take_while(|&&byte| byte != 0)
            .map(|&byte| byte as u8)
            .collect();
        if volume.f_flags & 0x1000 == 0 || fs_name != b"apfs" {
            return Err(DeviceError::UnsupportedResource);
        }
        Ok(Self { _fd: fd })
    }
}

pub(super) type Identity = (u64, u64, i64, i64, i64);

fn identity(stat: &fs::Stat) -> Identity {
    (
        stat.st_dev as u64,
        stat.st_ino as u64,
        stat.st_ctime as i64,
        stat.st_ctime_nsec as i64,
        stat.st_size,
    )
}

impl Root {
    pub(super) fn visit(
        &self,
        running: &mut impl FnMut() -> bool,
        visit: &mut impl FnMut(super::discovery::Entry) -> bool,
    ) -> Result<(), DeviceError> {
        use super::discovery::Entry;
        use std::os::unix::ffi::OsStrExt;
        let root_stat = fs::fstat(&self._fd).map_err(io_error)?;
        let scan_fd = fs::openat(
            &self._fd,
            ".",
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(io_error)?;
        let mut entries = fs::Dir::new(scan_fd).map_err(io_error)?;
        while running() {
            let Some(entry) = entries.read() else { break };
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    if !visit(Entry::Unavailable) {
                        break;
                    }
                    return Err(io_error(error));
                }
            };
            let name = entry.file_name();
            if matches!(name.to_bytes(), b"." | b"..") {
                continue;
            }
            let result = match fs::statat(&self._fd, name, fs::AtFlags::SYMLINK_NOFOLLOW) {
                Ok(stat)
                    if fs::FileType::from_raw_mode(stat.st_mode) == fs::FileType::RegularFile
                        && stat.st_dev == root_stat.st_dev
                        && stat.st_flags & 0x4000_0000 == 0
                        && stat.st_nlink == 1 =>
                {
                    Entry::File {
                        name: std::ffi::OsStr::from_bytes(name.to_bytes()).to_owned(),
                        size: stat.st_size.try_into().ok(),
                        identity: identity(&stat),
                    }
                }
                Ok(_) => Entry::Skipped,
                Err(_) => Entry::Unavailable,
            };
            if !visit(result) {
                break;
            }
        }
        Ok(())
    }
}

impl Root {
    pub(super) fn open_file(
        &self,
        resource: &super::discovery::Resource,
    ) -> Result<(std::fs::File, u64), DeviceError> {
        let before = fs::statat(&self._fd, &resource.name, fs::AtFlags::SYMLINK_NOFOLLOW).map_err(
            |error| {
                if error == Errno::NOENT {
                    DeviceError::ResourceChanged
                } else {
                    io_error(error)
                }
            },
        )?;
        Self::require_file(&before, resource)?;
        let fd = fs::openat(
            &self._fd,
            &resource.name,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC | OFlags::NOCTTY,
            Mode::empty(),
        )
        .map_err(|error| {
            if error == Errno::NOENT || error == Errno::LOOP {
                DeviceError::ResourceChanged
            } else {
                io_error(error)
            }
        })?;
        let file = std::fs::File::from(fd);
        let length = self.verify_file(&file, resource)?;
        Ok((file, length))
    }

    fn require_file(
        stat: &fs::Stat,
        resource: &super::discovery::Resource,
    ) -> Result<u64, DeviceError> {
        if fs::FileType::from_raw_mode(stat.st_mode) != fs::FileType::RegularFile
            || stat.st_nlink != 1
            || stat.st_flags & 0x4000_0000 != 0
            || identity(stat) != resource.identity
        {
            return Err(DeviceError::ResourceChanged);
        }
        stat.st_size
            .try_into()
            .map_err(|_| DeviceError::UnsupportedResource)
    }

    pub(super) fn verify_file(
        &self,
        file: &std::fs::File,
        resource: &super::discovery::Resource,
    ) -> Result<u64, DeviceError> {
        Self::require_file(&fs::fstat(file).map_err(io_error)?, resource)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    #[test]
    fn accepts_local_directory_and_rejects_symlink_ancestor() {
        let base = Path::new("/private/tmp").join(format!("movroot-{}", uuid::Uuid::new_v4()));
        let actual = base.join("actual");
        std::fs::create_dir_all(actual.join("child")).unwrap();
        let alias = base.join("alias");
        symlink(&actual, &alias).unwrap();
        let accepted = Root::open(&actual).is_ok();
        let rejected = matches!(
            Root::open(&alias.join("child")),
            Err(DeviceError::UnsupportedResource)
        );
        std::fs::remove_dir_all(base).unwrap();
        assert!(accepted);
        assert!(rejected);
    }

    #[test]
    fn enumerates_pinned_directory_and_detects_replacement() {
        let base = Path::new("/private/tmp").join(format!("movroot-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&base).unwrap();
        let filename = "résumé.txt";
        std::fs::write(base.join(filename), b"first").unwrap();
        let root = Root::open(&base).unwrap();
        let before = fs::statat(&root._fd, filename, fs::AtFlags::SYMLINK_NOFOLLOW).unwrap();
        let mut entries = fs::Dir::read_from(&root._fd).unwrap();
        assert!(entries.any(|entry| entry.unwrap().file_name().to_bytes() == filename.as_bytes()));
        std::fs::rename(base.join(filename), base.join("previous")).unwrap();
        std::fs::write(base.join(filename), b"second").unwrap();
        let opened = fs::openat(
            &root._fd,
            filename,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK,
            Mode::empty(),
        )
        .unwrap();
        assert_ne!(before.st_ino, fs::fstat(&opened).unwrap().st_ino);
        std::fs::remove_file(base.join(filename)).unwrap();
        symlink("previous", base.join(filename)).unwrap();
        assert!(matches!(
            fs::openat(
                &root._fd,
                filename,
                OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK,
                Mode::empty()
            ),
            Err(Errno::LOOP)
        ));
        std::fs::remove_dir_all(base).unwrap();
    }
}
