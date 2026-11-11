// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(any(not(debug_assertions), feature = "test-lab"), windows_subsystem = "windows")]

fn main() {
    nexus_lib::run();
}
