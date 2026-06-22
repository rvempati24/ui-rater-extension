# UI Rater — Task Tracker Chrome Extension

Chrome extension that tracks user interactions (clicks, scrolls, mouse moves, keyboard input, navigation) on real production websites for the UI task completion study.

## How it works

1. Participant opens the extension popup and enters their Participant ID
2. Extension fetches their assigned tasks from the UI Rater server
3. For each task, the extension shows a prompt (e.g., "Search for flights from SF to Chicago")
4. Clicking "Begin Task" opens the real website and starts tracking interactions
5. The participant completes the task naturally on the real site
6. Clicking "Done" stops tracking and sends all interaction data to the server

## Tracked events

- **click** — element tag, text content, coordinates, href
- **scroll** — scroll position (throttled to 200ms)
- **mousemove** — cursor coordinates (throttled to 100ms)
- **input** — field value changes
- **keydown** — special keys and key combos
- **navigate** — SPA navigation (pushState, replaceState, popstate)
- **pageload** — initial page load URL and title

## Installation (Developer Mode)

1. Open Chrome → `chrome://extensions/`
2. Enable "Developer mode" (top right toggle)
3. Click "Load unpacked" → select this folder
4. The extension icon appears in your toolbar

## Configuration

- **Server URL**: Defaults to `https://ui-rater-production.up.railway.app`
- **Participant ID**: Must match an ID in the server's `data/participants.json`

## Data flow

```
Content Script (tracks DOM events)
  → Background Service Worker (relays to server)
    → UI Rater Server API (/api/complete-task, /api/partial-save)
```

Partial saves happen every 15 seconds during tracking to prevent data loss.
