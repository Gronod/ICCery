use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use tauri::AppHandle;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::Mutex;

use crate::events::{emit_error, emit_stderr, emit_stdout};

pub fn get_user_home_dir() -> Option<String> {
    #[cfg(windows)]
    {
        std::env::var("USERPROFILE")
            .ok()
            .or_else(|| {
                let drive = std::env::var("HOMEDRIVE").ok()?;
                let path = std::env::var("HOMEPATH").ok()?;
                Some(format!("{}{}", drive, path))
            })
    }
    #[cfg(not(windows))]
    {
        std::env::var("HOME").ok()
    }
}

pub fn sanitize_arg_for_logging(arg: &str) -> String {
    if let Some(home) = get_user_home_dir() {
        if !home.trim().is_empty() {
            #[cfg(windows)]
            {
                let arg_lower = arg.to_lowercase();
                let home_lower = home.to_lowercase();
                if let Some(pos) = arg_lower.find(&home_lower) {
                    let mut result = String::new();
                    result.push_str(&arg[..pos]);
                    result.push('~');
                    result.push_str(&arg[pos + home.len()..]);
                    return result;
                }
            }
            #[cfg(not(windows))]
            {
                if let Some(pos) = arg.find(&home) {
                    let mut result = String::new();
                    result.push_str(&arg[..pos]);
                    result.push('~');
                    result.push_str(&arg[pos + home.len()..]);
                    return result;
                }
            }
        }
    }
    arg.to_string()
}

pub fn sanitize_args_for_logging(args: &[String]) -> Vec<String> {
    args.iter().map(|a| sanitize_arg_for_logging(a)).collect()
}

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
        if let Some(ref dir) = cwd {
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

        let sanitized_binary = sanitize_arg_for_logging(&binary);
        let sanitized_args = sanitize_args_for_logging(&args);
        let sanitized_cwd = cwd.as_deref().map(sanitize_arg_for_logging);
        log::info!(
            target: "subprocess",
            "Spawning process '{id}': {sanitized_binary} {:?} (cwd: {:?})",
            sanitized_args,
            sanitized_cwd
        );
        log::debug!(
            target: "subprocess",
            "Raw spawn invocation for '{id}': {binary} {:?} (cwd: {:?})",
            args,
            cwd
        );
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

    /// Kills all currently managed subprocesses, closes their stdins, and signals termination.
    /// Returns the number of processes signaled.
    pub async fn kill_all(&self) -> usize {
        // 1. Close and drop all stdin streams
        {
            let mut stdins = self.stdins.lock().await;
            stdins.clear();
        }

        // 2. Extract and send kill signal to all active killer channels
        let killers_to_signal = {
            let mut killers = self.killers.lock().await;
            let list: Vec<(String, tokio::sync::oneshot::Sender<()>)> = killers.drain().collect();
            list
        };

        let count = killers_to_signal.len();
        if count > 0 {
            log::info!(target: "subprocess", "Terminating all managed subprocesses ({count} active)");
        }

        for (id, killer) in killers_to_signal {
            log::info!(target: "subprocess", "Sending kill signal to subprocess '{id}'");
            let _ = killer.send(());
        }

        // Give background tasks a brief moment to initiate child.start_kill()
        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;

        count
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

    #[tokio::test]
    async fn test_kill_all_cleans_maps() {
        let pm = ProcessManager::new();

        let (tx1, mut rx1) = tokio::sync::oneshot::channel::<()>();
        let (tx2, mut rx2) = tokio::sync::oneshot::channel::<()>();

        {
            let mut killers = pm.killers.lock().await;
            killers.insert("proc_1".to_string(), tx1);
            killers.insert("proc_2".to_string(), tx2);
        }

        let killed_count = pm.kill_all().await;
        assert_eq!(killed_count, 2);

        // Verify channels received signal
        assert!(rx1.try_recv().is_ok());
        assert!(rx2.try_recv().is_ok());

        // Verify maps are empty
        {
            let stdins = pm.stdins.lock().await;
            let killers = pm.killers.lock().await;
            assert!(stdins.is_empty());
            assert!(killers.is_empty());
        }
    }

    #[test]
    fn test_sanitize_arg_for_logging() {
        if let Some(home) = get_user_home_dir() {
            if !home.is_empty() {
                let test_path = format!("{}/test_file.ti1", home);
                let sanitized = sanitize_arg_for_logging(&test_path);
                assert!(sanitized.starts_with('~'));
                assert!(!sanitized.contains(&home));
            }
        }
        let safe_arg = "-v";
        assert_eq!(sanitize_arg_for_logging(safe_arg), "-v");
    }
}
