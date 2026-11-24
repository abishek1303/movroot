use serde::Serialize;
use std::sync::Mutex;
use uuid::Uuid;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos::Root;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows::Root;

#[cfg(not(any(target_os = "macos", windows)))]
struct Root;

#[cfg(not(any(target_os = "macos", windows)))]
impl Root {
    fn open(_: &std::path::Path) -> Result<Self, DeviceError> {
        Err(DeviceError::UnsupportedResource)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DeviceError {
    InvalidRequest,
    ScopeInactive,
    UnsupportedResource,
    PermissionDenied,
    Busy,
    Cancelled,
    Unavailable,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Scope {
    scope_id: Uuid,
    label: String,
    capabilities: [&'static str; 0],
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Selection {
    Selected { scope: Scope },
    Cancelled,
}

#[derive(Default)]
struct Session {
    ready: bool,
    picker: Option<Uuid>,
    accept_picker: bool,
    active: Option<(Scope, Root)>,
}

#[derive(Default)]
pub struct DeviceState(Mutex<Session>);

impl DeviceState {
    pub fn page_loading(&self) {
        let mut session = self.0.lock().unwrap();
        session.ready = false;
        session.accept_picker = false;
        session.active = None;
    }

    pub fn page_ready(&self) {
        self.0.lock().unwrap().ready = true;
    }

    pub fn begin_picker(&self) -> Result<Uuid, DeviceError> {
        let mut session = self.0.lock().unwrap();
        if !session.ready {
            return Err(DeviceError::ScopeInactive);
        }
        if session.picker.is_some() {
            return Err(DeviceError::Busy);
        }
        let ticket = Uuid::new_v4();
        session.picker = Some(ticket);
        session.accept_picker = true;
        Ok(ticket)
    }

    pub fn finish_picker(
        &self,
        ticket: Uuid,
        path: Option<std::path::PathBuf>,
    ) -> Result<Selection, DeviceError> {
        {
            let mut session = self.0.lock().unwrap();
            if session.picker != Some(ticket) {
                return Err(DeviceError::Cancelled);
            }
            if !session.accept_picker {
                session.picker = None;
                return Err(DeviceError::Cancelled);
            }
        }
        let opened = path.map(|path| {
            let root = Root::open(&path)?;
            let label = path
                .file_name()
                .ok_or(DeviceError::UnsupportedResource)?
                .to_string_lossy()
                .chars()
                .filter(|ch| {
                    !ch.is_control()
                        && !matches!(ch, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
                })
                .take(255)
                .collect::<String>();
            let scope = Scope {
                scope_id: Uuid::new_v4(),
                label: if label.is_empty() {
                    "Selected folder".into()
                } else {
                    label
                },
                capabilities: [],
            };
            Ok::<_, DeviceError>((scope, root))
        });
        let mut session = self.0.lock().unwrap();
        if session.picker != Some(ticket) {
            return Err(DeviceError::Cancelled);
        }
        session.picker = None;
        if !session.accept_picker || !session.ready {
            return Err(DeviceError::Cancelled);
        }
        match opened.transpose()? {
            Some((scope, root)) => {
                session.active = Some((scope.clone(), root));
                Ok(Selection::Selected { scope })
            }
            None => Ok(Selection::Cancelled),
        }
    }

    pub fn abandon_picker(&self, ticket: Uuid) {
        let mut session = self.0.lock().unwrap();
        if session.picker == Some(ticket) {
            session.picker = None;
            session.accept_picker = false;
        }
    }

    pub fn clear(&self, id: &str) -> Result<(), DeviceError> {
        if id.len() != 36 {
            return Err(DeviceError::InvalidRequest);
        }
        let id = Uuid::parse_str(id).map_err(|_| DeviceError::InvalidRequest)?;
        let mut session = self.0.lock().unwrap();
        if session.active.as_ref().map(|(scope, _)| scope.scope_id) != Some(id) {
            return Err(DeviceError::ScopeInactive);
        }
        session.active = None;
        session.accept_picker = false;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reload_rejects_in_flight_picker_and_blocks_admission_until_ready() {
        let state = DeviceState::default();
        state.page_ready();
        let picker = state.begin_picker().unwrap();
        state.page_loading();
        assert_eq!(state.begin_picker(), Err(DeviceError::ScopeInactive));
        state.page_ready();
        assert_eq!(state.begin_picker(), Err(DeviceError::Busy));
        assert!(matches!(
            state.finish_picker(picker, None),
            Err(DeviceError::Cancelled)
        ));
        assert!(state.begin_picker().is_ok());
    }

    #[test]
    fn cancelled_picker_releases_admission_and_replay_is_rejected() {
        let state = DeviceState::default();
        state.page_ready();
        let old = state.begin_picker().unwrap();
        assert!(matches!(
            state.finish_picker(old, None),
            Ok(Selection::Cancelled)
        ));
        let next = state.begin_picker().unwrap();
        assert!(matches!(
            state.finish_picker(old, None),
            Err(DeviceError::Cancelled)
        ));
        assert!(matches!(
            state.finish_picker(next, None),
            Ok(Selection::Cancelled)
        ));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn replacement_revokes_old_id_and_clear_invalidates_pending_selection() {
        let base = std::path::Path::new("/private/tmp").join(format!("movroot-{}", Uuid::new_v4()));
        let first = base.join("first");
        let second = base.join("second");
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir(&second).unwrap();
        let state = DeviceState::default();
        state.page_ready();
        let first_ticket = state.begin_picker().unwrap();
        let Selection::Selected { scope: previous } =
            state.finish_picker(first_ticket, Some(first)).unwrap()
        else {
            panic!("expected a scope")
        };
        let next_ticket = state.begin_picker().unwrap();
        let Selection::Selected { scope } = state
            .finish_picker(next_ticket, Some(second.clone()))
            .unwrap()
        else {
            panic!("expected a replacement")
        };
        assert_eq!(
            state.clear(&previous.scope_id.to_string()),
            Err(DeviceError::ScopeInactive)
        );
        let pending = state.begin_picker().unwrap();
        state.clear(&scope.scope_id.to_string()).unwrap();
        assert!(matches!(
            state.finish_picker(pending, Some(second)),
            Err(DeviceError::Cancelled)
        ));
        assert!(state.0.lock().unwrap().active.is_none());
        std::fs::remove_dir_all(base).unwrap();
    }
}
