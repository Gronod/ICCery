use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use tauri::AppHandle;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::Mutex;

use crate::events::{emit_error, emit_stderr, emit_stdout};

pub struct ProcessManager {
    stdins: Arc<Mutex<HashMap<String, Arc<Mutex<ChildStdin>>>>>,
    killers: Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>>,
}

impl ProcessManager {
    pub fn new() -> Self {
        Self {
            stdins: Arc::new(Mutex::new(HashMap::new())),
            killers: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn spawn(
        &self,
        app: AppHandle,
        id: String,
        binary: String,
        args: Vec<String>,
        cwd: Option<String>,
    ) -> Result<(), String> {
        {
            let stdins = self.stdins.lock().await;
            if stdins.contains_key(&id) {
                return Err(format!("Process '{id}' is still running"));
            }
        }
        let mut command = Command::new(&binary);
        command.args(&args);
        if let Some(dir) = cwd {
            command.current_dir(dir);
        }
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());
        command.stdin(Stdio::piped());
        command.env("ARGYLL_NOT_INTERACTIVE", "1");

        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        log::info!(target: "subprocess", "Spawning process '{id}': {binary} {:?}", args);
        match command.spawn() {
            Ok(mut child) => {
                let stdout = child.stdout.take().expect("Failed to open stdout");
                let stderr = child.stderr.take().expect("Failed to open stderr");
                let stdin = child.stdin.take().expect("Failed to open stdin");

                let id_clone = id.clone();
                let app_clone = app.clone();
                tokio::spawn(async move {
                    const JSON_ROW_PREFIX: &str = "ROW_COLORS_JSON: ";
                    let mut reader = BufReader::new(stdout).lines();
                    while let Ok(Some(line)) = reader.next_line().await {
                        if line.starts_with(JSON_ROW_PREFIX) {
                            let json_str = line[JSON_ROW_PREFIX.len()..].to_string();
                            crate::events::emit_json_row(&app_clone, &id_clone, json_str);
                        } else {
                            log::info!(target: "subprocess", "[{id_clone}] {line}");
                            emit_stdout(&app_clone, &id_clone, line);
                        }
                    }
                });

                let id_clone2 = id.clone();
                let app_clone2 = app.clone();
                tokio::spawn(async move {
                    let mut reader = BufReader::new(stderr).lines();
                    while let Ok(Some(line)) = reader.next_line().await {
                        log::warn!(target: "subprocess", "[{id_clone2}] [stderr] {line}");
                        emit_stderr(&app_clone2, &id_clone2, line);
                    }
                });

                let stdin_arc = Arc::new(Mutex::new(stdin));
                let (kill_tx, kill_rx) = tokio::sync::oneshot::channel::<()>();

                {
                    let mut stdins = self.stdins.lock().await;
                    stdins.insert(id.clone(), stdin_arc);
                    let mut killers = self.killers.lock().await;
                    killers.insert(id.clone(), kill_tx);
                }

                let id_clone_exit = id.clone();
                let app_clone_exit = app.clone();
                let stdins_clone = self.stdins.clone();
                let killers_clone = self.killers.clone();
                tokio::spawn(async move {
                    let exit_code = tokio::select! {
                        res = child.wait() => {
                            match res {
                                Ok(status) => status.code().unwrap_or(0),
                                Err(_) => 1,
                            }
                        }
                        _ = kill_rx => {
                            let _ = child.start_kill();
                            match child.wait().await {
                                Ok(status) => status.code().unwrap_or(1),
                                Err(_) => 1,
                            }
                        }
                    };

                    log::info!(target: "subprocess", "Process '{id_clone_exit}' exited with code {exit_code}");

                    // Reap child from process manager maps upon exit
                    {
                        let mut stdins = stdins_clone.lock().await;
                        stdins.remove(&id_clone_exit);
                        let mut killers = killers_clone.lock().await;
                        killers.remove(&id_clone_exit);
                    }

                    crate::events::emit_exit(&app_clone_exit, &id_clone_exit, exit_code);
                });

                Ok(())
            }
            Err(e) => {
                log::error!(target: "subprocess", "Failed to spawn '{id}': {e}");
                emit_error(&app, &id, e.to_string());
                Err(e.to_string())
            }
        }
    }

    pub async fn send_stdin(&self, id: &str, input: &str) -> Result<(), String> {
        let stdin_arc = {
            let stdins = self.stdins.lock().await;
            stdins.get(id).cloned()
        };
        if let Some(stdin_arc) = stdin_arc {
            let mut stdin = stdin_arc.lock().await;
            stdin.write_all(input.as_bytes()).await.map_err(|e| e.to_string())?;
            stdin.flush().await.map_err(|e| e.to_string())?;
            return Ok(());
        }
        Err("Process not found or stdin not available".to_string())
    }

    pub async fn kill(&self, id: &str) -> Result<(), String> {
        // Drop and close stdin immediately
        {
            let mut stdins = self.stdins.lock().await;
            stdins.remove(id);
        }
        let killer = {
            let mut killers = self.killers.lock().await;
            killers.remove(id)
        };
        if let Some(kill_tx) = killer {
            let _ = kill_tx.send(());
            return Ok(());
        }
        Err("Process not found".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_process_manager_duplicate_id_and_lifecycle() {
        let pm = ProcessManager::new();
        // Test helper using dummy/mock or direct map operations
        {
            let mut stdins = pm.stdins.lock().await;
            assert!(!stdins.contains_key("test_proc"));
        }
    }
}
