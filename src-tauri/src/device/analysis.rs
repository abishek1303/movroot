use super::{
    DeviceError, DeviceState, Root,
    discovery::Resource,
    preparation::{self, Coverage, Prepared},
    read,
};
use serde::Serialize;
use std::{
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Notify;
use uuid::Uuid;

pub const MAX_SELECTION: usize = 5;
pub const REVIEW_TIME: Duration = Duration::from_secs(120);
pub const APPROVED_TIME: Duration = Duration::from_secs(300);
pub use super::preparation::{Content, Coverage as AnalysisCoverage};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub plan_id: Uuid,
    items: Vec<Entry>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    file_id: Uuid,
    name: String,
    extension: String,
    #[serde(flatten)]
    outcome: Outcome,
}
#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
enum Outcome {
    Ready {
        format: &'static str,
        coverage: Coverage,
    },
    Excluded {
        error: DeviceError,
    },
}

struct Item {
    resource: Resource,
    prepared: Prepared,
}
pub(super) struct Plan {
    id: Uuid,
    session: Uuid,
    scope: Uuid,
    expires: Instant,
    approval: Approval,
    items: Vec<Item>,
    review: String,
    cancel: Arc<Notify>,
}
enum Approval {
    Pending,
    Reviewing,
    Approved,
}

impl Drop for Plan {
    fn drop(&mut self) {
        self.cancel.notify_one();
    }
}

pub struct Claimed {
    pub prepared: Prepared,
    pub cancel: Arc<Notify>,
    root: Arc<Root>,
    resource: Resource,
}

impl Claimed {
    pub fn verify(&self) -> Result<(), DeviceError> {
        self.root.open_file(&self.resource).map(|_| ())
    }
}

impl DeviceState {
    pub fn prepare_analysis(
        &self,
        scope: &str,
        request: u32,
        session_id: Uuid,
        ids: Vec<Uuid>,
    ) -> Result<Manifest, DeviceError> {
        if ids.is_empty()
            || ids.len() > MAX_SELECTION
            || ids.iter().enumerate().any(|(i, id)| ids[..i].contains(id))
        {
            return Err(DeviceError::InvalidRequest);
        }
        let work = self
            .start(scope, request, None)?
            .ok_or(DeviceError::Cancelled)?;
        let resources = {
            let mut state = self.0.lock().unwrap();
            state.analysis = None;
            state
                .active
                .as_ref()
                .filter(|grant| grant.scope.scope_id == work.operation.scope)
                .map(|grant| {
                    ids.iter()
                        .map(|id| {
                            grant
                                .resources
                                .iter()
                                .find(|resource| resource.id == *id)
                                .cloned()
                        })
                        .collect::<Vec<_>>()
                })
        };
        let result = std::panic::catch_unwind(|| {
            let resources = resources.ok_or(DeviceError::ScopeInactive)?;
            let mut items = Vec::new();
            let mut entries = Vec::new();
            for (id, resource) in ids.into_iter().zip(resources) {
                let start = Instant::now();
                read::check(&work.operation.cancelled, start)?;
                let Some(resource) = resource else {
                    entries.push(Entry {
                        file_id: id,
                        name: "Unavailable file".into(),
                        extension: String::new(),
                        outcome: Outcome::Excluded {
                            error: DeviceError::UnknownFile,
                        },
                    });
                    continue;
                };
                let extension = Path::new(&resource.name)
                    .extension()
                    .map(|value| value.to_str().unwrap_or("�"))
                    .unwrap_or_default()
                    .to_owned();
                let name = resource
                    .name
                    .to_string_lossy()
                    .chars()
                    .take(255)
                    .map(safe_display_char)
                    .collect::<String>();
                let outcome = match read::read(
                    &work.root,
                    &resource,
                    read::MAX_BYTES,
                    &work.operation.cancelled,
                    start,
                )
                .and_then(|bytes| {
                    preparation::prepare(
                        &bytes,
                        &extension.to_ascii_lowercase(),
                        &work.operation.cancelled,
                        start,
                    )
                }) {
                    Ok(prepared) => {
                        let outcome = Outcome::Ready {
                            format: prepared.format,
                            coverage: prepared.coverage,
                        };
                        items.push(Item { resource, prepared });
                        outcome
                    }
                    Err(error) => Outcome::Excluded { error },
                };
                entries.push(Entry {
                    file_id: id,
                    name,
                    extension,
                    outcome,
                });
            }
            Ok::<_, DeviceError>((items, entries))
        })
        .unwrap_or(Err(DeviceError::Unavailable));
        let mut state = self.0.lock().unwrap();
        state.operation = None;
        if state.active.as_ref().map(|grant| grant.scope.scope_id) != Some(work.operation.scope)
            || work
                .operation
                .cancelled
                .load(std::sync::atomic::Ordering::Acquire)
        {
            return Err(DeviceError::Cancelled);
        }
        let (items, entries) = result?;
        let id = Uuid::new_v4();
        let review = entries
            .iter()
            .filter_map(|entry| {
                let Outcome::Ready { coverage, .. } = &entry.outcome else {
                    return None;
                };
                let detail = match coverage {
                    Coverage::Text {
                        source_bytes,
                        covered_bytes,
                        ..
                    } if source_bytes != covered_bytes => {
                        format!("text excerpt ({covered_bytes} of {source_bytes} source bytes)")
                    }
                    Coverage::Text { .. } => "normalized full text".into(),
                    Coverage::Image {
                        transmitted,
                        resized,
                        ..
                    } => format!(
                        "re-encoded{} image, {} × {}",
                        if *resized { " and resized" } else { "" },
                        transmitted[0],
                        transmitted[1]
                    ),
                };
                Some(format!("• {} — {}", entry.name, detail))
            })
            .collect::<Vec<_>>()
            .join("\n");
        if !items.is_empty() {
            state.analysis = Some(Plan {
                id,
                session: session_id,
                scope: work.operation.scope,
                expires: Instant::now() + REVIEW_TIME,
                approval: Approval::Pending,
                items,
                review,
                cancel: Arc::new(Notify::new()),
            });
        }
        Ok(Manifest {
            plan_id: id,
            items: entries,
        })
    }

    pub fn open_review(&self, id: Uuid, session_id: Uuid) -> Result<String, DeviceError> {
        let mut state = self.0.lock().unwrap();
        let plan = state
            .analysis
            .as_mut()
            .filter(|p| {
                p.id == id
                    && p.session == session_id
                    && p.expires > Instant::now()
                    && matches!(p.approval, Approval::Pending)
            })
            .ok_or(DeviceError::PermissionDenied)?;
        plan.approval = Approval::Reviewing;
        Ok(plan.review.clone())
    }

    pub fn finish_review(
        &self,
        id: Uuid,
        session_id: Uuid,
        accepted: bool,
    ) -> Result<bool, DeviceError> {
        let mut state = self.0.lock().unwrap();
        let plan = state
            .analysis
            .as_mut()
            .filter(|p| {
                p.id == id
                    && p.session == session_id
                    && p.expires > Instant::now()
                    && matches!(p.approval, Approval::Reviewing)
            })
            .ok_or(DeviceError::PermissionDenied)?;
        if accepted {
            plan.approval = Approval::Approved;
            plan.expires = Instant::now() + APPROVED_TIME;
        } else {
            state.analysis = None;
        }
        Ok(accepted)
    }

    pub fn discard_analysis(&self, id: Uuid, expired_only: bool) {
        let mut state = self.0.lock().unwrap();
        if state
            .analysis
            .as_ref()
            .is_some_and(|p| p.id == id && (!expired_only || p.expires <= Instant::now()))
        {
            state.analysis = None;
        }
    }

    pub fn claim_analysis(
        &self,
        id: Uuid,
        session_id: Uuid,
        item_id: Uuid,
    ) -> Result<Claimed, DeviceError> {
        let mut state = self.0.lock().unwrap();
        let grant = state.active.as_ref().ok_or(DeviceError::ScopeInactive)?;
        let root = Arc::clone(&grant.root);
        let scope = grant.scope.scope_id;
        let plan = state
            .analysis
            .as_mut()
            .filter(|p| authorized(p, id, session_id, scope))
            .ok_or(DeviceError::PermissionDenied)?;
        let index = plan
            .items
            .iter()
            .position(|item| item.resource.id == item_id)
            .ok_or(DeviceError::PermissionDenied)?;
        let item = plan.items.remove(index);
        Ok(Claimed {
            prepared: item.prepared,
            resource: item.resource,
            root,
            cancel: Arc::clone(&plan.cancel),
        })
    }

    pub fn admit_analysis<T>(
        &self,
        id: Uuid,
        session_id: Uuid,
        dispatch: impl FnOnce() -> T,
    ) -> Result<T, DeviceError> {
        let state = self.0.lock().unwrap();
        let scope = state
            .active
            .as_ref()
            .ok_or(DeviceError::ScopeInactive)?
            .scope
            .scope_id;
        if state
            .analysis
            .as_ref()
            .is_none_or(|p| !authorized(p, id, session_id, scope))
        {
            return Err(DeviceError::PermissionDenied);
        }
        Ok(dispatch())
    }
}

fn authorized(plan: &Plan, id: Uuid, session: Uuid, scope: Uuid) -> bool {
    plan.id == id
        && plan.session == session
        && plan.scope == scope
        && plan.expires > Instant::now()
        && matches!(plan.approval, Approval::Approved)
}

fn safe_display_char(ch: char) -> char {
    if ch.is_control()
        || matches!(ch, '\u{00ad}' | '\u{061c}' | '\u{200b}'..='\u{200f}' | '\u{2028}'..='\u{202f}' | '\u{2060}'..='\u{206f}' | '\u{feff}')
    {
        '�'
    } else {
        ch
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use crate::{device::Selection, inference::file};

    #[test]
    fn fake_send_requires_exact_approved_item_and_current_listing() {
        let path = std::path::Path::new("/private/tmp")
            .join(format!("movroot-analysis-{}", Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        std::fs::write(path.join("local-only-name.txt"), "synthetic receipt").unwrap();
        let state = DeviceState::default();
        state.page_ready();
        let Selection::Selected { scope } = state
            .finish_picker(state.begin_picker().unwrap(), Some(path.clone()))
            .unwrap()
        else {
            panic!("expected scope")
        };
        let scope_id = scope.scope_id.to_string();
        let listing = serde_json::to_value(state.discover(&scope_id, 1).unwrap()).unwrap();
        let file_id = Uuid::parse_str(listing["files"][0]["fileId"].as_str().unwrap()).unwrap();
        let session = Uuid::new_v4();
        let manifest = state
            .prepare_analysis(&scope_id, 2, session, vec![file_id])
            .unwrap();
        let id = manifest.plan_id;
        assert!(state.claim_analysis(id, session, file_id).is_err());
        assert!(state.open_review(id, Uuid::new_v4()).is_err());
        assert!(
            state
                .open_review(id, session)
                .unwrap()
                .contains("local-only-name.txt")
        );
        assert!(state.finish_review(id, session, true).unwrap());
        assert!(state.claim_analysis(id, session, Uuid::new_v4()).is_err());
        let item = state.claim_analysis(id, session, file_id).unwrap();
        item.verify().unwrap();
        let body = file::request(&item.prepared.content, "prepared fixture").unwrap();
        let mut sent = Vec::new();
        state
            .admit_analysis(id, session, || sent.push(body))
            .unwrap();
        assert_eq!(sent.len(), 1);
        let payload: serde_json::Value = serde_json::from_str(&sent[0]).unwrap();
        assert_eq!(
            payload["input"][0]["content"][1]["text"],
            "synthetic receipt"
        );
        assert_eq!(payload["max_output_tokens"], 1024);
        assert_eq!(payload["store"], false);
        assert!(!sent[0].contains("local-only-name"));
        assert!(state.claim_analysis(id, session, file_id).is_err());
        let _ = state.discover(&scope_id, 3).unwrap();
        assert!(
            state
                .admit_analysis(id, session, || panic!("stale plan dispatched"))
                .is_err()
        );
        let refreshed = serde_json::to_value(state.discover(&scope_id, 4).unwrap()).unwrap();
        let file_id = Uuid::parse_str(refreshed["files"][0]["fileId"].as_str().unwrap()).unwrap();
        let declined = state
            .prepare_analysis(&scope_id, 5, session, vec![file_id])
            .unwrap()
            .plan_id;
        state.open_review(declined, session).unwrap();
        assert!(!state.finish_review(declined, session, false).unwrap());
        assert!(state.claim_analysis(declined, session, file_id).is_err());
        let revoked = state
            .prepare_analysis(&scope_id, 6, session, vec![file_id])
            .unwrap()
            .plan_id;
        state.open_review(revoked, session).unwrap();
        assert!(state.finish_review(revoked, session, true).unwrap());
        state.clear(&scope_id).unwrap();
        assert!(
            state
                .admit_analysis(revoked, session, || panic!("cleared plan dispatched"))
                .is_err()
        );
        std::fs::remove_dir_all(path).unwrap();
    }
}
