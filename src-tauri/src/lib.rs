mod commands;
mod device;

use tauri::{
    Manager, WebviewWindowBuilder,
    webview::PageLoadEvent,
    webview::{NewWindowResponse, Url},
};

fn allows_navigation(url: &Url, allowed_origin: &Url) -> bool {
    url.scheme() == allowed_origin.scheme()
        && url.host_str() == allowed_origin.host_str()
        && url.port_or_known_default() == allowed_origin.port_or_known_default()
        && url.username().is_empty()
        && url.password().is_none()
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(device::DeviceState::default())
        .invoke_handler(tauri::generate_handler![
            commands::device::select_device_scope,
            commands::device::clear_device_scope,
            commands::device::discover_device_files,
            commands::device::cancel_device_operation,
            commands::device::read_device_file
        ])
        .setup(|app| {
            let config = app.config();
            let window = &config.app.windows[0];
            let origin = if cfg!(dev) {
                config.build.dev_url.clone().expect("missing Vite URL")
            } else if cfg!(target_os = "windows") {
                Url::parse("http://tauri.localhost")?
            } else {
                Url::parse("tauri://localhost")?
            };
            let navigation_owner = app.handle().clone();
            WebviewWindowBuilder::from_config(app, window)?
                .on_navigation(move |url| {
                    let allowed = allows_navigation(url, &origin);
                    if allowed {
                        navigation_owner
                            .state::<device::DeviceState>()
                            .page_loading();
                    }
                    allowed
                })
                .on_page_load(|window, payload| {
                    let state = window.state::<device::DeviceState>();
                    match payload.event() {
                        PageLoadEvent::Started => state.page_loading(),
                        PageLoadEvent::Finished => state.page_ready(),
                    }
                })
                .on_new_window(|_, _| NewWindowResponse::Deny)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("could not run Movroot");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn navigation_requires_the_configured_origin() {
        for origin in [
            "tauri://localhost",
            "http://tauri.localhost",
            "http://127.0.0.1:5173",
        ] {
            let allowed = Url::parse(origin).unwrap();
            assert!(allows_navigation(
                &allowed.join("/index.html").unwrap(),
                &allowed
            ));
            for external in [
                "https://example.invalid",
                "file:///tmp/test.html",
                "http://127.0.0.1:5174",
                "http://tauri.localhost.example.invalid",
                "tauri://localhost:5173",
            ] {
                assert!(!allows_navigation(&Url::parse(external).unwrap(), &allowed));
            }
        }
    }
}
