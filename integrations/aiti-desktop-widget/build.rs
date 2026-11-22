fn main() {
    // Embed Info.plist into the macOS executable's __TEXT,__info_plist section.
    // A bare `cargo build` binary has no app bundle, and without this section macOS
    // ATS blocks http:// pages entirely (the webview never issues the request).
    // Embedding keeps stdio/exit codes intact for the npm launcher (an .app bundle
    // launched via `open` cannot forward stdin).
    #[cfg(target_os = "macos")]
    {
        let manifest = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR");
        println!("cargo:rustc-link-arg=-sectcreate");
        println!("cargo:rustc-link-arg=__TEXT");
        println!("cargo:rustc-link-arg=__info_plist");
        println!("cargo:rustc-link-arg={manifest}/Info.plist");
        println!("cargo:rerun-if-changed=Info.plist");
    }
    tauri_build::build()
}
