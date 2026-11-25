use crate::{
    device::{
        DeviceError, DeviceState,
        analysis::{self, AnalysisCoverage},
    },
    inference::{Failure, State, credentials, file, transport},
};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Manager, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogResult};
use uuid::Uuid;

fn authorize(window: &WebviewWindow, session: Uuid) -> Result<(), DeviceError> {
    if window.label() != "main" || !window.state::<State>().matches_session(session) {
        return Err(DeviceError::PermissionDenied);
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrepareRequest {
    session_id: Uuid,
    scope_id: String,
    request_id: u32,
    file_ids: Vec<Uuid>,
}

fn expire(window: WebviewWindow, id: Uuid, delay: std::time::Duration) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(delay).await;
        window.state::<DeviceState>().discard_analysis(id, true);
    });
}

#[tauri::command]
pub async fn prepare_file_analysis(
    window: WebviewWindow,
    request: PrepareRequest,
) -> Result<analysis::Manifest, DeviceError> {
    authorize(&window, request.session_id)?;
    let worker = window.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        worker.state::<DeviceState>().prepare_analysis(
            &request.scope_id,
            request.request_id,
            request.session_id,
            request.file_ids,
        )
    })
    .await
    .map_err(|_| DeviceError::Unavailable)??;
    expire(window, result.plan_id, analysis::REVIEW_TIME);
    Ok(result)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanRequest {
    session_id: Uuid,
    plan_id: Uuid,
}

static REVIEW_OPEN: AtomicBool = AtomicBool::new(false);

struct ReviewSlot;

impl ReviewSlot {
    fn acquire() -> Result<Self, DeviceError> {
        REVIEW_OPEN
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| Self)
            .map_err(|_| DeviceError::Busy)
    }
}

impl Drop for ReviewSlot {
    fn drop(&mut self) {
        REVIEW_OPEN.store(false, Ordering::Release);
    }
}

#[tauri::command]
pub async fn approve_file_analysis(
    window: WebviewWindow,
    request: PlanRequest,
) -> Result<bool, DeviceError> {
    authorize(&window, request.session_id)?;
    let device = window.state::<DeviceState>();
    let slot = ReviewSlot::acquire()?;
    let review = device.open_review(request.plan_id, request.session_id)?;
    let (send, receive) = tokio::sync::oneshot::channel();
    window.dialog().message(format!("Send the following prepared files to Meta Model API ({})? Processing may incur API charges.\n\n{review}", file::CONFIG.model))
        .title("Send files to Meta")
        .parent(&window)
        .buttons(MessageDialogButtons::OkCancelCustom("Send to Meta".into(), "Cancel".into()))
        .show_with_result(move |result| {
            let _slot = slot;
            let accepted = matches!(result, MessageDialogResult::Ok)
                || matches!(result, MessageDialogResult::Custom(ref label) if label == "Send to Meta");
            let _ = send.send(accepted);
        });
    let accepted = tokio::time::timeout(analysis::REVIEW_TIME, receive)
        .await
        .is_ok_and(|r| r.unwrap_or(false));
    authorize(&window, request.session_id)?;
    let approved = device.finish_review(request.plan_id, request.session_id, accepted)?;
    if approved {
        expire(window.clone(), request.plan_id, analysis::APPROVED_TIME);
    }
    Ok(approved)
}

#[tauri::command]
pub fn discard_file_analysis(
    window: WebviewWindow,
    request: PlanRequest,
) -> Result<(), DeviceError> {
    authorize(&window, request.session_id)?;
    window
        .state::<DeviceState>()
        .discard_analysis(request.plan_id, false);
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileRequest {
    session_id: Uuid,
    request_id: u32,
    plan_id: Uuid,
    file_id: Uuid,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileReply {
    dispatched: bool,
    reply: Option<transport::Reply>,
    error: Option<Failure>,
}

#[tauri::command]
pub async fn infer_muse_ember_file(window: WebviewWindow, request: FileRequest) -> FileReply {
    let mut dispatched = false;
    let result = infer(&window, request, &mut dispatched).await;
    match result {
        Ok(reply) => FileReply {
            dispatched,
            reply: Some(reply),
            error: None,
        },
        Err(error) => FileReply {
            dispatched,
            reply: None,
            error: Some(error),
        },
    }
}

fn device_error(error: DeviceError) -> Failure {
    Failure::new(match error {
        DeviceError::Cancelled => "cancelled",
        DeviceError::ScopeInactive => "staleSession",
        DeviceError::ResourceChanged => "resourceChanged",
        _ => "accessDenied",
    })
}

async fn infer(
    window: &WebviewWindow,
    request: FileRequest,
    dispatched: &mut bool,
) -> Result<transport::Reply, Failure> {
    authorize(window, request.session_id).map_err(device_error)?;
    let state = window.state::<State>();
    let (lease, mut cancelled) = state.begin(request.session_id, request.request_id)?;
    let device = window.state::<DeviceState>();
    let item = device
        .claim_analysis(request.plan_id, request.session_id, request.file_id)
        .map_err(device_error)?;
    let revoke = item.cancel.clone();
    let (key, body) = tauri::async_runtime::spawn_blocking(move || {
        let hint = match item.prepared.coverage {
            AnalysisCoverage::Text {
                source_bytes,
                covered_bytes,
                ..
            } if source_bytes != covered_bytes => "The following file content is a text excerpt.",
            AnalysisCoverage::Image { resized: true, .. } => {
                "The following file content is a resized image."
            }
            _ => "The following is the prepared file content.",
        };
        let body = file::request(&item.prepared.content, hint)?;
        let key = credentials::resolve()?
            .into_key()
            .filter(|key| credentials::valid_key(key))
            .ok_or_else(|| Failure::new("credentialMissing"))?;
        item.verify().map_err(device_error)?;
        Ok::<_, Failure>((key, body))
    })
    .await
    .map_err(|_| Failure::new("transportError"))??;
    let client = window.state::<reqwest::Client>();
    tokio::select! {
        biased;
        _ = &mut cancelled => Err(Failure::new("cancelled")),
        _ = revoke.notified() => Err(Failure::new("cancelled")),
        result = async {
            device.admit_analysis(request.plan_id, request.session_id, || lease.dispatch()).map_err(device_error)??;
            *dispatched = true;
            let reply = transport::send(&client, &key, body).await;
            if let Err(error) = &reply { state.observe_failure(error); }
            reply
        } => result,
    }
}
