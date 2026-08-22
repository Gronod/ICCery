use tauri::{AppHandle, Manager, State};
use crate::process_manager::ProcessManager;

#[tauri::command]
pub async fn spawn_process(
    app: AppHandle,
    state: State<'_, ProcessManager>,
    id: String,
    binary: String,
    args: Vec<String>,
) -> Result<(), String> {
    state.spawn(app, id, binary, args).await
}

#[tauri::command]
pub async fn send_stdin(
    state: State<'_, ProcessManager>,
    id: String,
    input: String,
) -> Result<(), String> {
    state.send_stdin(&id, &input).await
}

#[tauri::command]
pub async fn kill_process(
    state: State<'_, ProcessManager>,
    id: String,
) -> Result<(), String> {
    state.kill(&id).await
}

#[tauri::command]
pub async fn resolve_binary(app: AppHandle, binary_name: String) -> Result<String, String> {
    // Resolve sidecar resource path
    let resource_path = app
        .path()
        .resolve(
            format!("argyll/linux-x86_64/{}", binary_name),
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|e| e.to_string())?;

    // In a real app we'd switch based on target_os, but for Milestone 1 scaffolding we'll mock the linux path.
    Ok(resource_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn list_instruments(app: AppHandle, state: State<'_, ProcessManager>) -> Result<(), String> {
    // We would use spawn_process directly with instlist binary and parse JSON output.
    // For scaffolding, this is a placeholder.
    let binary = resolve_binary(app.clone(), "instlist".to_string()).await?;
    state.spawn(app, "instlist".to_string(), binary, vec![]).await
}
