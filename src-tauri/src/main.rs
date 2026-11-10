// Windows 发布版不弹控制台窗口；调试版保留，方便看 panic 信息。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    pulseforge_lib::run()
}
