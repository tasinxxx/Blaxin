import { WebSocket } from 'ws';
import { spawn, ChildProcess } from 'child_process';
import { logger } from '../utils/logger.js';
import { defaultShell, defaultCwd } from '../utils/platform.js';

interface TerminalSession {
  id: string;
  process: ChildProcess;
  ws: WebSocket;
  cwd: string;
  startTime: number;
}

const sessions = new Map<string, TerminalSession>();

/**
 * Terminate every live terminal session (used during server shutdown).
 * Each shell is killed by process-group signal so any child processes it
 * started also die — without this, shells survive BLAXIN's exit and keep
 * running as orphans.
 */
export function terminateAllSessions(): void {
  for (const [id, session] of sessions) {
    logger.info('terminal-ws', `Terminating session ${id} (pid ${session.process.pid})`);
    try {
      const pid = session.process.pid;
      if (pid) {
        // Negative PID targets the whole process group (best effort;
        // the shell may not be a group leader if the OS refused it).
        try {
          process.kill(-pid, 'SIGTERM');
        } catch {
          process.kill(pid, 'SIGTERM');
        }
      }
    } catch {}
  }
  sessions.clear();
}

export function handleTerminalWebSocket(ws: WebSocket): void {
  const sessionId = `term_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  
  logger.info('terminal-ws', `New terminal session: ${sessionId}`);

  // Start a shell process (platform-aware: $SHELL//bin/bash on unix,
  // PowerShell/cmd on Windows).
  const shell = defaultShell();
  const cwd = defaultCwd();
  
  const child = spawn(shell, [], {
    cwd,
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const session: TerminalSession = {
    id: sessionId,
    process: child,
    ws,
    cwd,
    startTime: Date.now(),
  };

  sessions.set(sessionId, session);

  // Send session info
  ws.send(JSON.stringify({
    type: 'session-start',
    data: { sessionId, pid: child.pid, cwd, shell },
  }));

  // Pipe stdout to WebSocket
  child.stdout?.on('data', (data: Buffer) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'output',
        data: { stream: 'stdout', content: data.toString('utf-8') },
      }));
    }
  });

  // Pipe stderr to WebSocket
  child.stderr?.on('data', (data: Buffer) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'output',
        data: { stream: 'stderr', content: data.toString('utf-8') },
      }));
    }
  });

  // Handle process exit
  child.on('exit', (code, signal) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'session-end',
        data: { sessionId, code, signal },
      }));
    }
    sessions.delete(sessionId);
    logger.info('terminal-ws', `Session ${sessionId} ended (code: ${code})`);
  });

  child.on('error', (err) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'error',
        data: { message: err.message },
      }));
    }
  });

  // Handle messages from client
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      switch (msg.type) {
        case 'input':
          // Send input to the shell process
          if (child.stdin && !child.stdin.destroyed) {
            child.stdin.write(msg.data.content);
          }
          break;

        case 'resize':
          // Terminal resize (we store it but actual TTY resize needs pty)
          break;

        case 'signal':
          // Send signal to process (e.g., Ctrl+C)
          if (child.pid) {
            try {
              process.kill(child.pid, msg.data.signal || 'SIGINT');
            } catch {}
          }
          break;
      }
    } catch (err) {
      logger.error('terminal-ws', `Message parse error: ${err}`);
    }
  });

  // Handle disconnect
  ws.on('close', () => {
    logger.info('terminal-ws', `Client disconnected from session ${sessionId}`);
    try {
      child.kill('SIGHUP');
    } catch {}
    sessions.delete(sessionId);
  });

  ws.on('error', (err) => {
    logger.error('terminal-ws', `WebSocket error: ${err.message}`);
    try {
      child.kill('SIGHUP');
    } catch {}
    sessions.delete(sessionId);
  });
}
