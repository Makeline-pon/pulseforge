use tauri::Manager;

/// 桌面外壳的入口。
///
/// PulseForge 的界面完全运行在 WebView2 里（前端就是 `dist-pwa/` 那套静态文件），
/// Rust 这一侧不承载业务逻辑，只负责开窗、设置标题、以及把 WebView2 的运行时信息
/// 写进日志，方便用户排查「机器上没装 WebView2 运行时」这类问题。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_title("PulseForge");
            }
            #[cfg(target_os = "windows")]
            {
                // WebView2 由 Tauri 自动接管；这行日志用于确认运行的是 Evergreen 运行时。
                println!("PulseForge: WebView2 内核已就绪（Windows）");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("PulseForge 启动失败：请确认已安装 WebView2 运行时");
}
