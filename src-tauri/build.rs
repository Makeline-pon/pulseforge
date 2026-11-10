fn main() {
    // 读取 tauri.conf.json、生成权限 schema 与 Windows 资源（图标、manifest）。
    tauri_build::build()
}
