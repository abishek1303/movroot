fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "select_device_scope",
            "clear_device_scope",
            "discover_device_files",
            "cancel_device_operation",
            "read_device_file",
            "muse_ember_key_status",
            "set_muse_ember_key",
            "remove_muse_ember_key",
            "infer_muse_ember",
            "prepare_file_analysis",
            "approve_file_analysis",
            "discard_file_analysis",
            "infer_muse_ember_file",
            "cancel_muse_ember_inference",
        ]),
    ))
    .expect("could not build Movroot permissions");
}
