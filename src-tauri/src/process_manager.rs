use std::collections::HashMap;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tauri::AppHandle;

use crate::events::{emit_error, emit_stderr, emit_stdout};

pub struct ProcessManager {
    processes: Mutex<HashMap<String, Child>>,
}

impl ProcessManager {
    pub fn new() -> Self {
        Self {
            processes: Mutex::new(HashMap::new()),
        }
    }

    pub async fn spawn(&self, app: AppHandle, id: String, binary: String, args: Vec<String>) -> Result<(), String> {
        let mut command = Command::new(&binary);
        command.args(args);
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());
        command.stdin(Stdio::piped());

        match command.spawn() {
            Ok(mut child) => {
                let stdout = child.stdout.take().expect("Failed to open stdout");
                let stderr = child.stderr.take().expect("Failed to open stderr");
                
                let id_clone = id.clone();
                let app_clone = app.clone();
                tokio::spawn(async move {
                    let mut reader = BufReader::new(stdout).lines();
                    while let Ok(Some(line)) = reader.next_line().await {
                        emit_stdout(&app_clone, &id_clone, line);
                    }
                });

                let id_clone2 = id.clone();
                let app_clone2 = app.clone();
                tokio::spawn(async move {
                    let mut reader = BufReader::new(stderr).lines();
                    while let Ok(Some(line)) = reader.next_line().await {
                        emit_stderr(&app_clone2, &id_clone2, line);
                    }
                });
                
                let mut processes = self.processes.lock().await;
                // We don't keep it in the map if we await it immediately, but we need it in the map for send_stdin/kill.
                // We'll wrap the child's kill/stdin in a way we can extract, or use an Arc<Mutex<Child>>?
                // Actually, tokio's Child can be awaited, taking `&mut self`. 
                // Let's store Child in the map. Wait, we can't easily poll wait() and have it in a map.
                // Better approach for scaffolding: just store it in the map. The frontend will know it's done when stdout closes, or we provide a poll_status command. 
                // For simplicity now, let's keep it in the map. We'll poll its status manually or when kill is called.
                processes.insert(id.clone(), child);
                
                Ok(())
            }
            Err(e) => {
                emit_error(&app, &id, e.to_string());
                Err(e.to_string())
            }
        }
    }
    
    // We need a separate task to wait for the process to exit, but we also want it in the map for stdin/kill.
    // Instead of waiting, we can let it be managed. If we want to know when it exits, we can periodically poll or use a channel.
    // Let's refine this in a moment.

    pub async fn send_stdin(&self, id: &str, input: &str) -> Result<(), String> {
        let mut processes = self.processes.lock().await;
        if let Some(child) = processes.get_mut(id) {
            if let Some(stdin) = child.stdin.as_mut() {
                stdin.write_all(input.as_bytes()).await.map_err(|e| e.to_string())?;
                stdin.flush().await.map_err(|e| e.to_string())?;
                return Ok(());
            }
        }
        Err("Process not found or stdin not available".to_string())
    }

    pub async fn kill(&self, id: &str) -> Result<(), String> {
        let mut processes = self.processes.lock().await;
        if let Some(mut child) = processes.remove(id) {
            child.kill().await.map_err(|e| e.to_string())?;
            return Ok(());
        }
        Err("Process not found".to_string())
    }
}
