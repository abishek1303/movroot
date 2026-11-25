use crate::inference::{
    Failure, State,
    credentials::{self, Action},
    transport,
};
use serde::{Deserialize, Serialize};
use tauri::{Manager, WebviewWindow};
use uuid::Uuid;

fn authorize(window: &WebviewWindow) -> Result<(), Failure> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err(Failure::new("accessDenied"))
    }
}

async fn credential<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, Failure> + Send + 'static,
) -> Result<T, Failure> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| Failure::new("credentialStore"))?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    session_id: Uuid,
    source: credentials::Source,
    remaining_dispatches: u8,
}

#[tauri::command]
pub async fn muse_ember_key_status(window: WebviewWindow) -> Result<Status, Failure> {
    authorize(&window)?;
    let binding = window.state::<State>();
    let lease = binding.credential(None)?;
    let source = credential(credentials::resolve).await?.source();
    Ok(Status {
        session_id: lease.session_id(),
        source,
        remaining_dispatches: lease.remaining()?,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KeyRequest {
    session_id: Uuid,
    key: String,
}

#[tauri::command]
pub async fn set_muse_ember_key(window: WebviewWindow, request: KeyRequest) -> Result<(), Failure> {
    authorize(&window)?;
    if !credentials::valid_key(&request.key) {
        return Err(Failure::new("invalidCredential"));
    }
    let binding = window.state::<State>();
    let lease = binding.credential(Some(request.session_id))?;
    credential(move || credentials::access(Action::Save(request.key))).await?;
    lease.remaining().map(|_| ())
}

#[tauri::command]
pub async fn remove_muse_ember_key(window: WebviewWindow, session_id: Uuid) -> Result<(), Failure> {
    authorize(&window)?;
    let binding = window.state::<State>();
    let lease = binding.credential(Some(session_id))?;
    credential(|| credentials::access(Action::Remove)).await?;
    lease.remaining().map(|_| ())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InferenceRequest {
    session_id: Uuid,
    request_id: u32,
    body: String,
}

#[tauri::command]
pub async fn infer_muse_ember(
    window: WebviewWindow,
    request: InferenceRequest,
) -> Result<transport::Reply, Failure> {
    authorize(&window)?;
    let binding = window.state::<State>();
    let (lease, mut cancel) = binding.begin(request.session_id, request.request_id)?;
    let body = transport::validate(&request.body)?;
    let key = credential(credentials::resolve)
        .await?
        .into_key()
        .ok_or_else(|| Failure::new("credentialMissing"))?;
    if !credentials::valid_key(&key) {
        return Err(Failure::new("invalidCredential"));
    }
    let client = window.state::<reqwest::Client>();
    tokio::select! {
        biased;
        _ = &mut cancel => Err(Failure::new("cancelled")),
        reply = async {
            lease.dispatch()?;
            let reply = transport::send(&client, &key, body).await;
            if let Err(failure) = &reply { binding.observe_failure(failure); }
            reply
        } => reply,
    }
}

#[tauri::command]
pub fn cancel_muse_ember_inference(
    window: WebviewWindow,
    session_id: Uuid,
    request_id: u32,
) -> Result<(), Failure> {
    authorize(&window)?;
    window.state::<State>().cancel(session_id, request_id);
    Ok(())
}
