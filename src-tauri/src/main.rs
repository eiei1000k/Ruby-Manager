// リリースビルドの Windows でコンソールウィンドウを出さない
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ruby_manager_lib::run()
}
