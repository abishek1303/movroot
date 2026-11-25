pub mod credentials;
pub mod file;
pub mod transport;

use serde::Serialize;
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
use tokio::sync::oneshot;
use uuid::Uuid;

const DEFAULT_DISPATCH_LIMIT: u8 = 20;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub code: &'static str,
    pub http_status: Option<u16>,
    pub retry_after_seconds: Option<u32>,
}

impl Failure {
    pub fn new(code: &'static str) -> Self {
        Self {
            code,
            http_status: None,
            retry_after_seconds: None,
        }
    }
}

#[derive(Default)]
struct Session {
    id: Option<Uuid>,
    active: bool,
    requests: u32,
    cancel_next: bool,
    dispatches: u8,
    cooldown: Option<Instant>,
    cancellation: Option<(u32, oneshot::Sender<()>)>,
}

pub struct State(Mutex<Session>, u8);

impl Default for State {
    fn default() -> Self {
        Self::with_limit(DEFAULT_DISPATCH_LIMIT)
    }
}

pub struct Lease<'a> {
    state: &'a State,
    id: Uuid,
}

impl State {
    pub fn with_limit(limit: u8) -> Self {
        Self(Mutex::new(Session::default()), limit.clamp(1, 30))
    }

    pub fn matches_session(&self, id: Uuid) -> bool {
        self.0.lock().unwrap().id == Some(id)
    }

    pub fn observe_failure(&self, failure: &Failure) {
        if failure.code == "rateLimited" {
            let seconds = failure.retry_after_seconds.unwrap_or(30).max(1);
            self.0.lock().unwrap().cooldown =
                Some(Instant::now() + Duration::from_secs(seconds.into()));
        }
    }

    pub fn page_loading(&self) {
        let mut session = self.0.lock().unwrap();
        session.id = None;
        if let Some((_, cancel)) = session.cancellation.take() {
            let _ = cancel.send(());
        }
    }

    pub fn page_ready(&self) {
        let mut session = self.0.lock().unwrap();
        if session.id.is_none() {
            session.id = Some(Uuid::new_v4());
            session.requests = 0;
            session.cancel_next = false;
        }
    }

    pub fn credential(&self, expected: Option<Uuid>) -> Result<Lease<'_>, Failure> {
        let mut session = self.0.lock().unwrap();
        let id = session
            .id
            .filter(|id| expected.is_none_or(|expected| expected == *id))
            .ok_or_else(|| Failure::new("staleSession"))?;
        if session.active {
            return Err(Failure::new("busy"));
        }
        session.active = true;
        Ok(Lease { state: self, id })
    }

    pub fn begin(
        &self,
        id: Uuid,
        request: u32,
    ) -> Result<(Lease<'_>, oneshot::Receiver<()>), Failure> {
        let mut session = self.0.lock().unwrap();
        if session.id != Some(id) {
            return Err(Failure::new("staleSession"));
        }
        if session.requests.checked_add(1) != Some(request) {
            return Err(Failure::new("invalidRequest"));
        }
        session.requests = request;
        if std::mem::take(&mut session.cancel_next) {
            return Err(Failure::new("cancelled"));
        }
        if session.active {
            return Err(Failure::new("busy"));
        }
        if session.dispatches >= self.1 {
            return Err(Failure::new("budgetExceeded"));
        }
        let (send, receive) = oneshot::channel();
        session.active = true;
        session.cancellation = Some((request, send));
        Ok((Lease { state: self, id }, receive))
    }

    pub fn cancel(&self, id: Uuid, request: u32) {
        let mut session = self.0.lock().unwrap();
        if session.id != Some(id) {
            return;
        }
        if session
            .cancellation
            .as_ref()
            .is_some_and(|(active, _)| *active == request)
        {
            if let Some((_, send)) = session.cancellation.take() {
                let _ = send.send(());
            }
        } else if session.requests.checked_add(1) == Some(request) {
            session.cancel_next = true;
        }
    }
}

impl Lease<'_> {
    pub fn session_id(&self) -> Uuid {
        self.id
    }

    pub fn remaining(&self) -> Result<u8, Failure> {
        let session = self.state.0.lock().unwrap();
        if session.id != Some(self.id) {
            return Err(Failure::new("staleSession"));
        }
        Ok(self.state.1 - session.dispatches)
    }

    pub fn dispatch(&self) -> Result<(), Failure> {
        let mut session = self.state.0.lock().unwrap();
        if session.id != Some(self.id) || session.cancellation.is_none() {
            return Err(Failure::new("cancelled"));
        }
        if session.dispatches >= self.state.1 {
            return Err(Failure::new("budgetExceeded"));
        }
        if let Some(remaining) = session
            .cooldown
            .and_then(|until| until.checked_duration_since(Instant::now()))
        {
            let mut failure = Failure::new("rateLimited");
            failure.retry_after_seconds = Some((remaining.as_secs() as u32 + 1).min(3600));
            return Err(failure);
        }
        session.dispatches += 1;
        Ok(())
    }
}

impl Drop for Lease<'_> {
    fn drop(&mut self) {
        let mut session = self.state.0.lock().unwrap();
        session.active = false;
        session.cancellation = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reload_cancels_pending_inference_and_preserves_serialization() {
        let state = State::default();
        state.page_ready();
        let id = state.credential(None).unwrap().session_id();
        let (lease, mut cancel) = state.begin(id, 1).unwrap();
        state.page_loading();
        state.page_ready();
        assert_eq!(cancel.try_recv(), Ok(()));
        assert!(lease.dispatch().is_err());
        assert!(state.credential(None).is_err());
        drop(lease);

        let current = state.credential(None).unwrap();
        assert_ne!(current.session_id(), id);
        assert_eq!(current.remaining().unwrap(), DEFAULT_DISPATCH_LIMIT);
        assert!(state.credential(Some(id)).is_err());
    }

    #[test]
    fn cooldown_survives_reload_without_charging_local_rejections() {
        let state = State::default();
        state.page_ready();
        let mut failure = Failure::new("rateLimited");
        failure.retry_after_seconds = Some(120);
        state.observe_failure(&failure);
        state.page_loading();
        state.page_ready();
        let id = state.credential(None).unwrap().session_id();
        let (lease, _cancel) = state.begin(id, 1).unwrap();
        assert_eq!(lease.dispatch().unwrap_err().code, "rateLimited");
        assert_eq!(lease.remaining().unwrap(), DEFAULT_DISPATCH_LIMIT);
    }

    #[test]
    fn caps_dispatched_work_across_reload_and_rejects_replays() {
        let state = State::default();
        state.page_ready();
        let id = state.credential(None).unwrap().session_id();
        state.cancel(id, 1);
        assert!(matches!(
            state.begin(id, 1),
            Err(Failure {
                code: "cancelled",
                ..
            })
        ));
        assert!(matches!(
            state.begin(id, 1),
            Err(Failure {
                code: "invalidRequest",
                ..
            })
        ));
        for request in 2..=u32::from(DEFAULT_DISPATCH_LIMIT) + 1 {
            let (work, _cancel) = state.begin(id, request).unwrap();
            assert!(state.credential(Some(id)).is_err());
            work.dispatch().unwrap();
        }
        state.page_loading();
        state.page_ready();
        let fresh = state.credential(None).unwrap().session_id();
        assert_ne!(fresh, id);
        assert!(matches!(
            state.begin(fresh, 1),
            Err(Failure {
                code: "budgetExceeded",
                ..
            })
        ));
    }
}
