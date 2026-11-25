use serde::Serialize;

use super::Failure;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    #[cfg(all(dev, debug_assertions))]
    Environment,
    SecureStore,
    Missing,
}

pub struct Resolved {
    source: Source,
    key: Option<String>,
}

impl Resolved {
    pub fn source(&self) -> Source {
        self.source
    }

    pub fn into_key(self) -> Option<String> {
        self.key
    }
}

pub fn resolve() -> Result<Resolved, Failure> {
    resolve_with(
        #[cfg(all(dev, debug_assertions))]
        development_key,
        || access(Action::Read),
    )
}

fn resolve_with(
    #[cfg(all(dev, debug_assertions))] development: impl FnOnce() -> Result<Option<String>, Failure>,
    secure_store: impl FnOnce() -> Result<Option<String>, Failure>,
) -> Result<Resolved, Failure> {
    #[cfg(all(dev, debug_assertions))]
    if let Some(key) = development()? {
        return Ok(Resolved {
            source: Source::Environment,
            key: Some(key),
        });
    }
    let key = secure_store()?;
    Ok(Resolved {
        source: if key.is_some() {
            Source::SecureStore
        } else {
            Source::Missing
        },
        key,
    })
}

#[cfg(all(dev, debug_assertions))]
fn development_key() -> Result<Option<String>, Failure> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../.env");
    resolve_environment(std::env::var("META_API_KEY"), || read_dotenv(&path))
}

#[cfg(all(dev, debug_assertions))]
fn resolve_environment(
    process_value: Result<String, std::env::VarError>,
    dotenv_value: impl FnOnce() -> Result<Option<String>, Failure>,
) -> Result<Option<String>, Failure> {
    use std::env::VarError;
    match process_value {
        Ok(value) if !value.trim().is_empty() => Ok(Some(value)),
        Ok(_) | Err(VarError::NotPresent) => dotenv_value(),
        Err(VarError::NotUnicode(_)) => Err(Failure::new("invalidCredential")),
    }
}

#[cfg(all(dev, debug_assertions))]
fn read_dotenv(path: &std::path::Path) -> Result<Option<String>, Failure> {
    let entries = match dotenvy::from_path_iter(path) {
        Ok(entries) => entries,
        Err(dotenvy::Error::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(None);
        }
        Err(_) => return Err(Failure::new("credentialConfiguration")),
    };
    for entry in entries {
        let (name, value) = entry.map_err(|_| Failure::new("credentialConfiguration"))?;
        if name == "META_API_KEY" {
            return Ok((!value.trim().is_empty()).then_some(value));
        }
    }
    Ok(None)
}

#[cfg(any(target_os = "macos", windows))]
pub fn access(action: Action) -> Result<Option<String>, Failure> {
    let entry = keyring::Entry::new("app.movroot.desktop", "muse-ember-api-key")
        .map_err(|_| Failure::new("credentialStore"))?;
    match action {
        Action::Read => match entry.get_password() {
            Ok(key) => Ok(Some(key)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(Failure::new("credentialStore")),
        },
        Action::Save(key) => {
            entry
                .set_password(&key)
                .map_err(|_| Failure::new("credentialStore"))?;
            Ok(None)
        }
        Action::Remove => match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(Failure::new("credentialStore")),
        },
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
pub fn access(_: Action) -> Result<Option<String>, Failure> {
    Err(Failure::new("credentialStore"))
}

pub enum Action {
    Read,
    Save(String),
    Remove,
}

pub fn valid_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 1024
        && key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-._~+/=".contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_secure_store_and_missing_without_serializing_keys() {
        let stored = resolve_with(
            #[cfg(all(dev, debug_assertions))]
            || Ok(None),
            || Ok(Some("fixture-storage-secret".into())),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_string(&stored.source()).unwrap(),
            "\"secureStore\""
        );
        assert!(stored.into_key().is_some());

        let missing = resolve_with(
            #[cfg(all(dev, debug_assertions))]
            || Ok(None),
            || Ok(None),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_string(&missing.source()).unwrap(),
            "\"missing\""
        );
        assert!(missing.into_key().is_none());
    }

    #[cfg(all(dev, debug_assertions))]
    #[test]
    fn resolves_process_then_file_then_vault_and_skips_empty_values() {
        let process = resolve_with(
            || {
                resolve_environment(Ok("fixture-process-secret".into()), || {
                    panic!("read dotenv")
                })
            },
            || panic!("read vault"),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_string(&process.source()).unwrap(),
            "\"environment\""
        );
        assert!(process.into_key().as_deref() == Some("fixture-process-secret"));

        for unavailable in [
            Ok(String::new()),
            Ok("  ".into()),
            Err(std::env::VarError::NotPresent),
        ] {
            let dotenv = resolve_with(
                || resolve_environment(unavailable, || Ok(Some("fixture-file-secret".into()))),
                || panic!("read vault"),
            )
            .unwrap();
            assert_eq!(dotenv.source(), Source::Environment);
            assert!(dotenv.into_key().as_deref() == Some("fixture-file-secret"));
        }
    }

    #[cfg(all(dev, debug_assertions))]
    #[test]
    fn reads_only_the_exact_dotenv_file_and_redacts_parse_errors() {
        use std::fs;
        let directory = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        fs::create_dir(&directory).unwrap();
        let path = directory.join(".env");
        let missing = directory.join("subdirectory").join(".env");
        assert!(read_dotenv(&path).unwrap().is_none());
        fs::write(&path, "# development\nMETA_API_KEY='fixture-file-secret'\n").unwrap();
        assert!(read_dotenv(&path).unwrap().as_deref() == Some("fixture-file-secret"));
        assert!(read_dotenv(&missing).unwrap().is_none());
        for contents in [
            "META_API_KEY=\n",
            "UNRELATED_KEY=fixture-unrelated-secret\n",
        ] {
            fs::write(&path, contents).unwrap();
            assert!(read_dotenv(&path).unwrap().is_none());
        }
        fs::write(&path, "META_API_KEY='fixture-malformed-secret\n").unwrap();
        let error = read_dotenv(&path).unwrap_err();
        assert_eq!(error.code, "credentialConfiguration");
        assert!(
            !serde_json::to_string(&error)
                .unwrap()
                .contains("fixture-malformed-secret")
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(not(all(dev, debug_assertions)))]
    #[test]
    fn packaged_resolver_exposes_only_the_vault_lookup() {
        // The packaged signature has no development callback, even in a debug package.
        let resolved = resolve_with(|| Ok(Some("fixture-storage-secret".into()))).unwrap();
        assert_eq!(resolved.source(), Source::SecureStore);
    }
}
