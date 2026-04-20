// screen.js — BouchHub Agent screen capture & input module
// Dependencies: screenshot-desktop, @nut-tree-fork/nut-js (optional, graceful fallback)

const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

let screenshotDesktop;
let nutTree;

try { screenshotDesktop = require('screenshot-desktop'); } catch (e) {
  console.warn('[Screen] screenshot-desktop not available:', e.message);
}

try { nutTree = require('@nut-tree-fork/nut-js'); } catch (e) {
  console.warn('[Screen] @nut-tree-fork/nut-js not available — input disabled');
}

let streamInterval = null;
let currentMonitor = 0;
let callbackUrl = null;
let agentSecret = null;
let isStreaming = false;

async function getMonitors() {
  if (!screenshotDesktop) return [{ id: 0, name: 'Display 1' }];
  try {
    const displays = await screenshotDesktop.listDisplays();
    return displays.map((d, i) => ({
      id: i,
      name: d.name || `Display ${i + 1}`,
      width: d.width,
      height: d.height,
      primary: d.primary || i === 0,
    }));
  } catch (e) {
    console.warn('[Screen] Could not list displays:', e.message);
    return [{ id: 0, name: 'Display 1', primary: true }];
  }
}

async function captureFrame(monitorIndex) {
  if (!screenshotDesktop) throw new Error('screenshot-desktop not installed');
  try {
    const displays = await screenshotDesktop.listDisplays();
    const display = displays[monitorIndex] || displays[0];
    const imgBuffer = await screenshotDesktop({ screen: display.id, format: 'jpg' });
    return imgBuffer;
  } catch (e) {
    // Fallback: capture all displays
    const imgBuffer = await screenshotDesktop({ format: 'jpg' });
    return imgBuffer;
  }
}

async function startStream(options) {
  if (isStreaming) await stopStream();
  callbackUrl = options.callbackUrl;
  agentSecret = options.agentSecret;
  currentMonitor = options.monitorIndex || 0;
  isStreaming = true;

  const fps = options.fps || 10; // 10fps default — good balance of smoothness vs bandwidth
  const interval = Math.floor(1000 / fps);

  console.log(`[Screen] Starting stream → monitor ${currentMonitor} @ ${fps}fps`);

  const nodeFetch = require('node-fetch');

  streamInterval = setInterval(async () => {
    if (!isStreaming || !callbackUrl) return;
    try {
      const frame = await captureFrame(currentMonitor);
      await nodeFetch(callbackUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'image/jpeg',
          'x-agent-secret': agentSecret,
        },
        body: frame,
        timeout: 2000,
      });
    } catch (e) {
      // 410 Gone means hub session closed — stop streaming
      if (e.message && e.message.includes('410')) {
        console.log('[Screen] Hub session gone — stopping stream');
        stopStream();
      }
    }
  }, interval);

  return { success: true };
}

async function stopStream() {
  isStreaming = false;
  if (streamInterval) { clearInterval(streamInterval); streamInterval = null; }
  callbackUrl = null;
  console.log('[Screen] Stream stopped');
}

async function handleInput(data) {
  if (!nutTree) return { error: 'Input control not available' };
  const { mouse, keyboard } = nutTree;

  try {
    if (data.type === 'mousemove') {
      await mouse.setPosition({ x: Math.round(data.x), y: Math.round(data.y) });
    } else if (data.type === 'mousedown') {
      const btn = data.button === 2 ? nutTree.Button.RIGHT : nutTree.Button.LEFT;
      await mouse.pressButton(btn);
    } else if (data.type === 'mouseup') {
      const btn = data.button === 2 ? nutTree.Button.RIGHT : nutTree.Button.LEFT;
      await mouse.releaseButton(btn);
    } else if (data.type === 'click') {
      const btn = data.button === 2 ? nutTree.Button.RIGHT : nutTree.Button.LEFT;
      await mouse.click(btn);
    } else if (data.type === 'scroll') {
      await mouse.scrollDown(data.deltaY > 0 ? 3 : -3);
    } else if (data.type === 'keydown') {
      const key = mapKey(data.key);
      if (key) await keyboard.pressKey(key);
    } else if (data.type === 'keyup') {
      const key = mapKey(data.key);
      if (key) await keyboard.releaseKey(key);
    } else if (data.type === 'type') {
      await keyboard.type(data.text);
    }
    return { success: true };
  } catch (e) {
    console.warn('[Screen] Input error:', e.message);
    return { error: e.message };
  }
}

function mapKey(keyName) {
  if (!nutTree) return null;
  const { Key } = nutTree;
  const map = {
    'Enter': Key.Return, 'Backspace': Key.Backspace, 'Tab': Key.Tab,
    'Escape': Key.Escape, 'Delete': Key.Delete, 'ArrowLeft': Key.Left,
    'ArrowRight': Key.Right, 'ArrowUp': Key.Up, 'ArrowDown': Key.Down,
    'Home': Key.Home, 'End': Key.End, 'PageUp': Key.PageUp,
    'PageDown': Key.PageDown, 'Control': Key.LeftControl,
    'Shift': Key.LeftShift, 'Alt': Key.LeftAlt, 'Meta': Key.LeftSuper,
    'F1': Key.F1, 'F2': Key.F2, 'F3': Key.F3, 'F4': Key.F4,
    'F5': Key.F5, 'F6': Key.F6, 'F7': Key.F7, 'F8': Key.F8,
    'F9': Key.F9, 'F10': Key.F10, 'F11': Key.F11, 'F12': Key.F12,
    ' ': Key.Space,
  };
  if (map[keyName]) return map[keyName];
  if (keyName.length === 1) {
    const k = Key[keyName.toUpperCase()];
    return k || null;
  }
  return null;
}

module.exports = { getMonitors, startStream, stopStream, handleInput };

