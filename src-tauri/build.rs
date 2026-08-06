fn main() {
    // The window is served from loopback HTTP, which Tauri treats as a remote origin, so the
    // capture commands only become reachable through an explicit app permission.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "start_voice_capture",
            "stop_voice_capture",
            "cancel_voice_capture",
        ]),
    ))
    .expect("failed to run tauri-build")
}
