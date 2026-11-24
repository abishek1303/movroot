fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["select_device_scope", "clear_device_scope"]),
    ))
    .expect("could not build Movroot permissions");
}
