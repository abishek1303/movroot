use serde::Serialize;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};

mod discovery;
pub use discovery::Discovery;
use discovery::Resource;
#[cfg(target_os = "macos")]
use macos::Identity;
#[cfg(windows)]
use windows::Identity;
#[cfg(not(any(target_os = "macos", windows)))]
type Identity = ();
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
    fn visit(
        &self,
        _: &mut impl FnMut() -> bool,
        _: &mut impl FnMut(discovery::Entry) -> bool,
    ) -> Result<(), DeviceError> {
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
    capabilities: [&'static str; 1],
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum Selection {
    Selected { scope: Scope },
    Cancelled,
}

struct Grant {
    scope: Scope,
    root: Arc<Root>,
    resources: Vec<Resource>,
    last_request: u32,
    cancelled_next: bool,
}

struct Operation {
    scope: Uuid,
    request: u32,
    cancelled: Arc<AtomicBool>,
}

fn parse_scope(id: &str) -> Result<Uuid, DeviceError> {
    if id.len() != 36 {
        return Err(DeviceError::InvalidRequest);
    }
    Uuid::parse_str(id).map_err(|_| DeviceError::InvalidRequest)
}

fn display_label(name: &std::ffi::OsStr, fallback: &str) -> String {
    let label: String = name
        .to_string_lossy()
        .chars()
        .filter(|ch| {
            !ch.is_control() && !matches!(ch, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
        .take(255)
        .collect();
    if label.is_empty() {
        fallback.to_owned()
    } else {
        label
    }
}

#[derive(Default)]
struct Session {
    ready: bool,
    picker: Option<Uuid>,
    accept_picker: bool,
    active: Option<Grant>,
    operation: Option<Operation>,
}

#[derive(Default)]
pub struct DeviceState(Mutex<Session>);

impl DeviceState {
    fn cancel_active(session: &Session) {
        if let Some(operation) = &session.operation {
            operation.cancelled.store(true, Ordering::Release);
        }
    }

    pub fn page_loading(&self) {
        let mut session = self.0.lock().unwrap();
        session.ready = false;
        session.accept_picker = false;
        Self::cancel_active(&session);
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
            let label = display_label(
                path.file_name().ok_or(DeviceError::UnsupportedResource)?,
                "Selected folder",
            );
            let scope = Scope {
                scope_id: Uuid::new_v4(),
                label,
                capabilities: ["discover"],
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
                Self::cancel_active(&session);
                session.active = Some(Grant {
                    scope: scope.clone(),
                    root: Arc::new(root),
                    resources: Vec::new(),
                    last_request: 0,
                    cancelled_next: false,
                });
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
        let id = parse_scope(id)?;
        let mut session = self.0.lock().unwrap();
        if session.active.as_ref().map(|grant| grant.scope.scope_id) != Some(id) {
            return Err(DeviceError::ScopeInactive);
        }
        Self::cancel_active(&session);
        session.active = None;
        session.accept_picker = false;
        Ok(())
    }

    pub fn cancel(&self, scope: &str, request: u32) -> Result<(), DeviceError> {
        let scope = parse_scope(scope)?;
        let mut session = self.0.lock().unwrap();
        if let Some(operation) = &session.operation {
            if operation.scope == scope && operation.request == request {
                operation.cancelled.store(true, Ordering::Release);
                return Ok(());
            }
        }
        let grant = session
            .active
            .as_mut()
            .filter(|grant| grant.scope.scope_id == scope)
            .ok_or(DeviceError::ScopeInactive)?;
        if grant.last_request.checked_add(1) == Some(request) {
            grant.cancelled_next = true;
        }
        Ok(())
    }

    pub fn discover(&self, scope: &str, request: u32) -> Result<Discovery, DeviceError> {
        let scope = parse_scope(scope)?;
        let (root, cancel) = {
            let mut session = self.0.lock().unwrap();
            let busy = session.operation.is_some();
            let grant = session
                .active
                .as_mut()
                .filter(|grant| grant.scope.scope_id == scope)
                .ok_or(DeviceError::ScopeInactive)?;
            if grant.last_request.checked_add(1) != Some(request) {
                return Err(DeviceError::InvalidRequest);
            }
            grant.last_request = request;
            if std::mem::take(&mut grant.cancelled_next) {
                return Ok(Discovery::cancelled());
            }
            if busy {
                return Err(DeviceError::Busy);
            }
            let root = Arc::clone(&grant.root);
            let cancelled = Arc::new(AtomicBool::new(false));
            session.operation = Some(Operation {
                scope,
                request,
                cancelled: Arc::clone(&cancelled),
            });
            (root, cancelled)
        };
        // Always release admission, including after an unexpected unwinding worker.
        let scanned = std::panic::catch_unwind(|| discovery::scan(&root, &cancel))
            .unwrap_or(Err(DeviceError::Unavailable));
        let mut session = self.0.lock().unwrap();
        session.operation = None;
        let Some(grant) = session
            .active
            .as_mut()
            .filter(|grant| grant.scope.scope_id == scope)
        else {
            return Ok(Discovery::cancelled());
        };
        if cancel.load(Ordering::Acquire) {
            return Ok(Discovery::cancelled());
        }
        let (result, resources) = scanned?;
        grant.resources = resources;
        Ok(result)
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

    #[cfg(any(target_os = "macos", windows))]
    #[test]
    fn discovery_bounds_results_and_invalidates_the_previous_listing() {
        #[cfg(target_os = "macos")]
        let temp = std::path::PathBuf::from("/private/tmp");
        #[cfg(windows)]
        let temp = std::env::temp_dir();
        let path = temp.join(format!("movroot-discovery-{}", Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        let state = DeviceState::default();
        state.page_ready();
        let ticket = state.begin_picker().unwrap();
        let Selection::Selected { scope } =
            state.finish_picker(ticket, Some(path.clone())).unwrap()
        else {
            panic!("expected scope")
        };
        let key = scope.scope_id.to_string();
        let empty = serde_json::to_value(state.discover(&key, 1).unwrap()).unwrap();
        assert_eq!(empty["status"], "complete");
        assert!(empty["files"].as_array().unwrap().is_empty());
        std::fs::write(path.join("é.txt"), b"sample").unwrap();
        let first = serde_json::to_value(state.discover(&key, 2).unwrap()).unwrap();
        let row = &first["files"][0];
        assert_eq!(row["displayName"], "é.txt");
        assert_eq!(row["sizeBytes"], 6);
        let previous = row["fileId"].as_str().unwrap();
        state.cancel(&key, 3).unwrap();
        assert_eq!(
            serde_json::to_value(state.discover(&key, 3).unwrap()).unwrap()["status"],
            "cancelled"
        );
        assert!(matches!(
            state.discover(&key, 3),
            Err(DeviceError::InvalidRequest)
        ));
        for index in 0..500 {
            std::fs::write(path.join(format!("fixture-{index}.txt")), b"x").unwrap();
        }
        let result = state.discover(&key, 4).unwrap();
        assert!(serde_json::to_vec(&result).unwrap().len() <= 512 * 1024);
        let result = serde_json::to_value(result).unwrap();
        assert_eq!(result["status"], "truncated");
        let files = result["files"].as_array().unwrap();
        assert_eq!(files.len(), 500);
        assert!(files.iter().all(|file| file["fileId"] != previous));
        state.clear(&key).unwrap();
        assert!(matches!(
            state.discover(&key, 5),
            Err(DeviceError::ScopeInactive)
        ));
        std::fs::remove_dir_all(path).unwrap();
    }
}
