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
