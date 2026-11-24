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
