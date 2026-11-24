use crate::device::{DeviceError, DeviceState, Selection};
use serde::Deserialize;
use tauri::{Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClearRequest {
    scope_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SelectRequest {}

#[tauri::command]
pub async fn select_device_scope(
    window: WebviewWindow,
    request: SelectRequest,
) -> Result<Selection, DeviceError> {
    if window.label() != "main" {
        return Err(DeviceError::PermissionDenied);
    }
    let SelectRequest {} = request;
    let app = window.app_handle().clone();
    let ticket = app.state::<DeviceState>().begin_picker()?;
    let worker_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let app = worker_app;
        let path = app
            .dialog()
            .file()
            .set_parent(&window)
            .set_can_create_directories(false)
            .blocking_pick_folder()
            .and_then(|path| path.into_path().ok());
        app.state::<DeviceState>().finish_picker(ticket, path)
    })
    .await;
    result.unwrap_or_else(|_| {
        app.state::<DeviceState>().abandon_picker(ticket);
        Err(DeviceError::Unavailable)
    })
}

#[tauri::command]
pub fn clear_device_scope(window: WebviewWindow, request: ClearRequest) -> Result<(), DeviceError> {
    if window.label() != "main" {
        return Err(DeviceError::PermissionDenied);
    }
    window.state::<DeviceState>().clear(&request.scope_id)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OperationRequest {
    scope_id: String,
    request_id: u32,
}

#[tauri::command]
pub async fn discover_device_files(
    window: WebviewWindow,
    request: OperationRequest,
) -> Result<crate::device::Discovery, DeviceError> {
    if window.label() != "main" {
        return Err(DeviceError::PermissionDenied);
    }
    let Some(work) =
        window
            .state::<DeviceState>()
            .start(&request.scope_id, request.request_id, None)?
    else {
        return Ok(crate::device::Discovery::cancelled());
    };
    tauri::async_runtime::spawn_blocking(move || window.state::<DeviceState>().run_discovery(work))
        .await
        .map_err(|_| DeviceError::Unavailable)?
}

#[tauri::command]
pub fn cancel_device_operation(
    window: WebviewWindow,
    request: OperationRequest,
) -> Result<(), DeviceError> {
    if window.label() != "main" {
        return Err(DeviceError::PermissionDenied);
    }
    window
        .state::<DeviceState>()
        .cancel(&request.scope_id, request.request_id)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadRequest {
    scope_id: String,
    request_id: u32,
    file_id: String,
    mode: crate::device::ReadMode,
    max_bytes: usize,
}

#[tauri::command]
pub async fn read_device_file(
    window: WebviewWindow,
    request: ReadRequest,
) -> Result<tauri::ipc::Response, DeviceError> {
    if window.label() != "main" {
        return Err(DeviceError::PermissionDenied);
    }
    if !(1..=crate::device::MAX_READ_BYTES).contains(&request.max_bytes) {
        return Err(DeviceError::LimitExceeded);
    }
    let work = window
        .state::<DeviceState>()
        .start(
            &request.scope_id,
            request.request_id,
            Some(&request.file_id),
        )?
        .ok_or(DeviceError::Cancelled)?;
    tauri::async_runtime::spawn_blocking(move || {
        window
            .state::<DeviceState>()
            .run_read(work, request.max_bytes, request.mode)
            .map(tauri::ipc::Response::new)
    })
    .await
    .map_err(|_| DeviceError::Unavailable)?
}
